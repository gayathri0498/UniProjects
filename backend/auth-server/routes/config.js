const express = require("express");
const router = express.Router();

/**
 * GET /api/config
 */
router.get("/", async (req, res) => {
  try {
    const configCollection = req.app.locals.configCollection;
    if (!configCollection) {
      return res.status(500).json({ error: "Config collection not available" });
    }

    const items = await configCollection
      .find({}, { projection: { _id: 0 } })
      .sort({ disease: 1 })
      .toArray();

    res.status(200).json(items);
  } catch (err) {
    console.error("Error fetching config:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /api/config
 */
router.post("/", async (req, res) => {
  try {
    const configCollection = req.app.locals.configCollection;
    if (!configCollection) {
      return res.status(500).json({ error: "Config collection not available" });
    }

    let { disease, thresholdPct, minCases } = req.body;

    // Validate presence
    if (!disease && disease !== "") {
      return res.status(400).json({ error: "Field 'disease' is required" });
    }
    disease = String(disease).trim();
    if (!disease) {
      return res.status(400).json({ error: "Field 'disease' cannot be empty" });
    }

    // Coerce & validate numbers
    thresholdPct = Number(thresholdPct);
    minCases = Number(minCases);
    if (!Number.isFinite(thresholdPct) || !Number.isFinite(minCases)) {
      return res.status(400).json({ error: "'thresholdPct' and 'minCases' must be numbers" });
    }
    if (thresholdPct < 0) thresholdPct = 0;
    if (thresholdPct > 1000) thresholdPct = 1000;
    if (minCases < 0) minCases = 0;

    const update = {
      disease,
      thresholdPct,
      minCases,
    };

    const r = await configCollection.updateOne(
      { disease },
      { $set: update },
      { upsert: true }
    );

    res.status(200).json({
      message: "Config saved",
      disease,
      thresholdPct,
      minCases,
      upserted: r.upsertedCount === 1,
      modified: r.modifiedCount === 1,
    });
  } catch (err) {
    console.error("Error saving config:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;