const express = require("express");

const pool = require("./db");

const { rateLimit } = require("express-rate-limit");

const cors = require("cors");

const { randomUUID, createHash } = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: [
    "http://localhost:5173",
    "https://koya-clinic-web.onrender.com"
  ],
  methods: ["GET", "POST"],
  allowedHeaders: [
    "Content-Type",
    "Idempotency-Key",
    "X-API-Key"
  ]
}));



app.use(express.json());


const publicBookingLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    error: "Too many booking requests. Please try again later."
  }
});

app.use("/public/bookings", publicBookingLimiter);

app.use((req, res, next) => {
  const publicSlots =
    req.method === "GET" && req.path === "/public/slots";

  const publicBooking =
    req.method === "POST" && req.path === "/public/bookings";

  if (publicSlots || publicBooking) {
    return next();
  }

  const providedKey = req.header("X-API-Key");

  if (!process.env.API_KEY || providedKey !== process.env.API_KEY) {
    return res.status(401).json({
      error: "Unauthorized"
    });
  }

  next();
});


app.get("/", (req, res) => {
  res.json({
    message: "Koya Clinic Booking API is running!"
  });
});



app.get("/test-db", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");

    res.json({
      message: "Database connected successfully!",
      database_time: result.rows[0].now,
    });
  } catch (error) {
    console.error("Database connection error:", error.message);

    res.status(500).json({
      error: "Database connection failed",
    });
  }
});


app.get("/public/slots", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         s.id,
         s.provider_id,
         s.start_time,
         s.end_time
       FROM slots s
       WHERE s.start_time > NOW()
         AND NOT EXISTS (
           SELECT 1
           FROM bookings b
           WHERE b.slot_id = s.id
             AND b.status = 'confirmed'
         )
       ORDER BY s.start_time ASC, s.id ASC`
    );

    return res.json({
      slots: result.rows
    });
  } catch (error) {
    console.error("Public slots error:", error.message);

    return res.status(500).json({
      error: "Failed to retrieve appointments"
    });
  }
});


app.get("/slots", async (req, res) => {
  try {
    const provider = req.query.provider;

    const result = await pool.query(
      `SELECT
         s.id,
         s.provider_id AS provider,
         s.start_time AS start,
         s.end_time AS "end",
         NOT EXISTS (
           SELECT 1
           FROM bookings b
           WHERE b.slot_id = s.id
             AND b.status = 'confirmed'
         ) AS available
       FROM slots s
       WHERE ($1::text IS NULL OR s.provider_id = $1)
       ORDER BY s.start_time ASC, s.id ASC`,
      [provider ?? null]
    );

    return res.status(200).json({
      slots: result.rows
    });

  } catch (error) {
    console.error("Error fetching slots:", error.message);

    return res.status(500).json({
      error: "Failed to retrieve slots"
    });
  }
});


app.post("/reset", async (req, res) => {
  const { slots } = req.body || {};

  if (!Array.isArray(slots)) {
    return res.status(400).json({
      error: "slots must be an array"
    });
  }

  const seenIds = new Set();

  for (const slot of slots) {
    if (
      !slot ||
      typeof slot.id !== "string" ||
      !slot.id.trim() ||
      typeof slot.provider !== "string" ||
      !slot.provider.trim() ||
      typeof slot.start !== "string" ||
      typeof slot.end !== "string"
    ) {
      return res.status(400).json({
        error: "Invalid slot details"
      });
    }

    const start = new Date(slot.start);
    const end = new Date(slot.end);

    if (
      Number.isNaN(start.getTime()) ||
      Number.isNaN(end.getTime()) ||
      end <= start
    ) {
      return res.status(400).json({
        error: "Invalid appointment times"
      });
    }

    const cleanId = slot.id.trim();

    if (seenIds.has(cleanId)) {
      return res.status(400).json({
        error: "Duplicate slot ID"
      });
    }

    seenIds.add(cleanId);
  }

  let client;

  try {
    client = await pool.connect();
    await client.query("BEGIN");

    await client.query("DELETE FROM booking_idempotency");
    await client.query("DELETE FROM booking_attempts");
    await client.query("DELETE FROM bookings");
    await client.query("DELETE FROM slots");

    for (const slot of slots) {
      await client.query(
        `INSERT INTO slots
         (id, provider_id, start_time, end_time)
         VALUES ($1, $2, $3, $4)`,
        [
          slot.id.trim(),
          slot.provider.trim(),
          slot.start,
          slot.end
        ]
      );
    }

    await client.query("COMMIT");

    return res.status(200).json({
      message: "Slots reset successfully"
    });

  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("Rollback error:", rollbackError.message);
      }
    }

    console.error("Reset error:", error.message);

    return res.status(500).json({
      error: "Failed to reset slots"
    });

  } finally {
    if (client) {
      client.release();
    }
  }
});




async function checkBookingRateLimit(email) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Serialize attempts for the same email.
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 1))",
      [email]
    );

    // Remove expired attempts for this email.
    await client.query(
      `DELETE FROM booking_attempts
       WHERE patient_email = $1
         AND attempted_at <= NOW() - INTERVAL '60 seconds'`,
      [email]
    );

    const result = await client.query(
      `SELECT COUNT(*)::integer AS attempts,
              MIN(attempted_at) AS oldest_attempt
       FROM booking_attempts
       WHERE patient_email = $1`,
      [email]
    );

    if (result.rows[0].attempts >= 5) {
      const oldest = new Date(
        result.rows[0].oldest_attempt
      ).getTime();

      const retryAfter = Math.max(
        1,
        Math.ceil((oldest + 60000 - Date.now()) / 1000)
      );

      await client.query("COMMIT");

      return {
        allowed: false,
        retryAfter
      };
    }

    await client.query(
      `INSERT INTO booking_attempts (patient_email)
       VALUES ($1)`,
      [email]
    );

    await client.query("COMMIT");

    return { allowed: true };

  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error(
        "Rate-limit rollback error:",
        rollbackError.message
      );
    }

    throw error;

  } finally {
    client.release();
  }
}

function formatBooking(booking) {
  return {
    id: booking.id,
    slot_id: booking.slot_id,
    name: booking.patient_name,
    email: booking.patient_email,
    status: booking.status,
    created_at: booking.created_at
  };
}



async function createBooking(req, res) {
  const { slot_id, name, email } = req.body || {};

  const cleanEmail =
    typeof email === "string" ? email.trim().toLowerCase() : "";

  // Count attempts with a usable email, even when other
  // booking details are invalid.
  if (cleanEmail) {
    try {
      const limitResult = await checkBookingRateLimit(cleanEmail);

      if (!limitResult.allowed) {
        res.set("Retry-After", String(limitResult.retryAfter));

        return res.status(429).json({
          error: "Too many booking attempts. Please try again later."
        });
      }
    } catch (error) {
      console.error("Rate limit error:", error.message);

      return res.status(500).json({
        error: "Failed to check booking rate limit"
      });
    }
  }

  if (
    typeof slot_id !== "string" ||
    !slot_id.trim() ||
    typeof name !== "string" ||
    !name.trim() ||
    typeof email !== "string" ||
    !email.trim()
  ) {
    return res.status(400).json({
      error: "Missing or invalid booking details"
    });
  }

  const cleanSlotId = slot_id.trim();
  const cleanName = name.trim();

  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (!emailPattern.test(cleanEmail)) {
    return res.status(400).json({
      error: "Invalid email address"
    });
  }

  const idempotencyKey = req.header("Idempotency-Key");

  const requestHash = createHash("sha256")
    .update(JSON.stringify({
      slot_id: cleanSlotId,
      name: cleanName,
      email: cleanEmail
    }))
    .digest("hex");

  let client;

  try {
    client = await pool.connect();
    await client.query("BEGIN");

    if (idempotencyKey) {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [idempotencyKey]
      );

      const previous = await client.query(
        `SELECT i.request_hash, b.*
         FROM booking_idempotency i
         JOIN bookings b ON b.id = i.booking_id
         WHERE i.key = $1`,
        [idempotencyKey]
      );

      if (previous.rows.length > 0) {
        const original = previous.rows[0];

        await client.query("COMMIT");

        if (original.request_hash !== requestHash) {
          return res.status(422).json({
            error: "Idempotency key used with different booking details"
          });
        }

        return res.status(201).json(formatBooking(original));
      }
    }

    const slotResult = await client.query(
      "SELECT id, start_time FROM slots WHERE id = $1",
      [cleanSlotId]
    );

    if (slotResult.rows.length === 0) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        error: "Slot not found"
      });
    }

    const slot = slotResult.rows[0];

    if (new Date(slot.start_time).getTime() <= Date.now()) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        error: "Cannot book an appointment that has already started"
      });
    }

    const bookingId = randomUUID();

    const result = await client.query(
      `INSERT INTO bookings
       (id, slot_id, patient_name, patient_email)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [bookingId, cleanSlotId, cleanName, cleanEmail]
    );

    if (idempotencyKey) {
      await client.query(
        `INSERT INTO booking_idempotency
         (key, request_hash, booking_id)
         VALUES ($1, $2, $3)`,
        [idempotencyKey, requestHash, bookingId]
      );
    }

    await client.query("COMMIT");

    return res.status(201).json(formatBooking(result.rows[0]));

  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("Rollback error:", rollbackError.message);
      }
    }

    if (error.code === "23505") {
      return res.status(409).json({
        error: "Slot already booked"
      });
    }

    console.error("Booking error:", error.message);

    return res.status(500).json({
      error: "Failed to create booking"
    });

  } finally {
    if (client) {
      client.release();
    }
  }
}
app.post("/bookings", createBooking);

app.post("/public/bookings", createBooking);



app.get("/bookings", async (req, res) => {
  try {
    const email = req.query.email;

    if (typeof email !== "string" || !email.trim()) {
      return res.status(400).json({
        error: "email is required"
      });
    }

    const cleanEmail = email.trim().toLowerCase();
    const limitText = req.query.limit ?? "10";
    const cursor = req.query.cursor;

    if (typeof limitText !== "string" || !/^\d+$/.test(limitText)) {
      return res.status(400).json({
        error: "limit must be a whole number between 1 and 50"
      });
    }

    const limit = Number(limitText);

    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      return res.status(400).json({
        error: "limit must be a whole number between 1 and 50"
      });
    }

    let cursorDate = null;
    let cursorId = null;

    if (cursor !== undefined) {
      try {
        if (typeof cursor !== "string" || !cursor) {
          throw new Error("Invalid cursor");
        }

        const decoded = JSON.parse(
          Buffer.from(cursor, "base64url").toString("utf8")
        );

        if (
          !decoded ||
          typeof decoded.created_at !== "string" ||
          Number.isNaN(Date.parse(decoded.created_at)) ||
          typeof decoded.id !== "string" ||
          !decoded.id
        ) {
          throw new Error("Invalid cursor");
        }

        cursorDate = decoded.created_at;
        cursorId = decoded.id;
      } catch {
        return res.status(400).json({
          error: "Invalid cursor"
        });
      }
    }

    const result = await pool.query(
      `SELECT *
       FROM bookings
       WHERE LOWER(patient_email) = $1
         AND (
           $2::timestamptz IS NULL
           OR (date_trunc('milliseconds', created_at), id) >
            ($2::timestamptz, $3::text)
         )
       ORDER BY created_at ASC, id ASC
       LIMIT $4`,
      [cleanEmail, cursorDate, cursorId, limit + 1]
    );

    const hasMore = result.rows.length > limit;
    const bookings = result.rows
      .slice(0, limit)
      .map(formatBooking);

    let next_cursor = null;

    if (hasMore && bookings.length > 0) {
      const lastBooking = bookings[bookings.length - 1];

      next_cursor = Buffer.from(
        JSON.stringify({
          created_at: lastBooking.created_at,
          id: lastBooking.id
        })
      ).toString("base64url");
    }

    return res.status(200).json({
      bookings,
      next_cursor
    });

  } catch (error) {
    console.error("Pagination error:", error.message);

    return res.status(500).json({
      error: "Failed to retrieve bookings"
    });
  }
});



app.get("/bookings/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      "SELECT * FROM bookings WHERE id = $1",
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "Booking not found"
      });
    }

    return res.status(200).json(
      formatBooking(result.rows[0])
    );

  } catch (error) {
    console.error("Error fetching booking:", error.message);

    return res.status(500).json({
      error: "Failed to retrieve booking"
    });
  }
});



app.delete("/bookings/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `UPDATE bookings
       SET status = 'cancelled'
       WHERE id = $1 AND status = 'confirmed'
       RETURNING *`,
      [id]
    );

    if (result.rows.length > 0) {
      return res.status(200).json(
        formatBooking(result.rows[0])
      );
    }

    const existing = await pool.query(
      "SELECT status FROM bookings WHERE id = $1",
      [id]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({
        error: "Booking not found"
      });
    }

    return res.status(409).json({
      error: "Booking already cancelled"
    });

  } catch (error) {
    console.error("Cancellation error:", error.message);

    return res.status(500).json({
      error: "Failed to cancel booking"
    });
  }
});


app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});