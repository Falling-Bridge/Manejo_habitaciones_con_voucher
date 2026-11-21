const { createProxyMiddleware } = require("http-proxy-middleware");

// Enrutamiento: solo el gateway expone; servicios internos no.
function buildProxies() {
  return {
    "/bff": createProxyMiddleware({
      target: process.env.BFF_URL,
      changeOrigin: true,
      pathRewrite: { "^/bff": "" },
    }),
    "/saga": createProxyMiddleware({
      target: process.env.SAGA_URL,
      changeOrigin: true,
      pathRewrite: { "^/saga": "" },
    }),
    "/habitaciones": createProxyMiddleware({
      target: process.env.HABITACIONES_URL,
      changeOrigin: true,
      pathRewrite: { "^/habitaciones": "" },
    }),
    "/pagos": createProxyMiddleware({
      target: process.env.PAGOS_URL,
      changeOrigin: true,
      pathRewrite: { "^/pagos": "" },
    }),
    "/confirmacion": createProxyMiddleware({
      target: process.env.CONFIRMACION_URL,
      changeOrigin: true,
      pathRewrite: { "^/confirmacion": "" },
    }),
  };
}

module.exports = { buildProxies };