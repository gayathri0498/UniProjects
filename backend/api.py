# rtess-system/backend/api.py
import sys
import pathlib
import os
import uuid
import math
import time
from datetime import timedelta, datetime, timezone
from typing import Dict, Any, Optional
from collections import defaultdict, deque

from fastapi import FastAPI, HTTPException, Depends, Request, Response, Form, Query
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.gzip import GZipMiddleware
from pymongo import MongoClient
from dotenv import load_dotenv
import bcrypt
import logging

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from forecast_service import (
    get_forecast,
    run_all_forecasts, 
    run_single_forecast, 
)

# Configuration / constants
load_dotenv()
MONGO_URI = os.getenv("MONGO_URI")
if not MONGO_URI:
    raise RuntimeError("MONGO_URI must be set in .env")

SESSION_COOKIE_NAME = "rtess_session"
SESSION_TTL = timedelta(hours=4)
UTC = timezone.utc

# cache 5 minutes
FORECAST_CACHE_TTL_SECONDS = int(os.getenv("FORECAST_CACHE_TTL_SECONDS", "300"))

# Mongo setup
client = MongoClient(MONGO_URI)
db = client["epidemics"]
users_col = db["users"]
cases_col = db["cases"]
forecasts_col = db["forecasts"]
alerts_col = db["alerts"]  # used by /alerts

# FastAPI app and CORS and GZip
app = FastAPI(title="RTESS Backend API")
EXPLICIT_ORIGINS = [
    o.strip() for o in (os.getenv("CORS_ORIGINS") or "").split(",") if o.strip()
]

if EXPLICIT_ORIGINS:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=EXPLICIT_ORIGINS,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
else:
    ALLOW_ORIGIN_REGEX = os.getenv(
        "CORS_ORIGIN_REGEX",
        r"https?://(localhost|127\.0\.0\.1)(:\d+)?$",
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=ALLOW_ORIGIN_REGEX,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
app.add_middleware(GZipMiddleware, minimum_size=500)

# Logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("backend_api")

# Request timing & simple metrics
METRICS = defaultdict(lambda: {"n": 0, "hits": 0, "misses": 0, "lat": deque(maxlen=500)})

def _percentile(sorted_vals, p):
    if not sorted_vals:
        return None
    k = (len(sorted_vals) - 1) * (p / 100.0)
    f = int(k); c = min(f + 1, len(sorted_vals) - 1)
    if f == c:
        return sorted_vals[f]
    return sorted_vals[f] * (c - k) + sorted_vals[c] * (k - f)

@app.middleware("http")
async def timing_mw(request: Request, call_next):
    start = time.perf_counter()
    response = await call_next(request)
    dur_ms = (time.perf_counter() - start) * 1000.0

    # Group metrics by major path
    path = request.url.path
    group = (
        "forecasts" if "forecast" in path
        else "alerts" if "alert" in path
        else "geo" if "geo" in path
        else "other"
    )

    # Cache status if set by the route
    cache_hdr = response.headers.get("X-Cache", "-")
    m = METRICS[group]
    m["n"] += 1
    m["lat"].append(dur_ms)
    if cache_hdr == "HIT":
        m["hits"] += 1
    elif cache_hdr == "MISS":
        m["misses"] += 1

    # Per-request timing log for screenshots
    logger.info("[API] %s %s %d %.1fms cache=%s",
                request.method, path, response.status_code, dur_ms, cache_hdr)

    # Summary every 20 requests: p50/p95 and cache hit rate
    if m["n"] % 20 == 0:
        sv = sorted(m["lat"])
        p50 = _percentile(sv, 50) or 0.0
        p95 = _percentile(sv, 95) or 0.0
        denom = max(1, m["hits"] + m["misses"])
        hit_rate = (m["hits"] / denom) * 100.0
        logger.info("[API-SUMMARY] %s n=%d p50=%.0fms p95=%.0fms hitRate=%.0f%%",
                    group, m["n"], p50, p95, hit_rate)

    # Also expose on the response
    response.headers["X-Response-Time"] = f"{dur_ms:.1f}ms"
    return response

# Sessions
SESSIONS: Dict[str, Dict[str, Any]] = {}

def create_session(user_doc: dict) -> str:
    token = str(uuid.uuid4())
    now = datetime.now(UTC)
    SESSIONS[token] = {
        "username": user_doc["username"],
        "role": user_doc.get("role", "user"),
        "created_at": now,
        "expires_at": now + SESSION_TTL,
    }
    return token

def get_current_user(request: Request):
    token = request.cookies.get(SESSION_COOKIE_NAME)
    if not token or token not in SESSIONS:
        raise HTTPException(status_code=401, detail="Unauthorized")
    session = SESSIONS[token]
    if session["expires_at"] < datetime.now(UTC):
        del SESSIONS[token]
        raise HTTPException(status_code=401, detail="Session expired")
    return session

def _require_admin(user):
    if not user or user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin only")

def _cleanup_sessions():
    now = datetime.now(UTC)
    for k in [k for k, v in SESSIONS.items() if v["expires_at"] < now]:
        del SESSIONS[k]

# Forecast cache with TTL
_FORECAST_CACHE: Dict[str, Dict[str, Any]] = {}

def _cache_key(disease: str, district: str) -> str:
    return f"{disease}::{district}"

def _get_cached_forecast(key: str):
    entry = _FORECAST_CACHE.get(key)
    if not entry:
        return None
    age = (datetime.now(UTC) - entry["fetched_at"]).total_seconds()
    if age > FORECAST_CACHE_TTL_SECONDS:
        del _FORECAST_CACHE[key]
        return None
    return entry["value"]

def _set_cached_forecast(key: str, value: dict):
    _FORECAST_CACHE[key] = {"fetched_at": datetime.now(UTC), "value": value}

# Utilities
def _sanitize_numbers(obj):
    """Make sure JSON never fails due to NaN/Inf."""
    if isinstance(obj, float) and not math.isfinite(obj):
        return None
    if isinstance(obj, list):
        return [_sanitize_numbers(x) for x in obj]
    if isinstance(obj, dict):
        return {k: _sanitize_numbers(v) for k, v in obj.items()}
    return obj

def _normalize_run_date(run_date_raw):
    """Normalize runDate to timezone-aware UTC datetime."""
    if not run_date_raw:
        return None
    if isinstance(run_date_raw, str):
        try:
            dt = datetime.fromisoformat(run_date_raw.replace("Z", "+00:00"))
        except Exception:
            return None
    elif isinstance(run_date_raw, datetime):
        dt = run_date_raw
    else:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC)

def _no_data_payload(disease: str, district: str):
    """Friendly “no data yet” payload so the UI stays green & quiet."""
    return {
        "disease": disease,
        "district": district,
        "predictions": [],
        "model": None,
        "mse": None,
        "hyperparameters": {},
        "data_quality": {},
        "runDate": None,
        "generated_with": "",
        "cached": False,
        "age_seconds": None,
        "meta": {"status": "no-data"},
    }

def _enrich_forecast_response(raw: dict, disease: str, district: str, cached: bool):
    """Final response builder for forecasts."""
    raw = _sanitize_numbers(raw or {})
    run_dt = _normalize_run_date(raw.get("runDate"))
    return {
        "disease": disease,
        "district": district,
        "predictions": raw.get("predictions", []),
        "model": raw.get("model", ""),
        "mse": raw.get("mse"),
        "hyperparameters": raw.get("hyperparameters", {}),
        "data_quality": raw.get("data_quality", {}),
        "runDate": run_dt.isoformat() if run_dt else None,
        "generated_with": raw.get("generated_with", ""),
        "cached": cached,
        "age_seconds": (datetime.now(UTC) - run_dt).total_seconds() if run_dt else None,
        "meta": raw.get("meta", {}),
    }

def _retrieve_forecast_and_cache(disease: str, district: str, refresh: bool):
    """Pull forecast → cache → format. Never 500 on missing data."""
    key = _cache_key(disease, district)

    if not refresh:
        cached = _get_cached_forecast(key)
        if cached:
            return _enrich_forecast_response(cached, disease, district, cached=True)

    try:
        raw = get_forecast(disease, district, force=refresh)
    except Exception:
        logger.exception("Forecast generation error for %s/%s", disease, district)
        return _no_data_payload(disease, district)

    if not raw or "predictions" not in raw or ("error" in raw):
        return _no_data_payload(disease, district)

    clean = _sanitize_numbers(raw)
    _set_cached_forecast(key, clean)
    return _enrich_forecast_response(clean, disease, district, cached=False)

def _coerce_bool(v, default=False):
    if isinstance(v, bool):
        return v
    if v is None:
        return default
    s = str(v).strip().lower()
    return s in ("1", "true", "yes", "y", "t")

#
# Health
#
@app.get("/healthz")
def healthz():
    return {"ok": True, "time": datetime.now(UTC).isoformat()}

#
# Authentication endpoints
#
@app.post("/login")
def login(response: Response, username: str = Form(...), password: str = Form(...)):
    _cleanup_sessions()
    user_doc = users_col.find_one({"username": username})
    if not user_doc:
        raise HTTPException(status_code=401, detail="Invalid credentials")

    stored_hash = user_doc.get("passwordHash")
    if not stored_hash:
        raise HTTPException(status_code=401, detail="Invalid credentials")

    stored_hash_bytes = stored_hash.encode() if isinstance(stored_hash, str) else stored_hash
    if not bcrypt.checkpw(password.encode(), stored_hash_bytes):
        raise HTTPException(status_code=401, detail="Invalid credentials")

    if user_doc.get("status") != "active":
        raise HTTPException(status_code=403, detail="Account not active/approved")

    token = create_session(user_doc)
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=token,
        httponly=True,
        max_age=int(SESSION_TTL.total_seconds()),
        samesite="lax",
        path="/",
    )
    return {"message": "Logged in", "role": user_doc.get("role", "user"), "username": username}

@app.post("/logout")
def logout(response: Response, request: Request):
    token = request.cookies.get(SESSION_COOKIE_NAME)
    if token and token in SESSIONS:
        del SESSIONS[token]
    response.delete_cookie(SESSION_COOKIE_NAME)
    return {"message": "Logged out"}

#
# Metadata endpoints
#
@app.get("/metadata/diseases")
def list_diseases():
    diseases = sorted(cases_col.distinct("disease"))
    return {"diseases": diseases}

@app.get("/metadata/districts")
def list_districts():
    districts = sorted(cases_col.distinct("district"))
    return {"districts": districts}

@app.get("/metadata")
def combined_metadata():
    diseases = sorted(cases_col.distinct("disease"))
    districts = sorted(cases_col.distinct("district"))
    pipeline = [{"$group": {"_id": {"disease": "$disease", "district": "$district"}}}]
    combos = list(cases_col.aggregate(pipeline))
    existing_combinations = [{"disease": c["_id"]["disease"], "district": c["_id"]["district"]} for c in combos]
    return {"diseases": diseases, "districts": districts, "existing_combinations": existing_combinations}

#
# Raw case counts endpoint
#
@app.get("/cases/{disease}/{district}")
def get_case_timeseries(disease: str, district: str, days: int = Query(30, ge=1, le=365)):
    now = datetime.now(UTC)
    start = now - timedelta(days=days)
    cursor = cases_col.find(
        {"disease": disease, "district": district, "date": {"$gte": start, "$lte": now}}
    ).sort("date", 1)

    data = [{"date": d.get("date"), "count": d.get("count", 0), "lastModified": d.get("lastModified")} for d in cursor]
    if not data:
        raise HTTPException(status_code=404, detail="No case data found")
    return {"cases": data}

#
# Alerts endpoint
#
@app.get("/alerts")
def list_alerts(
    disease: Optional[str] = Query(None, description="Filter by disease"),
    district: Optional[str] = Query(None, description="Filter by district"),
    since_days: int = Query(30, ge=1, le=365, description="Lookback window in days"),
    limit: int = Query(20, ge=1, le=200),
    skip: int = Query(0, ge=0, le=5000),
    withTotal: bool = Query(False, description="Return total count alongside items"),
):
    """
    Returns recent alerts with optional filters & pagination.
    Output includes both 'alerts' and 'items' keys for frontend compatibility.
    """
    try:
        q: Dict[str, Any] = {}
        if disease:
            q["disease"] = disease
        if district:
            q["district"] = district

        # Lower bound: UTC midnight N days ago
        now = datetime.now(UTC)
        since_dt = datetime(now.year, now.month, now.day, tzinfo=UTC) - timedelta(days=since_days)
        q["date"] = {"$gte": since_dt}

        cursor = (
            alerts_col.find(q)
            .sort([("date", -1), ("createdAt", -1)])
            .skip(skip)
            .limit(limit)
        )
        raw = list(cursor)

        # Sanitize Mongo docs
        def _ser(d: Dict[str, Any]) -> Dict[str, Any]:
            return {
                "id": str(d.get("_id")) if d.get("_id") else None,
                "disease": d.get("disease"),
                "district": d.get("district"),
                "date": d.get("date").isoformat() if d.get("date") else None,
                "today": int(d.get("today", 0) or 0),
                "yesterday": int(d.get("yesterday", 0) or 0),
                "pct_change": float(d.get("pct_change", 0.0) or 0.0),
                "rule": d.get("rule", {}),
                "createdAt": d.get("createdAt").isoformat() if d.get("createdAt") else None,
                "lastUpdatedAt": d.get("lastUpdatedAt").isoformat() if d.get("lastUpdatedAt") else None,
            }

        items = [_ser(d) for d in raw]
        payload: Dict[str, Any] = {
            "alerts": items,   # for existing UI
            "items": items,    # for future UI
            "limit": limit,
            "skip": skip,
        }
        if _coerce_bool(withTotal, False):
            payload["total"] = alerts_col.count_documents(q)

        return payload
    except Exception as e:
        logger.exception("Failed to list alerts")
        raise HTTPException(status_code=500, detail=f"Failed to fetch alerts: {e}")

# Forecast endpoints (public and protected)
@app.get("/public/forecasts/{disease}/{district}")
def public_forecast(
    disease: str,
    district: str,
    refresh: bool = Query(False, description="Force regeneration"),
    response: Response = None,
):
    payload = _retrieve_forecast_and_cache(disease.strip(), district.strip(), refresh=refresh)
    # Mark cache status for middleware & DevTools
    if response is not None:
        response.headers["X-Cache"] = "HIT" if payload.get("cached") else "MISS"
    return payload

@app.get("/forecasts/{disease}/{district}")
def protected_forecast(
    disease: str,
    district: str,
    refresh: bool = Query(False, description="Force regeneration"),
    user=Depends(get_current_user),
    response: Response = None,
):
    _cleanup_sessions()
    payload = _retrieve_forecast_and_cache(disease.strip(), district.strip(), refresh=refresh)
    if response is not None:
        response.headers["X-Cache"] = "HIT" if payload.get("cached") else "MISS"
    return payload

# Metrics endpoint (for screenshots / tables)
@app.get("/metrics")
def metrics():
    out = {}
    for k, m in METRICS.items():
        sv = sorted(m["lat"])
        p50 = _percentile(sv, 50) or 0.0
        p95 = _percentile(sv, 95) or 0.0
        denom = max(1, m["hits"] + m["misses"])
        out[k] = {
            "requests": m["n"],
            "hits": m["hits"],
            "misses": m["misses"],
            "hit_rate": round(m["hits"] / denom, 3),
            "p50_ms": round(p50, 1),
            "p95_ms": round(p95, 1),
        }
    return out

# Admin: ML retraining endpoints (Prophet/ARIMA/LSTM)
@app.post("/admin/forecasts/retrain-all")
def admin_retrain_all(user=Depends(get_current_user)):
    _require_admin(user)
    try:
        processed = run_all_forecasts()
        return {"message": "Batch retrain completed", "pairs_processed": processed}
    except Exception as e:
        logger.exception("Batch ML retrain failed")
        raise HTTPException(status_code=500, detail=f"Batch retrain failed: {e}")

@app.post("/admin/forecasts/{disease}/{district}/retrain")
def admin_retrain_one(disease: str, district: str, user=Depends(get_current_user)):
    _require_admin(user)
    try:
        result = run_single_forecast(disease.strip(), district.strip())
        return {"message": "Retrained", "disease": disease, "district": district, "result": _sanitize_numbers(result)}
    except Exception as e:
        logger.exception("Single ML retrain failed")
        raise HTTPException(status_code=500, detail=f"Retrain failed: {e}")