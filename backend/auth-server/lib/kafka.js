// backend/auth-server/lib/kafka.js

const { Kafka, logLevel } = require("kafkajs");

const CLIENT_ID   = process.env.KAFKA_CLIENT_ID || "rtess-auth-server";
const BROKERS     = (process.env.KAFKA_BOOTSTRAP || "localhost:9092")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const CONN_TIMEOUT_MS = Number(process.env.KAFKA_CONN_TIMEOUT_MS || 3000);
const REQ_TIMEOUT_MS  = Number(process.env.KAFKA_REQ_TIMEOUT_MS  || 30000);
const RETRIES         = Number(process.env.KAFKA_RETRIES || 5);

// Build Kafka client
const kafka = new Kafka({
  clientId: CLIENT_ID,
  brokers: BROKERS,
  connectionTimeout: CONN_TIMEOUT_MS,
  requestTimeout: REQ_TIMEOUT_MS,
  retry: { retries: RETRIES },
  // set to logLevel.INFO if you want verbose broker logs
  logLevel: logLevel.NOTHING,
});

// We keep a module-scoped producer so callers can reuse it
let _producer = null;

/**
 * Start or reuse a KafkaJS producer and attach shutdown hooks.
 */
async function startProducer() {
  if (_producer) return _producer;

  _producer = kafka.producer({
    allowAutoTopicCreation: true,
    retry: { retries: RETRIES },
  });

  console.log(
    `Kafka: connecting producer [clientId=${CLIENT_ID}] to brokers: ${BROKERS.join(", ")}`
  );

  await _producer.connect();

  console.log("Kafka producer connected");

  // graceful shutdown
  const shutdown = async (signal) => {
    try {
      console.log(`↩︎ ${signal} received — disconnecting Kafka producer...`);
      await _producer.disconnect();
      console.log("Kafka producer disconnected");
    } catch (e) {
      console.warn("Error disconnecting producer:", e?.message || e);
    } finally {
    }
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  return _producer;
}

/**
 * Get the current producer instance.
 */
function getProducer() {
  return _producer;
}

/**
 * Stop the producer
 */
async function stopProducer() {
  if (_producer) {
    await _producer.disconnect();
    _producer = null;
  }
}

/**
 * Ensure a topic exists
 */
async function ensureTopic(topic, numPartitions = 1, replicationFactor = 1) {
  const admin = kafka.admin();
  await admin.connect();
  try {
    const topics = await admin.listTopics();
    if (!topics.includes(topic)) {
      console.log(`Kafka: creating topic '${topic}' (p=${numPartitions}, rf=${replicationFactor})`);
      await admin.createTopics({
        topics: [{ topic, numPartitions, replicationFactor }],
        waitForLeaders: true,
      });
      console.log(`Kafka: topic '${topic}' created`);
    } else {
    }
  } finally {
    await admin.disconnect();
  }
}

// Back-compat named export `producer`
Object.defineProperty(module.exports, "producer", {
  get() { return _producer; },
});

module.exports.startProducer = startProducer;
module.exports.getProducer  = getProducer;
module.exports.stopProducer = stopProducer;
module.exports.ensureTopic  = ensureTopic;