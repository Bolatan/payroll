// Vercel entry point. If the app fails to start, report why instead of a bare 500.
let app, startupError;
try { app = require('../lib/app'); } catch (e) { startupError = e; console.error('Startup failed:', e); }

module.exports = (req, res) => {
  if (startupError) {
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ error: 'The server failed to start.', detail: startupError.message }));
  }
  return app(req, res);
};
