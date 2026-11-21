const express = require("express");
const jwt = require("jsonwebtoken");
const axios = require("axios");
const { authMiddleware } = require("./auth");
const { limiter } = require("./rateLimit");
const { buildProxies } = require("./proxy");

const app = express();
app.use(express.json());

// Health público
app.get("/health", (_req, res) => res.json({ status: "ok", service: "gateway" }));

// Endpoint de emisión de token
app.post("/auth/token", (req, res) => {
  const { user, role } = req.body || {};
  if (!user) return res.status(400).json({ error: "user required" });
  const token = jwt.sign({ sub: user, role: role || "guest" }, process.env.JWT_SECRET, {
    expiresIn: "1h",
  });
  res.json({ token });
});

// Autenticación central + rate limiting
app.use(authMiddleware);
app.use(limiter);

// Interceptamos la ruta de la saga con Axios para evitar el bloqueo de http-proxy-middleware en Windows
app.use("/saga", async (req, res) => {
  try {
    const url = `${process.env.SAGA_URL}${req.originalUrl}`;
    const response = await axios({
      method: req.method,
      url: url,
      data: req.body,
      headers: {
        "x-user-id": req.headers["x-user-id"],
        "Content-Type": "application/json"
      },
      timeout: 10000 // 10 segundos de margen
    });
    res.status(response.status).json(response.data);
  } catch (error) {
    if (error.response) {
      res.status(error.response.status).json(error.response.data);
    } else {
      res.status(500).json({ error: "gateway error connecting to saga", detail: error.message });
    }
  }
});

// El resto de rutas (BFF, Habitaciones, etc.) siguen usando el proxy normal
const proxies = buildProxies();
Object.entries(proxies).forEach(([path, proxy]) => {
  if (path !== "/saga") { // Evitamos duplicar /saga
    app.use(path, proxy);
  }
});

app.use((_req, res) => res.status(404).json({ error: "not found" }));

const PORT = 8080;
app.listen(PORT, () => console.log(`[gateway] listening on ${PORT}`));