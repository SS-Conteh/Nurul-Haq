const mongoose = require("mongoose");

async function connectDB() {
  
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error(
      "[NHIA-SMS] MONGO_URI is not set",
    );
    process.exit(1);
  }
  const start = Date.now();
  try {
    await mongoose.connect(uri, {
      family: 4,
      serverSelectionTimeoutMS: 8000,
    });
    console.log(
      `[NHIA-SMS] MongoDB connected -> ${mongoose.connection.host}/${mongoose.connection.name} (${Date.now() - start}ms)`,
    );
  } catch (err) {
    console.error(
      `[NHIA-SMS] MongoDB connection error after ${Date.now() - start}ms:`,
      err.message,
    );
    process.exit(1);
  }
}

module.exports = connectDB;
