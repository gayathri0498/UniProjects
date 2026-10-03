const express = require("express");
const router = express.Router();
router.get("/", async (req, res) => {
  try {
    const alertsCollection = req.app.locals.alertsCollection;
    if (!alertsCollection) {
      return res.status(500).json({ error: "Alerts collection not available" });
    }

    const {
      disease,
      district,
      from,
      to,
      withTotal,
    } = req.query;

    // limit/skip
    let limit = Number(req.query.limit ?? 50);
    let skip = Number(req.query.skip ?? 0);
    if (!Number.isFinite(limit) || limit <= 0) limit = 50;
    if (!Number.isFinite(skip) || skip < 0) skip = 0;
    limit = Math.min(limit, 200);

    // build query
    const q = {};
    if (disease) q.disease = String(disease).trim();
    if (district) q.district = String(district).trim();

    // date filters
    if (from || to) {
      q.createdAt = {};
      if (from) {
        const d = new Date(from);
        if (isNaN(d)) return res.status(400).json({ error: "Invalid 'from' date" });
        q.createdAt.$gte = d;
      }
      if (to) {
        const d = new Date(to);
        if (isNaN(d)) return res.status(400).json({ error: "Invalid 'to' date" });
        q.createdAt.$lt = d;
      }
    }

    const cur = alertsCollection
      .find(q)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const [items, total] = await Promise.all([
      cur.toArray(),
      (withTotal === "1" || withTotal === "true") ? alertsCollection.countDocuments(q) : Promise.resolve(undefined),
    ]);

    res.status(200).json({
      items,
      count: items.length,
      ...(total !== undefined ? { total } : {}),
      skip,
      limit,
    });
  } catch (err) {
    console.error("Error fetching alerts:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;