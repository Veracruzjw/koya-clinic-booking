const express = require("express");

const pool = require("./db");

const { rateLimit } = require("express-rate-limit");

const cors = require("cors");

const { randomUUID, createHash } = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;


app.use(
  cors({
    origin: "https://koya-clinic-web.onrender.com",
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Idempotency-Key"],
  })
);


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
    const providerId = req.query.provider_id;

    const result = await pool.query(
      `SELECT
         s.id,
         s.provider_id,
         s.start_time,
         s.end_time,
         NOT EXISTS (
           SELECT 1
           FROM bookings b
           WHERE b.slot_id = s.id
             AND b.status = 'confirmed'
         ) AS available
       FROM slots s
       WHERE ($1::text IS NULL OR s.provider_id = $1)
       ORDER BY s.start_time ASC, s.id ASC`,
      [providerId ?? null]
    );

    return res.json({
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
      typeof slot.provider_id !== "string" ||
      !slot.provider_id.trim() ||
      typeof slot.start_time !== "string" ||
      typeof slot.end_time !== "string"
    ) {
      return res.status(400).json({
        error: "Invalid slot details"
      });
    }

    const start = new Date(slot.start_time);
    const end = new Date(slot.end_time);

    if (
      Number.isNaN(start.getTime()) ||
      Number.isNaN(end.getTime()) ||
      end <= start
    ) {
      return res.status(400).json({
        error: "Invalid appointment times"
      });
    }

    if (seenIds.has(slot.id)) {
      return res.status(400).json({
        error: "Duplicate slot ID"
      });
    }

    seenIds.add(slot.id);
  }

  let client;

  try {
    client = await pool.connect();
    await client.query("BEGIN");

    await client.query("DELETE FROM booking_idempotency");
    await client.query("DELETE FROM bookings");
    await client.query("DELETE FROM slots");

    for (const slot of slots) {
      await client.query(
        `INSERT INTO slots
         (id, provider_id, start_time, end_time)
         VALUES ($1, $2, $3, $4)`,
        [
          slot.id.trim(),
          slot.provider_id.trim(),
          slot.start_time,
          slot.end_time
        ]
      );
    }

    await client.query("COMMIT");

    return res.json({
      message: "Slots reset successfully"
    });

  } catch (error) {
    if (client) {
      await client.query("ROLLBACK");
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


async function createBooking(req, res) {
  const { slot_id, patient_name, patient_email } = req.body || {};

  if (
    typeof slot_id !== "string" ||
    !slot_id.trim() ||
    typeof patient_name !== "string" ||
    !patient_name.trim() ||
    typeof patient_email !== "string" ||
    !patient_email.trim()
  ) {
    return res.status(400).json({
      error: "Missing or invalid booking details"
    });
  }

  const cleanSlotId = slot_id.trim();
  const cleanName = patient_name.trim();
  const cleanEmail = patient_email.trim().toLowerCase();

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
      patient_name: cleanName,
      patient_email: cleanEmail
    }))
    .digest("hex");

  let client;

  try {
    
    const rateLimit = await checkBookingRateLimit(cleanEmail);

    if (!rateLimit.allowed) {
        res.set("Retry-After", String(rateLimit.retryAfter));

        return res.status(429).json({
            error: "Too many booking attempts. Please try again later."
        });
        }

    client = await pool.connect();
    await client.query("BEGIN");

    if (idempotencyKey) {

      // Lock this key so simultaneous retries cannot race.
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

        const { request_hash, ...booking } = original;

        return res.status(200).json({ booking });
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

    return res.status(201).json({
      booking: result.rows[0]
    });

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

app.post("/public/bookings", createBooking);


app.get("/bookings", async (req, res) => {
  try {
    const limitText = req.query.limit ?? "10";
    const cursor = req.query.cursor;

    // Allow only whole numbers between 1 and 50.
    if (!/^\d+$/.test(limitText)) {
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
       WHERE (
         $1::timestamptz IS NULL
         OR (created_at, id) > ($1::timestamptz, $2::text)
       )
       ORDER BY created_at ASC, id ASC
       LIMIT $3`,
      [cursorDate, cursorId, limit + 1]
    );

    const hasMore = result.rows.length > limit;
    const bookings = result.rows.slice(0, limit);

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

    return res.json({
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

    res.json({
      booking: result.rows[0]
    });

  } catch (error) {
    console.error("Error fetching booking:", error.message);

    res.status(500).json({
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

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "Confirmed booking not found"
      });
    }

    res.json({
      booking: result.rows[0]
    });

  } catch (error) {
    console.error("Cancellation error:", error.message);

    res.status(500).json({
      error: "Failed to cancel booking"
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});