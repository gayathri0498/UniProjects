// backend/auth-server/routes/patients.js

const express = require("express");
const { ObjectId } = require("mongodb");
const { v4: uuidv4 } = require("uuid");

const router = express.Router();

// Config: toggle latency logs
const DEBUG_LATENCY = process.env.DEBUG_LATENCY !== "0";

// Helpers
const isMissing = (value) =>
  value === undefined || value === null || value === "";

function toUTCDateOnly(d) {
  const dt = new Date(d);
  // normalize to midnight UTC so one message affects a single day
  return new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()));
}

/**
 * Publish a case event to Kafka.
 * - If latencyMeta is provided, we propagate _latency {eventId,t0} and set root eventId
 *   so the Python consumer can compute t0→t3.
 * - Returns { eventId, t2 } where t2 is the broker-ack timestamp.
 */
async function publishCaseEvent(app, payload, latencyMeta) {
  const producer = app.locals.kafkaProducer;
  const topic = app.locals.kafkaTopic || "disease.cases";

  // tolerate environments where Kafka isn't up yet
  if (!producer) {
    console.warn("Kafka producer not available; skipping publish", payload);
    return { eventId: latencyMeta?.eventId || uuidv4(), t2: null, skipped: true };
  }
  const eventId = latencyMeta?.eventId || payload.eventId || uuidv4();

  const enriched = {
    eventId,
    ...(latencyMeta?.t0
      ? { _latency: { eventId, t0: latencyMeta.t0 } }
      : {}),
    ...payload,
    producedAt: new Date().toISOString(),
  };

  await producer.send({ topic, messages: [{ value: JSON.stringify(enriched) }] });
  const t2 = Date.now();

  return { eventId, t2, skipped: false };
}

// POST /patients → Add patient (publishes INC)
router.post("/", async (req, res) => {
  // t1 (backend received)
  const t1 = Date.now();
  // pull client latency meta if present
  const _lat = (req.body && req.body._latency) || null;
  const t0 = _lat?.t0;
  const id = _lat?.eventId || uuidv4();
  if (DEBUG_LATENCY) {
    console.log(
      `[LAT] ${id} t1=${new Date(t1).toISOString()} ` +
      `Δ01=${t0 ? (t1 - t0) + "ms" : "n/a"} (backend received)`
    );
  }

  try {
    const patientsCollection = req.app.locals.patientsCollection;
    const {
      hospitalId,
      doctorname,
      disease,
      district,
      age,
      gender,
      symptoms,
      temperature,
      pulse,
      diagnosisDate,
    } = req.body || {};

    if (
      isMissing(hospitalId) ||
      isMissing(doctorname) ||
      isMissing(disease) ||
      isMissing(district) ||
      isMissing(gender) ||
      isMissing(diagnosisDate) ||
      !Array.isArray(symptoms) ||
      symptoms.length === 0
    ) {
      return res.status(400).json({ error: "All required fields must be filled" });
    }

    const dxDate = new Date(diagnosisDate);
    const newPatient = {
      hospitalId,
      doctorname,
      disease,
      district,
      age: Number(age) || 0,
      gender,
      symptoms,
      temperature: Number(temperature) || 0,
      pulse: Number(pulse) || 0,
      diagnosisDate: dxDate,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const dbResult = await patientsCollection.insertOne(newPatient);
    const t_db = Date.now();
    if (DEBUG_LATENCY) {
      console.log(
        `[LAT] ${id} t_db=${new Date(t_db).toISOString()} Δdb=${t_db - t1}ms (db ack)`
      );
    }
    const pub = await publishCaseEvent(
      req.app,
      {
        action: "inc",
        disease,
        district,
        timestamp: toUTCDateOnly(dxDate).toISOString(),
        source: "patients_api",
        patientId: dbResult.insertedId.toString(),
      },
      { eventId: id, t0 }
    );

    if (DEBUG_LATENCY) {
      if (pub.skipped) {
        console.log(`[LAT] ${id} t2=KAFKA_SKIP (producer unavailable)`);
      } else {
        console.log(
          `[LAT] ${id} t2=KAFKA_ACK ${new Date(pub.t2).toISOString()} ` +
          `Δ12=${pub.t2 - t1}ms ${t0 ? `Δ02=${pub.t2 - t0}ms` : "Δ02=n/a"} (broker ack)`
        );
      }
    }

    res.status(201).json({ message: "Patient added", patientId: dbResult.insertedId });
  } catch (err) {
    console.error("Error adding patient:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /patients → Get patients for hospital
router.get("/", async (req, res) => {
  try {
    const patientsCollection = req.app.locals.patientsCollection;
    const { hospitalId } = req.query;

    if (!hospitalId) {
      return res.status(400).json({ error: "Missing hospitalId" });
    }

    const patients = await patientsCollection
      .find({ hospitalId })
      .sort({ diagnosisDate: -1 })
      .toArray();

    res.status(200).json(patients);
  } catch (err) {
    console.error("❌ Error fetching patients:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ───── PUT /patients/:id → Update patient (publishes DEC+INC if bucket changed) ─────
router.put("/:id", async (req, res) => {
  const t1 = Date.now();
  const _lat = (req.body && req.body._latency) || null;
  const t0 = _lat?.t0;
  const id = _lat?.eventId || uuidv4();
  if (DEBUG_LATENCY) {
    console.log(
      `[LAT] ${id} t1=${new Date(t1).toISOString()} ` +
      `Δ01=${t0 ? (t1 - t0) + "ms" : "n/a"} (backend received PUT)`
    );
  }

  try {
    const patientsCollection = req.app.locals.patientsCollection;
    const { id: paramId } = req.params;

    if (!ObjectId.isValid(paramId)) {
      return res.status(400).json({ error: "Invalid patient ID" });
    }

    // Fetch existing to compare buckets
    const existing = await patientsCollection.findOne({ _id: new ObjectId(paramId) });
    if (!existing) {
      return res.status(404).json({ error: "Patient not found" });
    }

    const {
      hospitalId,
      doctorname,
      disease,
      district,
      age,
      gender,
      symptoms,
      temperature,
      pulse,
      diagnosisDate,
    } = req.body || {};

    if (
      isMissing(hospitalId) ||
      isMissing(doctorname) ||
      isMissing(disease) ||
      isMissing(district) ||
      isMissing(gender) ||
      isMissing(diagnosisDate) ||
      !Array.isArray(symptoms) ||
      symptoms.length === 0
    ) {
      return res.status(400).json({ error: "All required fields must be filled" });
    }

    const dxDate = new Date(diagnosisDate);
    const updatedPatient = {
      hospitalId,
      doctorname,
      disease,
      district,
      age: Number(age) || 0,
      gender,
      symptoms,
      temperature: Number(temperature) || 0,
      pulse: Number(pulse) || 0,
      diagnosisDate: dxDate,
      updatedAt: new Date(),
    };

    // Enforce hospital ownership on update
    const result = await patientsCollection.updateOne(
      { _id: new ObjectId(paramId), hospitalId },
      { $set: updatedPatient }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: "Patient not found or unauthorized" });
    }

    const t_db = Date.now();
    if (DEBUG_LATENCY) {
      console.log(
        `[LAT] ${id} t_db=${new Date(t_db).toISOString()} Δdb=${t_db - t1}ms (db ack PUT)`
      );
    }

    // Determine if the daily bucket changed (disease/district/date)
    const oldBucket = {
      disease: existing.disease,
      district: existing.district,
      dateISO: toUTCDateOnly(existing.diagnosisDate).toISOString(),
    };
    const newBucket = {
      disease: updatedPatient.disease,
      district: updatedPatient.district,
      dateISO: toUTCDateOnly(updatedPatient.diagnosisDate).toISOString(),
    };

    if (
      oldBucket.disease !== newBucket.disease ||
      oldBucket.district !== newBucket.district ||
      oldBucket.dateISO !== newBucket.dateISO
    ) {
      // For edits, publish DEC and INC with fresh eventIds,
      // to avoid duplicate eventId collisions.
      const decPub = await publishCaseEvent(req.app, {
        action: "dec",
        disease: oldBucket.disease,
        district: oldBucket.district,
        timestamp: oldBucket.dateISO,
        source: "patients_api_edit",
        patientId: paramId,
      });

      const incPub = await publishCaseEvent(req.app, {
        action: "inc",
        disease: newBucket.disease,
        district: newBucket.district,
        timestamp: newBucket.dateISO,
        source: "patients_api_edit",
        patientId: paramId,
      });

      if (DEBUG_LATENCY) {
        if (decPub.skipped || incPub.skipped) {
          console.log(`[LAT] ${id} t2=KAFKA_SKIP (producer unavailable during PUT)`);
        } else {
          const t2_latest = Math.max(decPub.t2 || 0, incPub.t2 || 0);
          console.log(
            `[LAT] ${id} t2=KAFKA_ACK ${new Date(t2_latest).toISOString()} ` +
            `Δ12=${t2_latest - t1}ms ${t0 ? `Δ02=${t2_latest - t0}ms` : "Δ02=n/a"} (broker ack PUT)`
          );
        }
      }
    } else if (DEBUG_LATENCY) {
      console.log(`[LAT] ${id} PUT did not move bucket; no Kafka publish needed.`);
    }

    res.status(200).json({ message: "Patient updated successfully" });
  } catch (err) {
    console.error("Error updating patient:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;