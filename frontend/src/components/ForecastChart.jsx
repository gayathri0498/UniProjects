// src/components/ForecastChart.jsx
import React from "react";
import { Line } from "react-chartjs-2";
import { Text } from "@mantine/core";

import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title as ChartTitle,
  Tooltip,
  Legend,
  Filler,
} from "chart.js";

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  ChartTitle,
  Tooltip,
  Legend,
  Filler
);

export default function ForecastChart({ forecast, loading, error }) {
  // Friendly early states
  if (loading) {
    return <Text ta="center" c="dimmed">Loading forecast…</Text>;
  }
  // Only show a hard error if it’s not the intentional “no data” path
  if (error && !forecast?.noData) {
    return (
      <Text ta="center" c="red">
        Couldn’t fetch forecast. Please try again.
      </Text>
    );
  }

  const points = Array.isArray(forecast?.predictions) ? forecast.predictions : [];
  const noData = forecast?.noData || points.length === 0;

  if (noData) {
    return (
      <div style={{ padding: 12 }}>
        <Text ta="center" c="teal" fw={600}>
          No forecast available yet
        </Text>
        {forecast?.disease && forecast?.district && (
          <Text ta="center" c="dimmed" size="sm">
            {forecast.disease} — {forecast.district}
          </Text>
        )}
        <Text ta="center" c="dimmed" size="sm" mt={6}>
          As soon as case data arrives, a forecast will appear here.
        </Text>
      </div>
    );
  }

  // Build data series
  const labels = points.map((p) => p.ds);
  const yhat   = points.map((p) => Number(p.yhat ?? 0));
  const lower  = points.map((p) => Number(p.yhat_lower ?? p.yhat ?? 0));
  const upper  = points.map((p) => Number(p.yhat_upper ?? p.yhat ?? 0));
  const data = {
    labels,
    datasets: [
      // Lower bound
      {
        label: "Lower bound",
        data: lower,
        borderWidth: 0,
        pointRadius: 0,
        fill: false,
      },
      // Upper bound
      {
        label: "Upper bound",
        data: upper,
        borderWidth: 0,
        pointRadius: 0,
        backgroundColor: "rgba(25, 113, 194, 0.10)",
        fill: "-1",
      },
      // Mean forecast
      {
        label: "Forecast",
        data: yhat,
        borderColor: "#1971c2",
        backgroundColor: "transparent",
        fill: false,
        tension: 0.35,
        pointRadius: 3,
      },
    ],
  };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      title: {
        display: true,
        text: "7-Day Forecast",
      },
      tooltip: { mode: "index", intersect: false },
    },
    interaction: { mode: "nearest", axis: "x", intersect: false },
    scales: {
      x: {
        title: { display: true, text: "Date" },
        ticks: { maxRotation: 0, autoSkip: true },
      },
      y: {
        title: { display: true, text: "Cases" },
        ticks: {
          callback: (v) => (Number.isInteger(v) ? v : Math.round(v)),
        },
        beginAtZero: true,
      },
    },
  };

  // Small meta subtitle
  const metaLine = [
    forecast?.disease && forecast?.district
      ? `${forecast.disease} — ${forecast.district}`
      : null,
    forecast?.model ? `Model: ${forecast.model}` : null,
    forecast?.runDate ? `Run: ${new Date(forecast.runDate).toLocaleString()}` : null,
  ]
    .filter(Boolean)
    .join("  •  ");

  return (
    <div style={{ height: 320 }}>
      {metaLine && (
        <Text ta="center" c="dimmed" size="sm" mb={6}>
          {metaLine}
        </Text>
      )}
      <Line data={data} options={options} />
    </div>
  );
}