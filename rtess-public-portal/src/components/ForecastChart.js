// src/components/ForecastChart.js
import React, { useState, useEffect, useMemo } from "react";
import PropTypes from "prop-types";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer,
} from "recharts";

const containerStyle = { fontFamily: "Open Sans, sans-serif" };
const metaStyle = { marginBottom: 6, fontSize: 12, color: "#555" };

export default function ForecastChart({ disease, district }) {
  const [data, setData] = useState([]);
  const [model, setModel] = useState("");
  const [runDate, setRunDate] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Memoize the URL to avoid recomputing unnecessarily
  const endpoint = useMemo(
    () =>
      `http://localhost:8000/forecasts/${encodeURIComponent(
        disease
      )}/${encodeURIComponent(district)}`,
    [disease, district]
  );

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    setData([]);
    fetch(endpoint, { signal: ctrl.signal, credentials: "include" })
      .then(async (res) => {
        if (!res.ok) {
          const txt = await res.text();
          throw new Error(`Status ${res.status}: ${txt}`);
        }
        return res.json();
      })
      .then((json) => {
        if (ctrl.signal.aborted) return;
        const preds = json.predictions || [];
        const formatted = preds.map((item) => ({
          date: item.ds ? item.ds.slice(0, 10) : "",
          forecast: typeof item.yhat === "number" ? item.yhat : null,
        }));
        setData(formatted);
        setModel(json.model || "unknown");
        setRunDate(json.runDate || "");
        setLoading(false);
      })
      .catch((err) => {
        if (ctrl.signal.aborted) return;
        console.error("Forecast fetch error:", err);
        setError(err.message || "Failed to load forecast");
        setLoading(false);
      });
    return () => {
      ctrl.abort();
    };
  }, [endpoint]);

  const formattedRunDate = useMemo(() => {
    if (!runDate) return "";
    try {
      const dt = new Date(runDate);
      if (isNaN(dt.getTime())) return "";
      return `${dt.toLocaleDateString()} ${dt.toLocaleTimeString()}`;
    } catch {
      return "";
    }
  }, [runDate]);

  if (loading) return <p>Loading forecast…</p>;
  if (error) return <p style={{ color: "red" }}>Error: {error}</p>;
  if (!data.length) return <p>No forecast available.</p>;

  return (
    <div style={containerStyle}>
      <div style={metaStyle}>
        Forecast by <strong>{model}</strong>{" "}
        {formattedRunDate && (
          <>
            (run at {formattedRunDate})
          </>
        )}
      </div>
      <ResponsiveContainer width="100%" height={250}>
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="date" tick={{ fontSize: 10 }} />
          <YAxis />
          <Tooltip />
          <Line
            type="monotone"
            dataKey="forecast"
            stroke="#1f77b4"
            strokeWidth={2}
            dot={{ r: 3 }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

ForecastChart.propTypes = {
  disease: PropTypes.string.isRequired,
  district: PropTypes.string.isRequired,
};