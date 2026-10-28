// Customers and employees must never see SQL errors, SAP internals or stack traces.
// Any 5xx response is replaced by a short, safe message plus a reference code.
// The original text is printed to THIS console (the server log) with the same reference.
module.exports = function safeErrors(req, res, next) {
  const original = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode >= 500 && body && typeof body === 'object') {
      const ref = Math.random().toString(36).slice(2, 8).toUpperCase();
      let detail = '';
      try { detail = JSON.stringify(body).slice(0, 600); } catch (_) { detail = String(body); }
      console.error('[' + ref + '] ' + req.method + ' ' + req.originalUrl + ' -> ' + res.statusCode + ' ' + detail);
      const msg = (res.statusCode === 502 || res.statusCode === 503)
        ? 'This service is temporarily unavailable. Please try again in a few minutes.'
        : 'Something went wrong on our side. Please try again, and contact support if it keeps happening.';
      return original({ error: msg, ref });
    }
    return original(body);
  };
  next();
};