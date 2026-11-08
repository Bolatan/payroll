// Local development only. Vercel uses api/index.js.
const app = require('./api/index.js');
app.listen(process.env.PORT || 3000, () => console.log('http://localhost:' + (process.env.PORT || 3000)));
