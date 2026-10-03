# scripts/migrate_lock_model.py
import os
import sys
import math
import traceback
from datetime import datetime, date, timezone, timedelta

from pymongo import MongoClient, ASCENDING, errors
from dotenv import load_dotenv

load_dotenv()
MONGO_URI = os.getenv("MONGO_URI")
MONGO_DB  = os.getenv("MONGO_DB", "epidemics")

if not MONGO_URI:
    print("❌ MONGO_URI missing in .env")
    sys.exit(1)

UTC = timezone.utc

def to_midnight_utc(dt_like):
    """Return tz-aware datetime at UTC midnight, or None if unparseable."""
    if dt_like is None:
        return None

    if isinstance(dt_like, datetime):
        # normalize to UTC
        dt = dt_like if dt_like.tzinfo else dt_like.replace(tzinfo=UTC)
        dt = dt.astimezone(UTC)
        return datetime(dt.year, dt.month, dt.day, 0, 0, 0, tzinfo=UTC)
    if isinstance(dt_like, date):
        return datetime(dt_like.year, dt_like.month, dt_like.day, 0, 0, 0, tzinfo=UTC)
    if isinstance(dt_like, str):
        s = dt_like.strip()
        try:
            if len(s) == 10 and s[4] == "-" and s[7] == "-":
                y, m, d = [int(x) for x in s.split("-")]
                return datetime(y, m, d, 0, 0, 0, tzinfo=UTC)
        except Exception:
            pass
        # try ISO forms
        try:
            s_iso = s.replace("Z", "+00:00")
            dt = datetime.fromisoformat(s_iso)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=UTC)
            else:
                dt = dt.astimezone(UTC)
            return datetime(dt.year, dt.month, dt.day, 0, 0, 0, tzinfo=UTC)
        except Exception:
            return None

    # Unsupported type
    return None


def migrate_cases(cases_col):
    """
    Make cases.date tz-aware UTC midnight, merging any duplicates.
    """
    print("\n— Migrating 'cases' —")
    total = 0
    changed = 0
    merged = 0
    errors_count = 0
    cursor = cases_col.find({}, projection={"_id": 1, "disease": 1, "district": 1, "date": 1, "count": 1})

    for doc in cursor:
        total += 1
        _id = doc["_id"]
        disease = doc.get("disease")
        district = doc.get("district")
        old_date = doc.get("date")
        count = int(doc.get("count", 0) or 0)

        norm = to_midnight_utc(old_date)
        if norm is None:
            print(f"  ! Skipping _id={_id} due to unparseable date: {old_date!r}")
            errors_count += 1
            continue

        if isinstance(old_date, datetime) and old_date.tzinfo is not None:
            od = old_date.astimezone(UTC)
            if od.year == norm.year and od.month == norm.month and od.day == norm.day and od.hour == 0 and od.minute == 0 and od.second == 0:
                continue

        try:
            res = cases_col.update_one(
                {"disease": disease, "district": district, "date": norm},
                {"$inc": {"count": count}, "$setOnInsert": {"lastModified": datetime.now(UTC)}},
                upsert=True
            )
            # If key changed, delete original
            cases_col.delete_one({"_id": _id})
            changed += 1
            if res.upserted_id is None:
                merged += 1
        except Exception:
            traceback.print_exc()
            errors_count += 1

    print(f"cases: scanned={total}, normalized={changed}, merged={merged}, errors={errors_count}")


def migrate_alerts(alerts_col):
    """
    Make alerts.date tz-aware UTC midnight, merging duplicates by keeping max today's values.
    """
    print("\n— Migrating 'alerts' —")
    total = 0
    changed = 0
    merged = 0
    errors_count = 0

    cursor = alerts_col.find({}, projection={"_id": 1, "disease": 1, "district": 1, "date": 1,
                                             "today": 1, "yesterday": 1, "pct_change": 1,
                                             "createdAt": 1, "lastUpdatedAt": 1, "rule": 1})
    for doc in cursor:
        total += 1
        _id = doc["_id"]
        disease = doc.get("disease")
        district = doc.get("district")
        old_date = doc.get("date")

        today = int(doc.get("today", 0) or 0)
        yest  = int(doc.get("yesterday", 0) or 0)
        pct   = float(doc.get("pct_change", 0.0) or 0.0)
        createdAt = doc.get("createdAt")
        lastUpdatedAt = doc.get("lastUpdatedAt")
        rule = doc.get("rule") or {}

        norm = to_midnight_utc(old_date)
        if norm is None:
            print(f"  ! Skipping _id={_id} due to unparseable date: {old_date!r}")
            errors_count += 1
            continue

        # Skip if already normalized midnight UTC
        if isinstance(old_date, datetime) and old_date.tzinfo is not None:
            od = old_date.astimezone(UTC)
            if od.year == norm.year and od.month == norm.month and od.day == norm.day and od.hour == 0 and od.minute == 0 and od.second == 0:
                continue

        try:
            alerts_col.update_one(
                {"disease": disease, "district": district, "date": norm},
                {
                    "$max": {
                        "today": today,
                        "yesterday": yest,
                        "pct_change": pct,
                        "lastUpdatedAt": lastUpdatedAt or datetime.now(UTC),
                    },
                    "$setOnInsert": {
                        "createdAt": createdAt or datetime.now(UTC),
                        "rule": rule,
                        "disease": disease,
                        "district": district,
                        "date": norm,
                    }
                },
                upsert=True
            )
            alerts_col.delete_one({"_id": _id})
            changed += 1
            merged += 1
        except Exception:
            traceback.print_exc()
            errors_count += 1

    print(f"alerts: scanned={total}, normalized/merged={changed}, errors={errors_count}")


def create_indexes(db):
    print("\n— Creating indexes —")
    cases = db["cases"]
    alerts = db["alerts"]
    config = db["config"]
    events = db["events"]
    users  = db["users"]
    patients = db["patients"]

    # Drop old non-unique indexes that could conflict
    try:
        for idx in cases.list_indexes():
            pass
    except Exception:
        pass

    # Create fresh indexes (idempotent)
    try:
        cases.create_index([("disease", ASCENDING), ("district", ASCENDING), ("date", ASCENDING)], unique=True)
        print("✓ cases(disease,district,date) unique")
    except errors.PyMongoError as e:
        print("! cases unique index:", e)

    try:
        alerts.create_index([("disease", ASCENDING), ("district", ASCENDING), ("date", ASCENDING)], unique=True)
        alerts.create_index([("createdAt", -1)])
        print("✓ alerts(disease,district,date) unique + createdAt")
    except errors.PyMongoError as e:
        print("! alerts indexes:", e)

    try:
        config.create_index([("disease", ASCENDING)], unique=True)
        print("✓ config(disease) unique")
    except errors.PyMongoError as e:
        print("! config index:", e)

    # Optional helpful indexes (not required)
    try:
        users.create_index([("username", ASCENDING)], unique=True)
    except Exception:
        pass

    try:
        patients.create_index([("hospitalId", ASCENDING), ("diagnosisDate", -1)])
    except Exception:
        pass
    try:
        pass
    except Exception:
        pass


def main():
    client = MongoClient(MONGO_URI, tz_aware=True, serverSelectionTimeoutMS=5000)
    db = client[MONGO_DB]
    client.server_info()  # verify connection

    migrate_cases(db["cases"])
    migrate_alerts(db["alerts"])
    create_indexes(db)

    print("\n✅ Migration complete. You can now restart your workers.")
    print("   Tip: open Compass and confirm dates show at 00:00:00 (UTC) and indexes are present.")


if __name__ == "__main__":
    main()