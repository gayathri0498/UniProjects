// frontend/src/components/ForecastDebugPanel.jsx
import React, { useEffect, useState } from "react";
import { fetchForecast } from "../api";

export default function ForecastDebugPanel({ disease, district }) {
  const [resp, setResp] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  const load = async (force = false) => {
    try {
      setLoading(true);
      setErr(null);
      const r = await fetchForecast(disease, district, force);
      setResp(r);
    } catch (e) {
      setErr(e?.message || "Error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (disease && district) load(false);
  }, [disease, district]);

  if (!disease || !district) return null;

  return (
    <div style={{ border: "1px solid #ddd", padding: 12, borderRadius: 8, marginTop: 12 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
        <strong>Forecast debug</strong>
        <button onClick={() => load(true)} disabled={loading} style={{ padding: "4px 8px" }}>
          {loading ? "Refreshing…" : "Force refresh"}
        </button>
      </div>
      {err && <div style={{ color: "crimson" }}>Error: {String(err)}</div>}
      {resp && (
        <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>
{JSON.stringify({
  disease: resp.disease,
  district: resp.district,
  model: resp.model,
  runDate: resp.runDate,
  cached: resp.cached,
  points: resp.predictions?.length || 0
}, null, 2)}
        </pre>
      )}
    </div>
  );
}