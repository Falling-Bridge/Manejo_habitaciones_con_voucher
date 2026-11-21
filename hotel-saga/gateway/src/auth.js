const jwt = require("jsonwebtoken");

const PUBLIC_PATHS = ["/auth/token", "/health"];

function authMiddleware(req, res, next) {
  if (PUBLIC_PATHS.some((p) => req.path.startsWith(p))) return next();

  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "missing token" });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload;
    // Los servicios internos confían en este header (ya autenticado)
    req.headers["x-user-id"] = payload.sub;
    req.headers["x-user-role"] = payload.role;
    next();
  } catch (e) {
    return res.status(401).json({ error: "invalid token" });
  }
}

module.exports = { authMiddleware };