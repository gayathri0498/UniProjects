# scripts/forecast_emit_all.py

import os
import sys
import json
import argparse
from datetime import datetime, timedelta, timezone

from pymongo import MongoClient
from pymongo.errors import PyMongoError
from kafka import KafkaProducer, errors as kerrors
from dotenv import load_dotenv


def parse_args():
    p = argparse.ArgumentParser(
        description="Emit forecast recompute jobs for all (or filtered) disease/district combos."
    )
    p.add_argument("--mongo-uri", default=None, help="MongoDB URI (overrides MONGO_URI)")
    p.add_argument("--bootstrap", default=None, help="Kafka bootstrap servers (overrides KAFKA_BOOTSTRAP)")
    p.add_argument("--topic", default=None, help="Forecast topic (overrides FORECAST_TOPIC)")

    p.add_argument("--disease", nargs="*", help="Filter by disease(s), e.g. --disease Dengue Influenza")
    p.add_argument("--district", nargs="*", help="Filter by district(s), e.g. --district Chennai Dindigul")
    p.add_argument("--since-days", type=int, default=None,
                   help="Only include combos that have cases since N days ago (optional)")
    p.add_argument("--limit", type=int, default=None, help="Limit number of messages (for testing)")
    p.add_argument("--dry-run", action="store_true", help="List what would be sent, do not publish")
    p.add_argument("--verbose", action="store_true", help="Verbose output")
    return p.parse_args()


def main():
    load_dotenv()  # load .env

    args = parse_args()

    MONGO_URI = args.mongo_uri or os.getenv("MONGO_URI")
    if not MONGO_URI:
        print("ERROR: MONGO_URI not set (env or --mongo-uri).", file=sys.stderr)
        sys.exit(2)

    BOOT = args.bootstrap or os.getenv("KAFKA_BOOTSTRAP", "localhost:29092")
    TOP  = args.topic or os.getenv("FORECAST_TOPIC", "disease.forecasts.recompute")

    # --- Mongo connection ---
    try:
        client = MongoClient(MONGO_URI, tz_aware=True, serverSelectionTimeoutMS=5000)
        db = client["epidemics"]
        cases = db["cases"]
        client.server_info()  # force connection
    except PyMongoError as e:
        print(f"ERROR: Mongo connection failed: {e}", file=sys.stderr)
        sys.exit(3)

    # --- Build aggregation pipeline with optional filters ---
    match = {}
    if args.disease:
        match["disease"] = {"$in": args.disease}
    if args.district:
        match["district"] = {"$in": args.district}
    if args.since_days:
        since = (datetime.now(timezone.utc) - timedelta(days=args.since_days)).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        match["date"] = {"$gte": since}

    pipeline = []
    if match:
        pipeline.append({"$match": match})

    pipeline.extend([
        {"$group": {"_id": {"disease": "$disease", "district": "$district"}}},
        {"$sort": {"_id.disease": 1, "_id.district": 1}},
    ])

    try:
        combos = list(cases.aggregate(pipeline))
    except PyMongoError as e:
        print(f"ERROR: Mongo aggregate failed: {e}", file=sys.stderr)
        sys.exit(4)

    if args.limit:
        combos = combos[: args.limit]

    print(f"Found {len(combos)} combo(s). Topic: {TOP}")
    if args.disease:
        print(f"  Filter disease: {', '.join(args.disease)}")
    if args.district:
        print(f"  Filter district: {', '.join(args.district)}")
    if args.since_days:
        print(f"  Since last {args.since_days} day(s)")

    # Dry-run: list and exit
    if args.dry_run:
        for c in combos:
            d = c["_id"]["disease"]
            dist = c["_id"]["district"]
            print(f"DRY-RUN → would emit: {d}/{dist}")
        print("Dry-run complete. No messages sent.")
        return

    # --- Kafka producer ---
    try:
        producer = KafkaProducer(
            bootstrap_servers=BOOT.split(","),
            acks="all",
            linger_ms=50,
            retries=5,
            value_serializer=lambda v: json.dumps(v).encode("utf-8"),
            key_serializer=lambda k: (k or "").encode("utf-8"),
        )
    except kerrors.KafkaError as e:
        print(f"ERROR: Kafka producer init failed: {e}", file=sys.stderr)
        sys.exit(5)

    # --- Emit messages ---
    ts = datetime.now(timezone.utc).isoformat()
    sent = 0
    for c in combos:
        d = c["_id"]["disease"]
        dist = c["_id"]["district"]
        payload = {
            "disease": d,
            "district": dist,
            "trigger": "batch_emit_all",
            "ts": ts,
        }
        key = f"{d}:{dist}"
        try:
            producer.send(TOP, key=key, value=payload)
            if args.verbose:
                print(f"→ {d}/{dist}")
            sent += 1
        except kerrors.KafkaError as e:
            print(f"WARN: failed to send {d}/{dist}: {e}", file=sys.stderr)

    # Flush and report
    try:
        producer.flush(10)
    except kerrors.KafkaError as e:
        print(f"WARN: flush issue: {e}", file=sys.stderr)

    print(f"Done. Sent {sent} message(s) to {TOP} via {BOOT}.")


if __name__ == "__main__":
    main()