const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const H = process.env.HABITACIONES_URL;
const P = process.env.PAGOS_URL;
const C = process.env.CONFIRMACION_URL;
const S = process.env.SAGA_URL;

const TIMEOUT = 1500;

// BFF: agrega datos de >=2 servicios en una sola respuesta por cliente.
// GET /dashboard?roomId=101&from=...&to=...
app.get("/dashboard", async (req, res) => {
  const { roomId, from, to, paymentId } = req.query;
  const headers = { "x-user-id": req.headers["x-user-id"] };

  const [habitacion, pago, confirmacion] = await Promise.allSettled([
    axios.get(`${H}/rooms/${roomId}`, { timeout: TIMEOUT, headers }),
    paymentId
      ? axios.get(`${P}/payments/${paymentId}`, { timeout: TIMEOUT, headers })
      : Promise.resolve({ data: { status: "none" } }),
    axios.get(`${C}/confirmations/by-room/${roomId}`, { timeout: TIMEOUT, headers }),
  ]);

  const pick = (r, fallback) => (r.status === "fulfilled" ? r.value.data : fallback);

  res.json({
    roomId,
    from,
    to,
    habitacion: pick(habitacion, { error: "unavailable" }),
    pago: pick(pago, { error: "unavailable" }),
    confirmacion: pick(confirmacion, { error: "unavailable" }),
    generatedAt: new Date().toISOString(),
    client: "web",
  });
});

// Proxy de la operación central (para que el cliente web hable con una sola API)
app.post("/reservar", async (req, res) => {
  try {
    const { data } = await axios.post(`${S}/saga/reservar`, req.body, {
      timeout: 5000,
      headers: { "x-user-id": req.headers["x-user-id"] },
    });
    res.json(data);
  } catch (e) {
    res.status(e.response?.status || 500).json({
      error: "saga failed",
      detail: e.response?.data || e.message,
    });
  }
});

app.get("/health", (_req, res) => res.json({ status: "ok", service: "bff" }));

app.listen(8090, () => console.log("[bff] listening on 8090"));