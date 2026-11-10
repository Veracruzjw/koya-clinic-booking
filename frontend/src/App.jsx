
import { useEffect, useState } from "react";

function App() {
  const [slots, setSlots] = useState([]);
  const [selectedSlot, setSelectedSlot] = useState("");
  const [patientName, setPatientName] = useState("");
  const [patientEmail, setPatientEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    async function loadSlots() {
      try {
        const response = await fetch(
          `${import.meta.env.VITE_API_URL}/public/slots`
        );

        if (!response.ok) {
          throw new Error("Unable to load appointments");
        }

        const data = await response.json();
        setSlots(data.slots);
      } catch (error) {
        setMessage(error.message);
      }
    }

    loadSlots();
  }, []);

  async function handleBooking(event) {
    event.preventDefault();

    if (!selectedSlot) {
      setMessage("Please select an appointment.");
      return;
    }

    setLoading(true);
    setMessage("");

    try {
      const response = await fetch(
        `${import.meta.env.VITE_API_URL}/public/bookings`,
        {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          slot_id: selectedSlot,
          patient_name: patientName,
          patient_email: patientEmail,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Booking failed");
      }

      setMessage("Appointment booked successfully!");
      setSlots((previousSlots) =>
        previousSlots.map((slot) =>
          slot.id === selectedSlot
            ? { ...slot, available: false }
            : slot
        )
      );
      setSelectedSlot("");
      setPatientName("");
      setPatientEmail("");
    } catch (error) {
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 px-5 py-8 text-slate-800">
      <header className="mx-auto mb-12 flex max-w-5xl items-center gap-3">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-700 text-3xl text-white">
          +
        </div>

        <div>
          <h2 className="text-xl font-bold text-emerald-950">
            Koya Clinic
          </h2>
          <p className="text-sm text-slate-500">
            Appointment Booking
          </p>
        </div>
      </header>

      <main className="mx-auto max-w-2xl rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-10">
        <h1 className="text-3xl font-bold text-emerald-950">
          Book an appointment
        </h1>

        <p className="mt-3 text-slate-500">
          Choose an appointment time and enter your details.
        </p>

        <section className="mt-9">
          <h3 className="mb-4 text-lg font-semibold">
            Available appointments
          </h3>

          <div className="grid gap-3 sm:grid-cols-2">
            {!slots.some(
              (slot) =>
                new Date(slot.start_time).getTime() > Date.now()
            ) && (
              <p className="text-sm text-slate-500">
                No appointments available.
              </p>
            )}

            {slots.filter((slot) =>
              new Date(slot.start_time).getTime() > Date.now()
            )
            .map((slot) => (
              <button
                key={slot.id}
                type="button"
                onClick={() => setSelectedSlot(slot.id)}
                className={`flex flex-col gap-2 rounded-xl border p-4 text-left transition ${
                  selectedSlot === slot.id
                    ? "border-emerald-700 bg-emerald-50 ring-1 ring-emerald-700"
                    : "border-slate-200 bg-slate-50 hover:border-emerald-400"
                }`}
              >
                <span className="font-semibold text-emerald-950">
                  {slot.provider_id}
                </span>

                <span className="text-sm text-slate-500">
                  {new Date(slot.start_time).toLocaleString()}
                </span>
              </button>
            ))}
          </div>
        </section>

        <form onSubmit={handleBooking} className="mt-8 space-y-5">
          <div>
            <label
              htmlFor="name"
              className="mb-2 block text-sm font-semibold"
            >
              Full name
            </label>

            <input
              id="name"
              type="text"
              required
              placeholder="Enter your full name"
              value={patientName}
              onChange={(event) => setPatientName(event.target.value)}
              className="w-full rounded-lg border border-slate-300 px-4 py-3 outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100"
            />
          </div>

          <div>
            <label
              htmlFor="email"
              className="mb-2 block text-sm font-semibold"
            >
              Email address
            </label>

            <input
              id="email"
              type="email"
              required
              placeholder="you@example.com"
              value={patientEmail}
              onChange={(event) => setPatientEmail(event.target.value)}
              className="w-full rounded-lg border border-slate-300 px-4 py-3 outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-emerald-700 px-5 py-4 font-semibold text-white transition hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? "Booking..." : "Confirm booking"}
          </button>
        </form>

        {message && (
          <p
            role="status"
            className="mt-5 rounded-lg bg-emerald-50 p-4 text-sm text-emerald-900"
          >
            {message}
          </p>
        )}
      </main>
    </div>
  );
}

export default App;
