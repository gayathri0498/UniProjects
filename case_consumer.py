# case_consumer.py

import os
import json
import logging
import time
from collections import deque
from datetime import datetime, timedelta, timezone

from kafka import KafkaConsumer, KafkaProducer
from pymongo import MongoClient, errors, ReturnDocument
from pymongo.errors import DuplicateKeyError
from dotenv import load_dotenv

# 1) Env & logging
load_dotenv()
logging.basicConfig(
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    level=logging.INFO,
)

MONGO_URI           = os.getenv("MONGO_URI")
KAFKA_BOOTSTRAP     = os.getenv("KAFKA_BOOTSTRAP", "localhost:29092")  # host container port
KAFKA_TOPIC         = os.getenv("KAFKA_TOPIC", "disease.cases")
KAFKA_GROUP_ID      = os.getenv("KAFKA_GROUP_ID", "case_consumers")
KAFKA_CLIENT_ID     = os.getenv("KAFKA_CLIENT_ID", "rtess-case-consumer")
THRESHOLD_RELOAD_H  = int(os.getenv("THRESHOLD_RELOAD_H", "1"))

# Auto-forecast settings
FORECAST_TOPIC      = os.getenv("FORECAST_TOPIC", "disease.forecasts.recompute")
FORECAST_COOLDOWN_S = int(os.getenv("FORECAST_COOLDOWN_S", "60"))

# Latency logging toggle (set DEBUG_LATENCY=0 to silence [LAT] logs)
DEBUG_LATENCY       = os.getenv("DEBUG_LATENCY", "1") == "1"
E2E_WINDOW          = int(os.getenv("E2E_WINDOW", "200"))  # rolling window for p50/p95

if not MONGO_URI:
    raise RuntimeError("MONGO_URI is not set in .env")

# 2) Mongo and indexes
try:
    client     = MongoClient(MONGO_URI, serverSelectionTimeoutMS=5000, tz_aware=True)
    db         = client["epidemics"]
    cases_col  = db["cases"]
    alerts_col = db["alerts"]
    config_col = db["config"]
    events_col = db["events"]  # idempotency for incoming events
    client.server_info()       # verify connection

    # Idempotent indexes
    try:
        cases_col.create_index([("disease", 1), ("district", 1), ("date", 1)], unique=True)
        alerts_col.create_index([("disease", 1), ("district", 1), ("date", 1)], unique=True)
        alerts_col.create_index([("createdAt", -1)])
        config_col.create_index([("disease", 1)], unique=True)
    except Exception as idx_err:
        logging.warning("Index creation warning: %s", idx_err)
except errors.PyMongoError as e:
    logging.critical("Cannot connect to MongoDB: %s", e)
    raise

# 3) Thresholds loader
def load_thresholds():
    rules = {}
    try:
        for cfg in config_col.find():
            d = cfg.get("disease")
            if not d:
                continue
            rules[d] = {
                "pct": int(cfg.get("thresholdPct", 20)),
                "min": int(cfg.get("minCases", 5)),
            }
        logging.info("Loaded thresholds for %d diseases", len(rules))
    except errors.PyMongoError as e:
        logging.error("Error loading thresholds: %s", e)
    return rules

thresholds      = load_thresholds()
_last_reload_ts = datetime.now(timezone.utc)

# 4) Helpers
def to_utc_midnight_bucket(ts_str: str) -> datetime:
    """Return tz-aware UTC midnight datetime bucket for the given ISO timestamp."""
    try:
        ts = datetime.fromisoformat((ts_str or "").replace("Z", "+00:00"))
        ts = (ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)).astimezone(timezone.utc)
    except Exception:
        ts = datetime.now(timezone.utc)
    return datetime(ts.year, ts.month, ts.day, 0, 0, 0, tzinfo=timezone.utc)

# Latency math
_e2e_samples_ms: deque[int] = deque(maxlen=E2E_WINDOW)

def _percentile(sorted_vals, p):
    if not sorted_vals:
        return None
    k = (len(sorted_vals) - 1) * (p / 100.0)
    f = int(k)
    c = min(f + 1, len(sorted_vals) - 1)
    if f == c:
        return sorted_vals[int(k)]
    d0 = sorted_vals[f] * (c - k)
    d1 = sorted_vals[c] * (k - f)
    return d0 + d1

def _now_ms_utc() -> int:
    return int(time.time() * 1000)

def _iso_utc_from_ms(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

# 5) Kafka consumer + producer
consumer = KafkaConsumer(
    KAFKA_TOPIC,
    bootstrap_servers=KAFKA_BOOTSTRAP.split(","),
    auto_offset_reset="earliest",
    group_id=KAFKA_GROUP_ID,
    enable_auto_commit=True,
    client_id=KAFKA_CLIENT_ID,
)
logging.info("Listening for '%s' on %s", KAFKA_TOPIC, KAFKA_BOOTSTRAP)

try:
    producer = KafkaProducer(
        bootstrap_servers=KAFKA_BOOTSTRAP.split(","),
        value_serializer=lambda v: json.dumps(v).encode("utf-8"),
        key_serializer=lambda k: (k or "").encode("utf-8"),
        linger_ms=50,
        retries=3,
        client_id=KAFKA_CLIENT_ID + "-producer",
    )
    _producer_ok = True
    logging.info("Forecast producer connected → topic '%s'", FORECAST_TOPIC)
except Exception as e:
    producer = None
    _producer_ok = False
    logging.warning("Forecast producer disabled: %s", e)

_last_forecast_emit = {}  # (disease, district) -> datetime

def maybe_emit_forecast_job(disease: str, district: str, now: datetime):
    """Debounced emit so we don't spam forecast recomputes while bulk-inserting."""
    if not _producer_ok:
        return
    key = (disease, district)
    last = _last_forecast_emit.get(key)
    if last and (now - last).total_seconds() < FORECAST_COOLDOWN_S:
        return
    payload = {"disease": disease, "district": district, "trigger": "cases_updated", "ts": now.isoformat()}
    try:
        producer.send(FORECAST_TOPIC, key=f"{disease}:{district}", value=payload)
        producer.flush(1)
        _last_forecast_emit[key] = now
        logging.info("Emitted forecast job → %s [%s/%s]", FORECAST_TOPIC, disease, district)
    except Exception as e:
        logging.warning("Failed to emit forecast job: %s", e)

# 6) Main consume loop
try:
    for raw in consumer:
        # Periodic threshold reload
        now = datetime.now(timezone.utc)
        if (now - _last_reload_ts) >= timedelta(hours=THRESHOLD_RELOAD_H):
            thresholds      = load_thresholds()
            _last_reload_ts = now

        # Parse JSON event
        try:
            payload = raw.value.decode("utf-8")
            data    = json.loads(payload)
        except Exception as e:
            logging.warning(
                "Skipping bad message: %s → %s",
                getattr(raw, "value", b"").decode("utf-8", "ignore"),
                e,
            )
            continue

        # Validate
        disease   = data.get("disease")
        district  = data.get("district")
        ts_str    = data.get("timestamp")
        # event id may be at root OR inside _latency
        event_id  = data.get("eventId") or (data.get("_latency") or {}).get("eventId")
        action    = (data.get("action") or "inc").lower().strip()

        if not (disease and district and ts_str):
            logging.warning("Missing keys, skipping: %s", data)
            continue

        # Idempotency (skip duplicate eventIds)
        if event_id:
            try:
                events_col.insert_one({"_id": event_id, "ts": now})
            except DuplicateKeyError:
                logging.info("Duplicate eventId %s, skipping", event_id)
                continue

        # UTC day bucket (tz-aware datetime)
        date_key = to_utc_midnight_bucket(ts_str)

        # Increment / Decrement daily count
        delta = 1 if action == "inc" else -1 if action == "dec" else 1
        try:
            updated = cases_col.find_one_and_update(
                {"disease": disease, "district": district, "date": date_key},
                {"$inc": {"count": delta}, "$set": {"lastModified": now}},
                upsert=True,
                return_document=ReturnDocument.AFTER,
            )
            if (updated or {}).get("count", 0) < 0:
                # Clamp to zero if dec pushed negative
                cases_col.update_one(
                    {"disease": disease, "district": district, "date": date_key},
                    {"$set": {"count": 0, "lastModified": now}},
                )
        except errors.PyMongoError as e:
            logging.error("Failed updating cases for %s/%s: %s", disease, district, e)
            continue
        # t3 + End-to-End latency (t0→t3) measurement
        if DEBUG_LATENCY:
            lat = (data.get("_latency") or {}) if isinstance(data, dict) else {}
            # Prefer nested eventId; fall back to root; default "NA"
            _event_id = lat.get("eventId") or event_id or "NA"
            t0 = lat.get("t0")  # ms since epoch from client
            t3_ms = _now_ms_utc()
            t3_iso = _iso_utc_from_ms(t3_ms)
            if t0 is not None:
                try:
                    e2e = t3_ms - int(t0)
                    _e2e_samples_ms.append(e2e)
                    logging.info("[LAT] %s t3=%s E2E=%dms (consumer persisted)", _event_id, t3_iso, e2e)
                except Exception:
                    logging.info("[LAT] %s t3=%s (bad t0)", _event_id, t3_iso)
            else:
                logging.info("[LAT] %s t3=%s (no t0 present)", _event_id, t3_iso)

            # Periodic summary
            n = len(_e2e_samples_ms)
            if n and (n % 25 == 0):
                sv = sorted(_e2e_samples_ms)
                p50 = int(_percentile(sv, 50))
                p95 = int(_percentile(sv, 95))
                logging.info("[LAT-SUMMARY] last %d events → p50=%dms, p95=%dms", n, p50, p95)

        # Read today / yesterday to compute pct change
        try:
            today_doc     = cases_col.find_one({"disease": disease, "district": district, "date": date_key}) or {}
            yesterday_dt  = date_key - timedelta(days=1)
            yesterday_doc = cases_col.find_one({"disease": disease, "district": district, "date": yesterday_dt}) or {}
        except errors.PyMongoError as e:
            logging.error("Failed fetching counts for %s/%s: %s", disease, district, e)
            continue

        today_count = int(today_doc.get("count", 0))
        yest_count  = int(yesterday_doc.get("count", 0))
        pct_change  = ((today_count - yest_count) / max(yest_count, 1)) * 100.0

        # Threshold evaluation → keep alert doc up-to-date (one per disease/district/day)
        if action == "inc":
            cfg = thresholds.get(disease, {"pct": 20, "min": 5})
            # ⬇⬇ FIXED: removed stray ']' at end of line
            if today_count >= cfg["min"] and pct_change >= cfg["pct"]:
                try:
                    alerts_col.update_one(
                        {"disease": disease, "district": district, "date": date_key},
                        {
                            "$set": {
                                "today":         today_count,
                                "yesterday":     yest_count,
                                "pct_change":    pct_change,
                                "rule":          {"minCases": cfg["min"], "thresholdPct": cfg["pct"]},
                                "lastUpdatedAt": now,
                            },
                            "$setOnInsert": {
                                "createdAt": now,
                                "disease": disease,
                                "district": district,
                                "date": date_key,
                            },
                        },
                        upsert=True,
                    )
                    logging.warning("🚨 Alert: %s/%s %d (+%.1f%%)", disease, district, today_count, pct_change)
                except errors.PyMongoError as e:
                    logging.error("Failed inserting/updating alert: %s", e)
            else:
                logging.info(
                    "%s/%s = %d (%.1f%% change) [min=%d, pct=%d]",
                    disease, district, today_count, pct_change, cfg.get("min", 5), cfg.get("pct", 20),
                )

        # Emit forecast recompute whenever cases change
        maybe_emit_forecast_job(disease, district, now)

except KeyboardInterrupt:
    logging.info("Shutting down consumer...")

finally:
    try:
        if producer:
            producer.flush(2)
            producer.close()
    except Exception:
        pass
    try:
        consumer.close()
    except Exception:
        pass
    try:
        client.close()
    except Exception:
        pass
    logging.info("Bye.")