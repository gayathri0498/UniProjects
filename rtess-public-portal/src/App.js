// src/App.js
import React, { useState } from "react";
import "./App.css";
import TNMap from "./components/TNMap";
import ForecastChart from "./components/ForecastChart";

const DISEASES = ["Dengue", "Malaria", "Influenza", "COVID-19"];
const DISTRICTS = ["Chennai", "Madurai", "Coimbatore", "Salem", "Erode"]; // could be dynamic

function App() {
  const [disease, setDisease] = useState("Dengue");
  const [district, setDistrict] = useState("Chennai");

  return (
    <div className="App" style={{ fontFamily: "Open Sans, sans-serif", padding: 16 }}>
      <header style={{ marginBottom: 24 }}>
        <h1 style={{ margin: 0 }}>RTESS Public Dashboard</h1>
        <p style={{ marginTop: 4, color: "#555" }}>
          Real-time epidemic surveillance for Tamil Nadu
        </p>
      </header>

      <section
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 24,
          marginBottom: 32,
        }}
      >
        <div
          style={{
            padding: 16,
            borderRadius: 12,
            boxShadow: "0 6px 16px rgba(0,0,0,0.08)",
            background: "#fff",
          }}
        >
          <h2 style={{ marginTop: 0, fontSize: 18 }}>Filters</h2>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <div>
              <label htmlFor="disease-select" style={{ display: "block", fontSize: 12 }}>
                Disease
              </label>
              <select
                id="disease-select"
                value={disease}
                onChange={(e) => setDisease(e.target.value)}
                style={{ padding: 8, borderRadius: 6 }}
              >
                {DISEASES.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="district-select" style={{ display: "block", fontSize: 12 }}>
                District
              </label>
              <select
                id="district-select"
                value={district}
                onChange={(e) => setDistrict(e.target.value)}
                style={{ padding: 8, borderRadius: 6 }}
              >
                {DISTRICTS.map((dt) => (
                  <option key={dt} value={dt}>
                    {dt}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        <div
          style={{
            padding: 16,
            borderRadius: 12,
            boxShadow: "0 6px 16px rgba(0,0,0,0.08)",
            background: "#fff",
          }}
        >
          <h2 style={{ marginTop: 0, fontSize: 18 }}>Forecast Preview</h2>
          <ForecastChart disease={disease} district={district} />
        </div>
      </section>

      <section
        style={{
          padding: 16,
          borderRadius: 12,
          boxShadow: "0 6px 16px rgba(0,0,0,0.08)",
          background: "#fff",
          marginBottom: 32,
        }}
      >
        <h2 style={{ marginTop: 0, fontSize: 18 }}>Disease Spread Map</h2>
        <div style={{ height: 500 }}>
          <TNMap disease={disease} district={district} />
        </div>
      </section>

      <footer style={{ textAlign: "center", fontSize: 12, color: "#888" }}>
        RTESS prototype &mdash; data is synthetic / simulated. &copy; {new Date().getFullYear()}
      </footer>
    </div>
  );
}

export default App;