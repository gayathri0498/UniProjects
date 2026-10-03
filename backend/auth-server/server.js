// backend/auth-server/server.js

const path = require("path");
// Load the ROOT .env
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });

const express = require("express");
const cors = require("cors");
const { MongoClient } = require("mongodb");

// Import the whole Kafka module
const kafkaLib = require("./lib/kafka");

const app = express();
const PORT = Number(process.env.PORT) || 5000;

// Basic validation
if (!process.env.MONGO_URI) {
  console.error("MONGO_URI not set. Add it to your root .env");
  process.exit(1);
}

// Middleware
app.use(
  cors({
    origin: [/^http:\/\/(localhost|127\.0\.0\.1):\d+$/],
    credentials: false,
  })
);
app.use(express.json());

// MongoDB Connection
const client = new MongoClient(process.env.MONGO_URI);

client
  .connect()
  .then(async () => {
    const db = client.db("epidemics");

    // Users, Patients, Cases, Alerts, Config
    const usersCollection    = db.collection("users");
    const patientsCollection = db.collection("patients");
    const casesCollection    = db.collection("cases");
    const alertsCollection   = db.collection("alerts");
    const configCollection   = db.collection("config");

    // Expose on app.locals for routes
    app.locals.usersCollection    = usersCollection;
    app.locals.patientsCollection = patientsCollection;
    app.locals.casesCollection    = casesCollection;
    app.locals.alertsCollection   = alertsCollection;
    app.locals.configCollection   = configCollection;

    // Helpful indexes (idempotent)
    try {
      await Promise.all([
        usersCollection.createIndex({ username: 1 }, { unique: true }).catch(() => {}),
        usersCollection.createIndex({ role: 1, status: 1 }).catch(() => {}),
        patientsCollection.createIndex({ hospitalId: 1, diagnosisDate: -1 }).catch(() => {}),
        casesCollection.createIndex({ disease: 1, district: 1, date: 1 }, { unique: true }).catch(() => {}),
        alertsCollection.createIndex({ disease: 1, district: 1, date: 1 }, { unique: true }).catch(() => {}),
        alertsCollection.createIndex({ createdAt: -1 }).catch(() => {}),
        configCollection.createIndex({ disease: 1 }, { unique: true }).catch(() => {}),
      ]);
    } catch (e) {
      console.warn("Index creation warning:", e?.message || e);
    }

    //Kafka Producer
    try {
      await kafkaLib.startProducer();
      app.locals.kafkaProducer = kafkaLib.getProducer();
      app.locals.kafkaTopic    = process.env.KAFKA_TOPIC || "disease.cases";
      try {
        await kafkaLib.ensureTopic(app.locals.kafkaTopic, 1, 1);
      } catch (te) {
        console.warn("Topic ensure warning:", te?.message || te);
      }

      console.log("Kafka producer ready -> topic:", app.locals.kafkaTopic);
    } catch (e) {
      console.error("Kafka producer failed to start:", e?.message || e);
      app.locals.kafkaProducer = null;
    }

    console.log("Connected to MongoDB");

    // Healthcheck
    app.get("/healthz", (req, res) =>
      res.status(200).json({
        ok: true,
        kafka: !!req.app.locals.kafkaProducer,
        topic: req.app.locals.kafkaTopic || null,
      })
    );

    //Routes
    const authRoutes     = require("./routes/auth");      // /api/register, /api/login,
    const patientRoutes  = require("./routes/patients");  // /api/patients
    const alertsRoutes   = require("./routes/alerts");    // /api/alerts (GET)
    const configRoutes   = require("./routes/config");    // /api/config (GET/POST)
    const hospitalsRoutes = require("./routes/hospitals"); //users/hospitals listings & stats

    app.use("/api", authRoutes);
    app.use("/api/patients", patientRoutes);
    app.use("/api/alerts", alertsRoutes);
    app.use("/api/config", configRoutes);

    // Mount after locals are set
    app.use("/api", hospitalsRoutes);
  })
  .catch((err) => {
    console.error("MongoDB connection failed:", err.message);
    process.exit(1);
  });

// Start Server
app.listen(PORT, () => {
  console.log(`Auth server running on http://localhost:${PORT}`);
});