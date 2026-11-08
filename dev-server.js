// Local development only (npm run dev). Vercel does not use this file; it serves api/index.js.
const app = require('./lib/app');
const port = process.env.PORT || 3000;
app.listen(port, () => console.log('http://localhost:' + port));
