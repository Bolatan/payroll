const mongoose = require('mongoose');
const cached = global._mongo || (global._mongo = { conn: null, promise: null });

module.exports = async function connect() {
  if (cached.conn) return cached.conn;
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set');
  cached.promise ||= mongoose.connect(process.env.MONGODB_URI, { bufferCommands: false });
  cached.conn = await cached.promise;
  return cached.conn;
};
