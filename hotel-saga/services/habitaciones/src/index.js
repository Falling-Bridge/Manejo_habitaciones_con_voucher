const express = require("express");
const Database = require("better-sqlite3");

const db = new Database(process.env.DB_PATH || "/data/habitaciones.db");
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS reservations (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    from_date TEXT NOT NULL,
    to_date TEXT NOT NULL,
    status TEXT NOT NULL,        -- RESERVED | RELEASED
    idempotency_key TEXT UNIQUE,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL
  );
`);

// Seed mínimo
const seed = db.prepare("INSERT OR IGNORE INTO rooms (id, name) VALUES (?, ?)");
["101", "102", "201"].forEach((id) => seed.run(id, `Habitación ${id}`));

const app = express();
app.use(express.json());

const overlap = db.prepare(`
  SELECT 1 FROM reservations
  WHERE room_id = ? AND status = 'RESERVED'
    AND NOT (to_date <= ? OR from_date >= ?)
  LIMIT 1
`);

const insertRes = db.prepare(`
  INSERT INTO reservations (id, room_id, from_date, to_date, status, idempotency_key)
  VALUES (?, ?, ?, ?, 'RESERVED', ?)
`);

const findByKey = db.prepare(`SELECT * FROM reservations WHERE idempotency_key = ?`);
const findById = db.prepare(`SELECT * FROM reservations WHERE id = ?`);
const release = db.prepare(`UPDATE reservations SET status='RELEASED' WHERE id=? AND status='RESERVED'`);

app.get("/health", (_req, res) => res.json({ status: "ok", service: "habitaciones" }));

app.get("/rooms/:id", (req, res) => {
  const room = db.prepare("SELECT * FROM rooms WHERE id=?").get(req.params.id);
  if (!room) return res.status(404).json({ error: "room not found" });
  res.json(room);
});

// RESERVAR (idempotente por idempotency_key)
app.post("/reservations", (req, res) => {
  const { idempotencyKey, roomId, from, to } = req.body;
  if (!idempotencyKey || !roomId || !from || !to)
    return res.status(400).json({ error: "missing fields" });

  const existing = findByKey.get(idempotencyKey);
  if (existing) return res.json({ reservationId: existing.id, idempotent: true });

  if (overlap.get(roomId, from, to))
    return res.status(409).json({ error: "room already reserved for those dates" });

  const id = `res-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    insertRes.run(id, roomId, from, to, idempotencyKey);
    res.status(201).json({ reservationId: id });
  } catch (e) {
    // Conflicto de unicidad: tratar como idempotente
    const again = findByKey.get(idempotencyKey);
    if (again) return res.json({ reservationId: again.id, idempotent: true });
    res.status(500).json({ error: e.message });
  }
});

// COMPENSACIÓN: liberar (idempotente)
app.post("/reservations/:id/release", (req, res) => {
  const r = findById.get(req.params.id);
  if (!r) return res.status(404).json({ error: "not found" });
  release.run(req.params.id);
  res.json({ reservationId: req.params.id, status: "RELEASED", idempotent: r.status === "RELEASED" });
});

app.listen(3001, () => console.log("[habitaciones] listening on 3001"));