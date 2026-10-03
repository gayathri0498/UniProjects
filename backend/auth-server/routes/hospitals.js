// backend/auth-server/routes/hospitals.js
const express = require("express");
const { ObjectId } = require("mongodb");
const router = express.Router();

/** get handles to Mongo collections*/
function cols(req) {
  const {
    usersCollection,
    patientsCollection,
  } = req.app.locals || {};
  if (!usersCollection || !patientsCollection) {
    throw new Error("Collections not available (Mongo not initialized yet)");
  }
  return { usersCollection, patientsCollection };
}

/** Try to interpret a string as ObjectId */
function maybeObjectId(s) {
  try {
    return new ObjectId(String(s));
  } catch {
    return null;
  }
}

/**
 * Resolve an input id to a query for patients:
 * - If id is a valid users._id, fetch that user and prefer their hospitalId; fallback to username.
 */
async function resolveHospitalQuery(req, id) {
  const { usersCollection } = cols(req);
  const orArr = [];
  const resolved = {};

  const asOid = maybeObjectId(id);
  if (asOid) {
    const user = await usersCollection.findOne({ _id: asOid });
    if (user) {
      if (user.hospitalId) {
        orArr.push({ hospitalId: user.hospitalId });
        resolved.hospitalId = user.hospitalId;
      }
      if (user.username) {
        orArr.push({ username: user.username });
        resolved.username = user.username;
      }
    }
  }

  // Always also match the raw id as either hospitalId or username
  orArr.push({ hospitalId: id });
  orArr.push({ username: id });

  return {
    orQuery: { $or: orArr },
    resolved,
  };
}

/** GET /api/users?role=hospital&status=approved */
router.get("/users", async (req, res) => {
  try {
    const { usersCollection } = cols(req);
    const { role, status } = req.query;
    const q = {};
    if (role) q.role = role;
    if (status) q.status = status;

    const docs = await usersCollection
      .find(q)
      .project({ passwordHash: 0 })
      .sort({ createdAt: -1 })
      .toArray();

    res.json(docs);
  } catch (e) {
    console.error("GET /api/users failed", e);
    res.status(500).json({ error: "Failed to list users" });
  }
});

/** GET /api/hospitals?status=approved  (alias for role=hospital) */
router.get("/hospitals", async (req, res) => {
  try {
    const { usersCollection } = cols(req);
    const { status } = req.query;
    const q = { role: "hospital" };
    if (status) q.status = status;

    const docs = await usersCollection
      .find(q)
      .project({ passwordHash: 0 })
      .sort({ createdAt: -1 })
      .toArray();

    res.json(docs);
  } catch (e) {
    console.error("GET /api/hospitals failed", e);
    res.status(500).json({ error: "Failed to list hospitals" });
  }
});

/** GET /api/hospital-patients/:id  (latest 1000 rows for a hospital) */
router.get("/hospital-patients/:id", async (req, res) => {
  try {
    const { patientsCollection } = cols(req);
    const id = String(req.params.id || "").trim();
    const { orQuery } = await resolveHospitalQuery(req, id);

    const pts = await patientsCollection
      .find(orQuery)
      .sort({ diagnosisDate: -1, _id: -1 })
      .limit(1000)
      .toArray();

    res.json({ patients: pts });
  } catch (e) {
    console.error("GET /api/hospital-patients failed", e);
    res.status(500).json({ error: "Failed to load patients" });
  }
});

/** GET /api/hospitals/:id/stats  (disease counts, distinct districts, etc.) */
router.get("/hospitals/:id/stats", async (req, res) => {
  try {
    const { patientsCollection } = cols(req);
    const id = String(req.params.id || "").trim();
    const { orQuery, resolved } = await resolveHospitalQuery(req, id);
    const pts = await patientsCollection
      .find(orQuery)
      .project({ disease: 1, district: 1, diagnosisDate: 1 })
      .toArray();

    const diseases = {};
    const districts = new Set();
    let latest = null;

    for (const p of pts) {
      const d = (p.disease || "").trim();
      const dist = (p.district || "").trim();
      if (d) diseases[d] = (diseases[d] || 0) + 1;
      if (dist) districts.add(dist);
      const t = p.diagnosisDate ? new Date(p.diagnosisDate) : null;
      if (t && (!latest || t > latest)) latest = t;
    }

    const diseaseList = Object.entries(diseases)
      .sort((a, b) => b[1] - a[1])
      .map(([name, total]) => ({ name, total }));

    res.json({
      resolved,
      diseaseList,
      districts: Array.from(districts).sort(),
      totalPatients: pts.length,
      lastReportAt: latest ? latest.toISOString() : null,
    });
  } catch (e) {
    console.error("GET /api/hospitals/:id/stats failed", e);
    res.status(500).json({ error: "Failed to compute stats" });
  }
});

module.exports = router;