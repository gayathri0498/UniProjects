// frontend/src/api.js
import axios from 'axios';

/**
 * Backend base URL.
 */
let API_BASE = (process.env.REACT_APP_API_URL || 'http://127.0.0.1:8000').trim();

/** Create a reusable axios client (cookies enabled for session auth). */
let api = axios.create({
  baseURL: API_BASE,
  timeout: 15000,
  headers: { 'Content-Type': 'application/json' },
  withCredentials: true,
});

/** Runtime override for the API base (keeps credentials enabled). */
export function setApiBase(newBaseUrl) {
  if (typeof newBaseUrl === 'string' && newBaseUrl.trim()) {
    API_BASE = newBaseUrl.trim();
    api = axios.create({
      baseURL: API_BASE,
      timeout: 15000,
      headers: { 'Content-Type': 'application/json' },
      withCredentials: true,
    });
  }
}

/** Encode path segments safely. */
const enc = (s) => encodeURIComponent(String(s ?? ''));

/* ---------------------------------------
 * Health
 * ------------------------------------- */
export async function fetchHealth() {
  const { data } = await api.get('/healthz');
  return data;
}

/* ---------------------------------------
 * Auth
 * ------------------------------------- */
export async function login(username, password) {
  // FastAPI expects form-encoded fields for /login
  const form = new URLSearchParams();
  form.set('username', username);
  form.set('password', password);
  const { data } = await api.post('/login', form, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  return data; // { message, role, username }
}

export async function logout() {
  const { data } = await api.post('/logout');
  return data; // { message: "Logged out" }
}

/* ---------------------------------------
 * Metadata
 * ------------------------------------- */
export async function fetchMetadata() {
  const { data } = await api.get('/metadata');
  return data; // { diseases, districts, existing_combinations }
}

/* ---------------------------------------
 * Alerts
 * GET /alerts?disease=&district=&since_days=&limit=&skip=&withTotal=1
 * ------------------------------------- */
export async function fetchAlerts({
  disease,
  district,
  since_days = 30,
  limit = 20,
  skip = 0,
  withTotal = false,
} = {}) {
  const params = { since_days, limit, skip };
  if (disease)  params.disease  = disease;
  if (district) params.district = district;
  if (withTotal) params.withTotal = 1;
  const { data } = await api.get('/alerts', { params });
  return {
    items: Array.isArray(data?.items) ? data.items : [],
    count: Number.isFinite(data?.count) ? data.count : 0,
    skip:  Number.isFinite(data?.skip)  ? data.skip  : 0,
    limit: Number.isFinite(data?.limit) ? data.limit : limit,
    total: Number.isFinite(data?.total) ? data.total : undefined,
  };
}

/* ---------------------------------------
 * Forecasts (public)
 * ------------------------------------- */
export async function fetchForecast(disease, district, force = false) {
  const { data } = await api.get(
    `/public/forecasts/${enc(disease)}/${enc(district)}`,
    { params: { refresh: force ? 1 : 0 } }
  );
  return data; // normalized by backend
}

/* ---------------------------------------
 * Raw cases
 * ------------------------------------- */
export async function fetchCases(disease, district, days = 2) {
  try {
    const { data } = await api.get(
      `/cases/${enc(disease)}/${enc(district)}`,
      { params: { days } }
    );
    return Array.isArray(data?.cases) ? data.cases : [];
  } catch (err) {
    if (err?.response?.status === 404) return [];
    throw err;
  }
}

/* ---------------------------------------
 * Admin ML retrain (requires admin session)
 * ------------------------------------- */
export async function adminRetrainAll() {
  const { data } = await api.post('/admin/forecasts/retrain-all');
  return data; // { message, pairs_processed }
}

export async function adminRetrainOne(disease, district) {
  const { data } = await api.post(
    `/admin/forecasts/${enc(disease)}/${enc(district)}/retrain`
  );
  return data;
}

export default api;