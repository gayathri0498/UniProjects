# forecast_worker.py — ML-enabled worker (Prophet/ARIMA/LSTM by default; SES/naive fallback)
import os
import json
import logging
import signal
from datetime import datetime, timezone, timedelta

from kafka import KafkaConsumer
from dotenv import load_dotenv

# Env & logging
load_dotenv()

logging.basicConfig(
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    level=logging.INFO,
)
log = logging.getLogger("forecast_worker")

# Core env
KAFKA_BOOTSTRAP   = os.getenv("KAFKA_BOOTSTRAP", "localhost:29092")
FORECAST_TOPIC    = os.getenv("FORECAST_TOPIC", "disease.forecasts.recompute")
FORECAST_GROUP_ID = os.getenv("FORECAST_GROUP_ID", "forecast_workers")
WORKER_MODEL_MODE = os.getenv("FORECAST_WORKER_MODEL", "ml").strip().lower()

# Kafka liveness/tuning
SESSION_TIMEOUT_MS     = int(os.getenv("KAFKA_SESSION_TIMEOUT_MS",    "30000"))   # 30s
HEARTBEAT_INTERVAL_MS  = int(os.getenv("KAFKA_HEARTBEAT_INTERVAL_MS", "10000"))  # 10s
MAX_POLL_INTERVAL_MS   = int(os.getenv("KAFKA_MAX_POLL_INTERVAL_MS",  "900000")) # 15 min (ML can be slow)
FETCH_MAX_WAIT_MS      = int(os.getenv("KAFKA_FETCH_MAX_WAIT_MS",     "500"))
REQUEST_TIMEOUT_MS_ENV = int(os.getenv("KAFKA_REQUEST_TIMEOUT_MS",    "120000")) # 120s default

# Ensure request_timeout_ms > session_timeout_ms
REQUEST_TIMEOUT_MS = max(REQUEST_TIMEOUT_MS_ENV, SESSION_TIMEOUT_MS + 10000)

# Optional: SES/naive fallback
USE_SES_FALLBACK = (WORKER_MODEL_MODE == "ses")

if USE_SES_FALLBACK:
    from pymongo import MongoClient, ASCENDING

    MONGO_URI = os.getenv("MONGO_URI")
    MONGO_DB  = os.getenv("MONGO_DB", "epidemics")
    if not MONGO_URI:
        raise RuntimeError("MONGO_URI missing (required for SES fallback mode)")

    client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=5000, tz_aware=True)
    db = client[MONGO_DB]
    cases_col = db["cases"]
    forecasts_col = db["forecasts"]

    # Touch the server early
    client.server_info()

    # Indexes
    try:
        cases_col.create_index([("disease", 1), ("district", 1), ("date", 1)], unique=True)
        forecasts_col.create_index([("disease", 1), ("district", 1)], unique=True)
        forecasts_col.create_index([("updatedAt", -1)])
    except Exception as e:
        log.warning("Index creation warning: %s", e)

    def _utc_midnight(dt):
        dt = dt.astimezone(timezone.utc)
        return datetime(dt.year, dt.month, dt.day, tzinfo=timezone.utc)

    def _coerce_nonneg_int(x):
        try:
            v = int(x)
            return v if v >= 0 else 0
        except Exception:
            return 0

    def _naive_ma(values, horizon, window=7):
        vals = [float(max(0, v)) for v in values]
        out  = []
        for _ in range(horizon):
            tail = vals[-window:] if len(vals) >= window else vals
            mean = (sum(tail) / max(len(tail), 1)) if tail else 0.0
            mean = round(float(mean), 2)
            out.append(mean)
            vals.append(mean)
        return out

    def _pick_alpha(default_window=7) -> float:
        env_alpha = os.getenv("SES_ALPHA", "").strip()
        try:
            a = float(env_alpha)
            if 0.0 < a <= 1.0:
                return a
        except Exception:
            pass
        return round(2.0 / (default_window + 1.0), 4)  # N=7 → 0.25

    def _ses(values, horizon, alpha=0.5):
        vals = [float(max(0, v)) for v in values]
        if not vals:
            return [0.0] * horizon
        level = float(vals[0])
        for v in vals[1:]:
            level = alpha * float(v) + (1.0 - alpha) * level
        level = max(0.0, round(level, 2))
        return [level] * horizon

    def compute_and_save_ses_or_naive(disease: str, district: str):
        now = datetime.now(timezone.utc)
        lookback_days = int(os.getenv("FORECAST_LOOKBACK_D", "60"))
        horizon       = int(os.getenv("FORECAST_HORIZON_D", "7"))

        since = _utc_midnight(now - timedelta(days=lookback_days))
        cur = cases_col.find(
            {"disease": disease, "district": district, "date": {"$gte": since}}
        ).sort("date", ASCENDING)

        history = [(doc["date"], _coerce_nonneg_int(doc.get("count", 0))) for doc in cur]
        start_day = _utc_midnight(now)

        if not history:
            meta = {
                "history_points": 0,
                "last_history_date": None,
                "generated_at": now.isoformat(),
                "lookback_days": lookback_days,
                "horizon_days": horizon,
            }
            preds = []
            model = "naive-7d"
        else:
            values = [c for _, c in history]
            if len(values) >= 7:
                alpha = _pick_alpha(default_window=7)
                yhat  = _ses(values, horizon, alpha)
                band  = 0.10
                model = f"ses-{alpha}"
            else:
                yhat  = _naive_ma(values, horizon, window=7)
                band  = 0.00
                model = "naive-7d"

            preds = []
            for i, m in enumerate(yhat, start=1):
                ds = (start_day + timedelta(days=i)).date().isoformat()
                lo = max(0.0, round(m * (1 - band), 2))
                hi = round(m * (1 + band), 2)
                preds.append({"ds": ds, "yhat": m, "yhat_lower": lo, "yhat_upper": hi})

            meta = {
                "history_points": len(values),
                "last_history_date": history[-1][0].isoformat(),
                "generated_at": now.isoformat(),
                "lookback_days": lookback_days,
                "horizon_days": horizon,
            }

        forecasts_col.update_one(
            {"disease": disease, "district": district},
            {
                "$set": {
                    "predictions": preds,
                    "model": model,
                    "meta": meta,
                    "runDate": now,
                    "generated_with": f"forecast_worker:{model}",
                    "updatedAt": now,
                },
                "$setOnInsert": {"disease": disease, "district": district, "createdAt": now},
            },
            upsert=True,
        )
        log.info("Forecast updated → %s/%s (%s) | preds=%d", disease, district, model, len(preds))

# ML path: call your Prophet/ARIMA/LSTM pipeline
if not USE_SES_FALLBACK:
    try:
        # Uses Mongo and model selection internally; writes forecast doc to the "forecasts" collection
        from forecast_service import run_single_forecast
    except Exception as e:
        log.exception("Failed to import run_single_forecast from forecast_service: %s", e)
        raise

    # Early clarity: if MONGO_URI is missing, the ML service likely cannot persist results
    if not os.getenv("MONGO_URI"):
        log.warning("MONGO_URI is not set. The ML pipeline in forecast_service will likely fail to save forecasts.")

# Job processing
def _parse_job(value):
    """Return (disease, district) or (None, None) if invalid."""
    try:
        payload = value or {}
        disease  = (payload.get("disease") or "").strip()
        district = (payload.get("district") or "").strip()
        if not disease or not district:
            return None, None
        return disease, district
    except Exception:
        return None, None

def process_job(disease: str, district: str):
    if USE_SES_FALLBACK:
        log.info("Processing job with SES/naive → %s / %s", disease, district)
        compute_and_save_ses_or_naive(disease, district)
    else:
        log.info("Processing job with ML pipeline → %s / %s", disease, district)
        run_single_forecast(disease, district)
        log.info("ML forecast updated → %s/%s", disease, district)

# Main consumer loop
_running = True

def _handle_signal(signum, frame):
    global _running
    log.info("Received signal %s — shutting down...", signum)
    _running = False

# Signals
try:
    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)
except Exception:
    pass

def main():
    log.info(
        "Starting Forecast Worker | mode=%s | bootstrap=%s | topic=%s",
        "ML" if not USE_SES_FALLBACK else "SES",
        KAFKA_BOOTSTRAP,
        FORECAST_TOPIC,
    )
    log.info(
        "Kafka timings: session_timeout_ms=%d, heartbeat_interval_ms=%d, "
        "max_poll_interval_ms=%d, request_timeout_ms=%d, fetch_max_wait_ms=%d",
        SESSION_TIMEOUT_MS, HEARTBEAT_INTERVAL_MS, MAX_POLL_INTERVAL_MS, REQUEST_TIMEOUT_MS, FETCH_MAX_WAIT_MS
    )

    consumer = KafkaConsumer(
        FORECAST_TOPIC,
        bootstrap_servers=KAFKA_BOOTSTRAP.split(","),
        group_id=FORECAST_GROUP_ID,
        enable_auto_commit=True,
        auto_offset_reset="earliest",
        value_deserializer=lambda v: json.loads(v.decode("utf-8")),
        client_id="rtess-forecast-worker",
        api_version_auto_timeout_ms=10000,
        session_timeout_ms=SESSION_TIMEOUT_MS,
        heartbeat_interval_ms=HEARTBEAT_INTERVAL_MS,
        max_poll_interval_ms=MAX_POLL_INTERVAL_MS,
        fetch_max_wait_ms=FETCH_MAX_WAIT_MS,
        request_timeout_ms=REQUEST_TIMEOUT_MS,
    )

    log.info(
        "Forecast worker ready (mode=%s) — listening on '%s'",
        "ML" if not USE_SES_FALLBACK else "SES",
        FORECAST_TOPIC,
    )

    try:
        while _running:
            records = consumer.poll(timeout_ms=1000, max_records=50)
            if not records:
                continue

            for tp, msgs in records.items():
                for msg in msgs:
                    try:
                        disease, district = _parse_job(msg.value)
                        if not disease or not district:
                            log.warning("Skipping bad forecast payload: %s", msg.value)
                            continue
                        process_job(disease, district)
                    except Exception as e:
                        log.exception(
                            "Error processing message at %s:%s offset %s: %s",
                            tp.topic, tp.partition, msg.offset, e
                        )
    except Exception as e:
        log.exception("Fatal error in consumer loop: %s", e)
    finally:
        try:
            consumer.close()
        except Exception:
            pass
        log.info("Forecast worker stopped.")

if __name__ == "__main__":
    main()