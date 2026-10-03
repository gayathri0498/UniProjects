// src/hooks/useSpike.js
import { useEffect, useRef, useState } from "react";
import { fetchCases } from "../api";

const clamp = (n) => (Number.isFinite(n) ? n : 0);

export default function useSpike(disease, district) {
  const [state, setState] = useState({
    loading: false,
    error: null,
    today: 0,
    yesterday: 0,
    spikePct: 0,
    color: "#2f9e44", // default green
    label: "No data",
  });

  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!disease || !district) {
      setState((s) => ({
        ...s,
        loading: false,
        error: null,
        today: 0,
        yesterday: 0,
        spikePct: 0,
        color: "#2f9e44",
        label: "No data"
      }));
      return;
    }

    let cancel = false;

    (async () => {
      try {
        if (!mounted.current || cancel) return;
        setState((s) => ({ ...s, loading: true, error: null }));

        // last 2 days is enough for the spike
        const series = await fetchCases(disease, district, 2);

        const n = series.length;
        const today = clamp(n >= 1 ? series[n - 1]?.count : 0);
        const yesterday = clamp(n >= 2 ? series[n - 2]?.count : 0);

        // Safe % calculation
        let spikePct = 0;
        if (yesterday === 0 && today > 0) {
          spikePct = 100; // treat as outbreak, cap at 100%
        } else if (yesterday > 0) {
          spikePct = ((today - yesterday) / yesterday) * 100;
          spikePct = Math.min(Math.max(spikePct, 0), 100); // clamp between 0–100
        }

        // Color thresholds
        let color = "#2f9e44"; // green
        if (spikePct >= 30 && today > 0) color = "#e03131";      // red
        else if (spikePct >= 15 && today > 0) color = "#fcc419"; // amber

        const label =
          n === 0
            ? "No cases"
            : `Today ${today} vs Yesterday ${yesterday}  •  ${spikePct.toFixed(1)}%`;

        if (!cancel && mounted.current) {
          setState({
            loading: false,
            error: null,
            today,
            yesterday,
            spikePct,
            color,
            label,
          });
        }
      } catch (err) {
        if (!cancel && mounted.current) {
          setState((s) => ({
            ...s,
            loading: false,
            error: err,
            color: "#adb5bd",
            label: "Error",
          }));
        }
      }
    })();

    return () => { cancel = true; };
  }, [disease, district]);

  return state;
}