const express = require("express");
const axios = require("axios");
const { buildPaymentCircuit } = require("./circuit");

const app = express();
app.use(express.json());

const H = process.env.HABITACIONES_URL;
const P = process.env.PAGOS_URL;
const C = process.env.CONFIRMACION_URL;

// ---- Circuit Breaker sobre Pagos (dependencia frágil) ----
const payClient = (payload) =>
  axios.post(`${P}/charges`, payload, {
    timeout: 1200,
    headers: { "x-user-id": payload.userId || "system" },
  }).then((r) => r.data);

const paymentBreaker = buildPaymentCircuit(payClient);

paymentBreaker.on("open", () => console.log("[CB] OPEN"));
paymentBreaker.on("halfOpen", () => console.log("[CB] HALF_OPEN"));
paymentBreaker.on("close", () => console.log("[CB] CLOSED"));
paymentBreaker.on("reject", () => console.log("[CB] REJECT (bulkhead)"));

// ---- Helpers de llamadas a otros servicios ----
const http = axios.create({ timeout: 1500 });

const reservarHabitacion = (body) =>
  http.post(`${H}/reservations`, body).then((r) => r.data);
const liberarHabitacion = (id) =>
  http.post(`${H}/reservations/${id}/release`).then((r) => r.data);
const confirmar = (body) =>
  http.post(`${C}/confirmations`, body).then((r) => r.data);
const anularConfirmacion = (id) =>
  http.post(`${C}/confirmations/${id}/cancel`).then((r) => r.data);
const reembolsar = (id) =>
  http.post(`${P}/charges/${id}/refund`).then((r) => r.data);

// ---- Endpoint: estado del circuito (evidencia) ----
app.get("/saga/circuit", (_req, res) => {
  res.json({
    state: paymentBreaker.opened ? "OPEN" : paymentBreaker.halfOpen ? "HALF_OPEN" : "CLOSED",
    stats: paymentBreaker.stats,
  });
});

// ---- Operación central: RESERVAR (Saga orquestada) ----
app.post("/saga/reservar", async (req, res) => {
  const { roomId, from, to, amount, userId, simulatePayment } = req.body;
  if (!roomId || !from || !to || amount == null)
    return res.status(400).json({ error: "missing fields" });

  const sagaId = `saga-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const trace = [];
  const compensations = []; // pila: { name, fn }

  const log = (step, status, extra = {}) => {
    trace.push({ step, status, at: new Date().toISOString(), ...extra });
    console.log(`[saga ${sagaId}] ${step} -> ${status}`, extra);
  };

  try {
    // -------- Paso 1: Reservar habitación --------
    log("reservar_habitacion", "START");
    const hab = await reservarHabitacion({
      idempotencyKey: `${sagaId}-hab`,
      roomId, from, to,
    });
    log("reservar_habitacion", "OK", hab);
    compensations.push({
      name: "liberar_habitacion",
      fn: () => liberarHabitacion(hab.reservationId),
    });

    // -------- Paso 2: Cobrar garantía (dependencia frágil) --------
    log("cobrar_garantia", "START");
    let pago;
    try {
      pago = await paymentBreaker.fire({
        idempotencyKey: `${sagaId}-pay`,
        reservationRef: hab.reservationId,
        amount,
        userId,
        simulate: simulatePayment, // slow | down | undefined
      });
      log("cobrar_garantia", "OK", pago);
    } catch (e) {
      // Fallback / circuit open / bulkhead / timeout
      log("cobrar_garantia", "FAIL", { code: e.code || e.message });
      throw new Error(`payment_failed:${e.code || e.message}`);
    }

    compensations.push({
      name: "reembolsar",
      fn: () => reembolsar(pago.paymentId),
    });

    // -------- Paso 3: Emitir confirmación --------
    log("emitir_confirmacion", "START");
    const conf = await confirmar({
      idempotencyKey: `${sagaId}-conf`,
      reservationRef: hab.reservationId,
      roomId,
      simulate: req.body.simulateConfirmation, // "fail" para forzar fallo
    });
    log("emitir_confirmacion", "OK", conf);

    // Éxito
    return res.json({
      sagaId,
      status: "COMPLETED",
      reservationId: hab.reservationId,
      paymentId: pago.paymentId,
      confirmationId: conf.confirmationId,
      voucher: conf.voucher,
      trace,
    });
  } catch (err) {
    // -------- Compensación en orden inverso --------
    log("saga", "FAILED", { error: err.message });
    const compensated = [];
    while (compensations.length) {
      const c = compensations.pop();
      try {
        const r = await c.fn();
        log(`compensate:${c.name}`, "OK", r);
        compensated.push({ name: c.name, status: "OK" });
      } catch (e) {
        log(`compensate:${c.name}`, "FAIL", { error: e.message });
        compensated.push({ name: c.name, status: "FAIL", error: e.message });
      }
    }
    return res.status(500).json({
      sagaId,
      status: "COMPENSATED",
      error: err.message,
      compensated,
      trace,
    });
  }
});

app.get("/health", (_req, res) => res.json({ status: "ok", service: "saga-orchestrator" }));

app.listen(3004, () => console.log("[saga-orchestrator] listening on 3004"));