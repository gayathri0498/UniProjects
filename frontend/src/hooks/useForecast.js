// src/hooks/useForecast.js
import { useState, useEffect, useRef } from 'react';
import { fetchForecast } from '../api';

/**
 * useForecast(disease, district)
 * - Returns { data, loading, error }
 */
export default function useForecast(disease, district) {
  const [data, setData]    = useState(null);
  const [loading, setLoad] = useState(false);
  const [error, setError]  = useState(null);

  // track mount state to avoid setting state on unmounted component
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // sequence guard to avoid race conditions
  const seqRef = useRef(0);

  useEffect(() => {
    if (!disease || !district) {
      setData(null);
      setError(null);
      setLoad(false);
      return;
    }

    let cancelled = false;
    const mySeq = ++seqRef.current;

    const load = async (force = false) => {
      if (cancelled || !mountedRef.current) return;
      if (mySeq === seqRef.current) {
        setLoad(true);
        setError(null);
      }

      try {
        const result = await fetchForecast(disease, district, force);
        if (cancelled || !mountedRef.current || mySeq !== seqRef.current) return;

        const noData =
          !Array.isArray(result?.predictions) || result.predictions.length === 0;

        setData({
          ...result,
          disease,
          district,
          noData,
        });
        setError(null);
      } catch (err) {
        if (cancelled || !mountedRef.current || mySeq !== seqRef.current) return;

        const status = err?.response?.status ?? err?.status;

        if (status === 404) {
          // Graceful "no data yet" object
          setData({
            disease,
            district,
            predictions: [],
            model: '',
            mse: null,
            generated_with: 'no-data',
            runDate: null,
            noData: true, // <-- UI key: map = green, chart = friendly text
          });
          setError(null);
        } else {
          // Keep a real error only for non-404 cases
          setError(err);
        }
      } finally {
        if (cancelled || !mountedRef.current || mySeq !== seqRef.current) return;
        setLoad(false);
      }
    };

    // initial load
    load(false);

    // hourly forced refresh to keep the UI fresh
    const id = setInterval(() => load(true), 60 * 60 * 1000);

    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [disease, district]);

  return { data, loading, error };
}