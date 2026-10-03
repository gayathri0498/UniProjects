// src/components/MapChoropleth.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { MapContainer, TileLayer, GeoJSON } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import tnGeoJson from "../data/tamilnadu_districts.json";
import { fetchCases } from "../api";

const normalize = (s = "") =>
  s.toString().trim().toLowerCase().replace(/\s+/g, " ");

// GeoJSON ↔ UI/db aliases
const DISTRICT_ALIASES = {
  thiruvallur: "Tiruvallur",
  tiruvallur: "Tiruvallur",
  thoothukudi: "Thoothukudi",
  tuticorin: "Thoothukudi",
  kancheepuram: "Kanchipuram",
  kanchipuram: "Kanchipuram",
  theni: "Theni",
  dindigul: "Dindigul",
  chengalpattu: "Chengalpattu",
  krishnagiri: "Krishnagiri",
  kanniyakumari: "Kanyakumari",
  kanyakumari: "Kanyakumari",
  tiruchirappalli: "Tiruchirappalli",
  trichy: "Tiruchirappalli",
  tirunelveli: "Tirunelveli",
  virudhunagar: "Virudhunagar",
  "the nilgiris": "The Nilgiris",
  nilgiris: "The Nilgiris",
  pudukkottai: "Pudukkottai",
  ariyalur: "Ariyalur",
  perambalur: "Perambalur",
  cuddalore: "Cuddalore",
  tiruppur: "Tiruppur",
  erode: "Erode",
  coimbatore: "Coimbatore",
  madurai: "Madurai",
  salem: "Salem",
  namakkal: "Namakkal",
  thanjavur: "Thanjavur",
  thiruvarur: "Tiruvarur",
  tiruvarur: "Tiruvarur",
  nagapattinam: "Nagapattinam",
  karur: "Karur",
  vellore: "Vellore",
  ranipet: "Ranipet",
  tirupathur: "Tirupathur",
  thiruvannamalai: "Tiruvannamalai",
  tiruvannamalai: "Tiruvannamalai",
  kallakurichi: "Kallakurichi",
  villupuram: "Viluppuram",
  viluppuram: "Viluppuram",
  chennai: "Chennai",
  tenkasi: "Tenkasi",
  mayiladuthurai: "Mayiladuthurai",
};

const canon = (name) => {
  const key = normalize(name);
  return DISTRICT_ALIASES[key] || name;
};

const riskColor = (pct) => {
  if (pct >= 30) return "#e03131"; // high = red
  if (pct >= 15) return "#fcc419"; // medium = amber
  return "#2f9e44"; // low = green
};

const geoNameFromFeature = (feature) =>
  feature?.properties?.NAME_2 ||
  feature?.properties?.District ||
  feature?.properties?.NAME ||
  feature?.properties?.name;

export default function MapChoropleth({
  disease, 
  forecast,
  onSelectDistrict,
  pollMs = 60_000,
}) {
  const [styleMap, setStyleMap] = useState({});
  const [casesInfo, setCasesInfo] = useState({
    hasData: false,
    today: 0,
    yesterday: 0,
    pct: null,
  });
  const layerRef = useRef(null);

  const diseaseName = disease || forecast?.disease || "";
  const { selectedName, forecastPct, forecastNoData } = useMemo(() => {
    const selected = canon(forecast?.district || "");
    const preds = Array.isArray(forecast?.predictions) ? forecast.predictions : [];
    const noDataFlag = !!forecast?.noData || preds.length < 2;

    let pct = null;
    if (!noDataFlag) {
      const prev = Number(preds[preds.length - 2]?.yhat ?? 0);
      const curr = Number(preds[preds.length - 1]?.yhat ?? 0);
      pct = ((curr - prev) / (prev || 1)) * 100;
    }
    return { selectedName: selected, forecastPct: pct, forecastNoData: noDataFlag };
  }, [forecast]);

  useEffect(() => {
    let cancelled = false;
    if (!diseaseName || !selectedName) {
      setCasesInfo({ hasData: false, today: 0, yesterday: 0, pct: null });
      return () => {};
    }

    const load = async () => {
      try {
        const cases = await fetchCases(diseaseName, selectedName, 2);
        if (cancelled) return;
        if (!Array.isArray(cases) || cases.length === 0) {
          setCasesInfo({ hasData: false, today: 0, yesterday: 0, pct: null });
          return;
        }

        // cases are returned ascending by date from the backend
        const last = cases[cases.length - 1]?.count ?? 0;
        const prev = cases.length > 1 ? cases[cases.length - 2]?.count ?? 0 : 0;

        const pct = ((Number(last) - Number(prev)) / Math.max(Number(prev), 1)) * 100;
        setCasesInfo({ hasData: true, today: Number(last), yesterday: Number(prev), pct });
      } catch {
        if (!cancelled) {
        }
      }
    };
    load();
    const id = setInterval(load, pollMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [diseaseName, selectedName, pollMs]);

  // Decide color/label for the selected district
  useEffect(() => {
    if (!selectedName) {
      setStyleMap({});
      return;
    }

    // 1) No case data at all-- green with a friendly tooltip
    if (!casesInfo.hasData && forecastNoData) {
      setStyleMap({
        [selectedName]: {
          color: "#2f9e44",
          label: "No forecast available",
          emphasize: true,
        },
      });
      return;
    }

    let pct = casesInfo.hasData ? casesInfo.pct : forecastPct;
    if (pct == null) {
      // absolute fallback
      setStyleMap({
        [selectedName]: {
          color: "#2f9e44",
          label: "Stable",
          emphasize: true,
        },
      });
      return;
    }

    // Build a more informative tooltip when using real-time cases
    const label = casesInfo.hasData
      ? `Today ${casesInfo.today} vs ${casesInfo.yesterday} • ${pct.toFixed(1)}%`
      : `${pct.toFixed(1)}% (forecast Δ)`;

    setStyleMap({
      [selectedName]: {
        color: riskColor(pct),
        label,
        emphasize: true,
      },
    });
  }, [selectedName, casesInfo, forecastNoData, forecastPct]);

  // GeoJSON style
  function style(feature) {
    const name = canon(geoNameFromFeature(feature));
    const info = styleMap[name];

    const base = {
      weight: 1,
      color: "#495057",
      fillOpacity: 0.6,
      fillColor: "#e9ecef" // neutral grey for unselected districts
    };

    if (info) {
      return {
        ...base,
        fillColor: info.color,
        fillOpacity: info.emphasize ? 0.85 : 0.6,
        weight: info.emphasize ? 2 : 1,
      };
    }
    return base;
  }

  function onEach(feature, layer) {
    const name = canon(geoNameFromFeature(feature));
    const info = styleMap[name];
    const label = info?.label ? `${name}: ${info.label}` : name;

    layer.bindTooltip(label, { sticky: true });

    layer.on({
      click: () => {
        if (typeof onSelectDistrict === "function") onSelectDistrict(name);
      },
      mouseover: (e) => e.target.setStyle({ weight: 2 }),
      mouseout: (e) => e.target.setStyle(style(feature)),
    });

    // ensure initial style is applied
    layer.setStyle(style(feature));
  }

  // Force GeoJSON to re-render on selection or data mode change
  const geoJsonKey = `${selectedName || "none"}-${casesInfo.hasData ? "cases" : (forecastNoData ? "nodata" : "forecast")}`;

  return (
    <MapContainer
      center={[11.0, 78.0]}
      zoom={7}
      style={{ width: "100%", height: "100%" }}
      attributionControl={false}
    >
      <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
      <GeoJSON
        key={geoJsonKey}
        ref={layerRef}
        data={tnGeoJson}
        style={style}
        onEachFeature={onEach}
      />
    </MapContainer>
  );
}