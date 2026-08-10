const mongoose = require("mongoose");
mongoose.set("strictQuery", true);
require("dotenv").config();

const mongoOptions = {
  authSource: "admin",
  maxPoolSize: 10,
  minPoolSize: 2,
  serverSelectionTimeoutMS: 15000,
  connectTimeoutMS: 15000,
  socketTimeoutMS: 45000,
  retryWrites: true,
};

async function connect() {
  try {
    await mongoose.connect(process.env.URL_CONNECT_MONGODB, mongoOptions);
    console.info("connect database db_bacarat success");
  } catch (error) {
    console.error("MongoDB connection error:", error.message);
  }
}

mongoose.connection.on("disconnected", () => {
  console.error("MongoDB disconnected — reconnect on next operation");
});

module.exports = { connect };
