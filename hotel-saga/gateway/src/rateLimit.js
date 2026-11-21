const rateLimit = require("express-rate-limit");

// Rate limiting por cliente (IP/identificador). Protege de picos.
const limiter = rateLimit({
  windowMs: 10 * 1000,       // ventana de 10s
  max: 20,                    // 20 req / 10s por cliente
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.sub || req.ip,
  handler: (req, res) =>
    res.status(429).json({ error: "rate limit exceeded", retryAfter: "10s" }),
});

module.exports = { limiter };