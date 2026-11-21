const express = require("express");
const Database = require("better-sqlite3");

const db = new Database(process.env.DB_PATH || "/data/confirmacion.db");
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS confirmations (
    id TEXT PRIMARY KEY,
    reservation_ref TEXT NOT NULL,
    room_id TEXT,
    voucher TEXT,
    status TEXT NOT NULL,       -- CONFIRMED | CANCELLED
    idempotency_key TEXT UNIQUE,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

const app = express();
app.use(express.json());

const findByKey = db.prepare(`SELECT * FROM confirmations WHERE idempotency_key = ?`);
const insert = db.prepare(`
  INSERT INTO confirmations (id, reservation_ref, room_id, voucher, status, idempotency_key)
  VALUES (?, ?, ?, ?, 'CONFIRMED', ?)
`);
const findById = db.prepare(`SELECT * FROM confirmations WHERE id=?`);
const cancel = db.prepare(`UPDATE confirmations SET status='CANCELLED' WHERE id=? AND status='CONFIRMED'`);
const findByRoom = db.prepare(`SELECT * FROM confirmations WHERE room_id=? ORDER BY created_at DESC LIMIT 1`);

app.get("/health", (_req, res) => res.json({ status: "ok", service: "confirmacion" }));

// CONFIRMAR (idempotente). simulate=fail fuerza el fallo del último paso.
app.post("/confirmations", (req, res) => {
  const { idempotencyKey, reservationRef, roomId, simulate } = req.body;
  if (!idempotencyKey || !reservationRef)
    return res.status(400).json({ error: "missing fields" });

  if (simulate === "fail")
    return res.status(500).json({ error: "confirmation service forced failure" });

  const existing = findByKey.get(idempotencyKey);
  if (existing) return res.json({ confirmationId: existing.id, idempotent: true });

  const id = `conf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const voucher = `VCH-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
  try {
    insert.run(id, reservationRef, roomId || null, voucher, idempotencyKey);
    res.status(201).json({ confirmationId: id, voucher });
  } catch (e) {
    const again = findByKey.get(idempotencyKey);
    if (again) return res.json({ confirmationId: again.id, idempotent: true });
    res.status(500).json({ error: e.message });
  }
});

// COMPENSACIÓN: anular (idempotente)
app.post("/confirmations/:id/cancel", (req, res) => {
  const c = findById.get(req.params.id);
  if (!c) return res.status(404).json({ error: "not found" });
  cancel.run(req.params.id);
  res.json({ confirmationId: req.params.id, status: "CANCELLED", idempotent: c.status === "CANCELLED" });
});

app.get("/confirmations/by-room/:roomId", (req, res) => {
  const c = findByRoom.get(req.params.roomId);
  if (!c) return res.status(404).json({ error: "not found" });
  res.json(c);
});

app.listen(3003, () => console.log("[confirmacion] listening on 3003"));