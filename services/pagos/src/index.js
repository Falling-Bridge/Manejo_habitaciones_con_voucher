const express = require("express");
const Database = require("better-sqlite3");

const db = new Database(process.env.DB_PATH || "/data/pagos.db");
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    reservation_ref TEXT NOT NULL,
    amount REAL NOT NULL,
    status TEXT NOT NULL,        -- CHARGED | REFUNDED
    idempotency_key TEXT UNIQUE,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

const app = express();
app.use(express.json());

const findByKey = db.prepare(`SELECT * FROM payments WHERE idempotency_key = ?`);
const insert = db.prepare(`
  INSERT INTO payments (id, reservation_ref, amount, status, idempotency_key)
  VALUES (?, ?, ?, 'CHARGED', ?)
`);
const findById = db.prepare(`SELECT * FROM payments WHERE id=?`);
const refund = db.prepare(`UPDATE payments SET status='REFUNDED' WHERE id=? AND status='CHARGED'`);

app.get("/health", (_req, res) => res.json({ status: "ok", service: "pagos" }));

// COBRO (idempotente)
app.post("/charges", async (req, res) => {
  const { idempotencyKey, reservationRef, amount, simulate } = req.body;
  if (!idempotencyKey || !reservationRef || amount == null)
    return res.status(400).json({ error: "missing fields" });

  // Simulación de falla de la pasarela externa:
  // simulate=slow  -> 5s de espera
  // simulate=down  -> 503 inmediato
  if (simulate === "slow") await new Promise((r) => setTimeout(r, 5000));
  if (simulate === "down") return res.status(503).json({ error: "gateway down" });

  const existing = findByKey.get(idempotencyKey);
  if (existing) return res.json({ paymentId: existing.id, idempotent: true });

  const id = `pay-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    insert.run(id, reservationRef, amount, idempotencyKey);
    res.status(201).json({ paymentId: id, amount });
  } catch (e) {
    const again = findByKey.get(idempotencyKey);
    if (again) return res.json({ paymentId: again.id, idempotent: true });
    res.status(500).json({ error: e.message });
  }
});

// COMPENSACIÓN: reembolso (idempotente)
app.post("/charges/:id/refund", (req, res) => {
  const p = findById.get(req.params.id);
  if (!p) return res.status(404).json({ error: "not found" });
  refund.run(req.params.id);
  res.json({ paymentId: req.params.id, status: "REFUNDED", idempotent: p.status === "REFUNDED" });
});

app.get("/payments/:id", (req, res) => {
  const p = findById.get(req.params.id);
  if (!p) return res.status(404).json({ error: "not found" });
  res.json(p);
});

app.listen(3002, () => console.log("[pagos] listening on 3002"));