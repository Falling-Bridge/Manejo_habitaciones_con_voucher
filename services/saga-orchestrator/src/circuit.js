const CircuitBreaker = require("opossum");

/**
 * Circuit Breaker + Bulkhead + Timeout sobre la dependencia frágil (Pagos).
 * - timeout: 1200 ms
 * - errorThresholdPercentage: 50 %
 * - resetTimeout: 8000 ms
 * - volumeThreshold: 3 (mínimo de llamadas para abrir)
 * - Bulkhead: maxConcurrent = 3; si hay más, falla rápido (rechazo).
 */
function buildPaymentCircuit(axiosCall) {
  let inFlight = 0;
  const MAX_CONCURRENT = 3;

  const wrapped = async (...args) => {
    if (inFlight >= MAX_CONCURRENT) {
      const err = new Error("bulkhead_rejected");
      err.code = "BULKHEAD";
      throw err;
    }
    inFlight++;
    try {
      return await axiosCall(...args);
    } finally {
      inFlight--;
    }
  };

  const breaker = new CircuitBreaker(wrapped, {
    timeout: 1200,
    errorThresholdPercentage: 50,
    resetTimeout: 8000,
    volumeThreshold: 3,
    rollingCountTimeout: 10000,
  });

  // Fallback: degradación elegante
  breaker.fallback((...args) => {
    const err = new Error("payment_unavailable_fallback");
    err.code = "FALLBACK";
    err.args = args;
    throw err;
  });

  return breaker;
}

module.exports = { buildPaymentCircuit };