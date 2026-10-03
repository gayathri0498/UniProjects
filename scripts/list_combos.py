# scripts/list_combos.py
import os
from pymongo import MongoClient

MONGO_URI = os.getenv("MONGO_URI")
if not MONGO_URI:
    raise SystemExit("Set MONGO_URI in your environment/.env")

client = MongoClient(MONGO_URI, tz_aware=True)
db = client["epidemics"]
cases = db["cases"]

pipeline = [
    {"$group": {"_id": {"disease": "$disease", "district": "$district"}}},
    {"$sort": {"_id.disease": 1, "_id.district": 1}},
]

combos = list(cases.aggregate(pipeline))
for c in combos:
    d = c["_id"]
    print(f"{d['disease']},{d['district']}")

print(f"\nTotal combos: {len(combos)}")
