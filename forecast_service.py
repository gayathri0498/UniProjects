# forecast_service.py

import os
import logging
from datetime import datetime, timedelta, timezone
from itertools import product
from typing import Optional
from concurrent.futures import ThreadPoolExecutor, as_completed

import pandas as pd
import numpy as np
from pymongo import MongoClient
from prophet import Prophet
from statsmodels.tsa.arima.model import ARIMA
from tensorflow.keras.models import Sequential
from tensorflow.keras.layers import LSTM, Dense
from tensorflow.keras import backend as K
from dotenv import load_dotenv
from sklearn.metrics import mean_squared_error

# Configuration
load_dotenv()
MONGO_URI = os.getenv("MONGO_URI")
if not MONGO_URI:
    raise RuntimeError("MONGO_URI not set in .env")

FORECAST_PERIODS = 7
MIN_HISTORY_DAYS = 30
CACHE_TTL_HOURS = 6  # reuse existing forecast unless forced within this window
UTC = timezone.utc

# Prophet tuning grid: (changepoint_prior_scale, seasonality_mode, weekly_seasonality)
PROPHET_PARAM_GRID = list(product(
    [0.05, 0.2],                     # changepoint_prior_scale
    ["additive", "multiplicative"],  # seasonality_mode
    [True, False]                    # weekly_seasonality
))

# ARIMA tuning grid
ARIMA_PARAM_GRID = [
    (p, d, q)
    for p in [0, 1, 2]
    for d in [1]
    for q in [0, 1]
]

# LSTM tuning candidates
LSTM_WINDOW_CANDIDATES = [7, 14]
LSTM_UNITS_CANDIDATES = [16, 32]
LSTM_EPOCHS = 10  # kept small for speed
# Logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s"
)
logger = logging.getLogger("forecast_service")

# MongoDB setup
client = MongoClient(MONGO_URI)
db = client.get_database("epidemics")
cases_col = db["cases"]
forecasts_col = db["forecasts"]

# Helpers
def _ensure_aware(dt: Optional[datetime]) -> Optional[datetime]:
    if dt is None:
        return None
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=UTC)


def load_timeseries(disease: str, district: str, days: int = 90):
    """
    Load case time series for a disease+district, normalize timestamps to UTC and
    return a DataFrame suitable for Prophet (with naive UTC datetimes).
    """
    now_dt = datetime.now(UTC)
    start_dt = now_dt - timedelta(days=days)

    cursor = cases_col.find({
        "disease": disease,
        "district": district,
        "date": {
            "$gte": datetime(start_dt.year, start_dt.month, start_dt.day, tzinfo=UTC),
            "$lte": datetime(now_dt.year, now_dt.month, now_dt.day, tzinfo=UTC)
        }
    }).sort("date", 1)

    df = pd.DataFrame(list(cursor))
    if df.empty:
        return None

    df = df[["date", "count"]].rename(columns={"date": "ds", "count": "y"})
    df["ds"] = pd.to_datetime(df["ds"])

    # Make sure all timestamps are UTC-aware
    if df["ds"].dt.tz is None:
        df["ds"] = df["ds"].dt.tz_localize(UTC)
    else:
        df["ds"] = df["ds"].dt.tz_convert(UTC)

    # Prophet prefers tz-naive datetimes
    df["ds"] = df["ds"].dt.tz_convert(UTC).dt.tz_localize(None)

    return df


def prophet_forecast_with_params(
    train_df: pd.DataFrame,
    periods: int,
    cps: float,
    seasonality_mode: str,
    weekly_seasonality: bool
):
    m = Prophet(
        daily_seasonality=True,
        changepoint_prior_scale=cps,
        seasonality_mode=seasonality_mode,
        weekly_seasonality=weekly_seasonality,
        yearly_seasonality=False
    )
    m.fit(train_df)
    future = m.make_future_dataframe(periods=periods)
    forecast = m.predict(future)
    result = forecast[["ds", "yhat", "yhat_lower", "yhat_upper"]].tail(periods).copy()
    result["ds"] = result["ds"].dt.strftime("%Y-%m-%d")
    return result


def arima_forecast_with_params(train_df: pd.DataFrame, periods: int, order: tuple):
    model = ARIMA(train_df["y"], order=order)
    res = model.fit()
    pred = res.forecast(periods)
    last_date = pd.to_datetime(train_df["ds"].iloc[-1])
    dates = pd.date_range(last_date + timedelta(days=1), periods=periods)
    return pd.DataFrame({
        "ds": dates.strftime("%Y-%m-%d"),
        "yhat": pred
    })


def lstm_forecast_with_params(train_df: pd.DataFrame, periods: int, window: int, units: int):
    data = train_df["y"].values.astype(float)
    if len(data) < window + 1:
        raise ValueError(f"Insufficient data for LSTM with window {window}")

    mean, std = data.mean(), data.std() or 1.0
    norm = (data - mean) / std

    X, y = [], []
    for i in range(window, len(norm)):
        X.append(norm[i - window:i])
        y.append(norm[i])
    X = np.array(X).reshape(-1, window, 1)
    y = np.array(y)

    K.clear_session()
    model = Sequential([LSTM(units, input_shape=(window, 1)), Dense(1)])
    model.compile("adam", "mse")
    model.fit(X, y, epochs=LSTM_EPOCHS, verbose=0)

    last_seq = list(norm[-window:])
    preds = []
    for _ in range(periods):
        arr = np.array(last_seq[-window:]).reshape(1, window, 1)
        f = model.predict(arr, verbose=0)[0, 0]
        last_seq.append(f)
        preds.append(f * std + mean)

    last_date = pd.to_datetime(train_df["ds"].iloc[-1])
    dates = pd.date_range(last_date + timedelta(days=1), periods=periods)
    return pd.DataFrame({
        "ds": dates.strftime("%Y-%m-%d"),
        "yhat": preds
    })


def backtest_and_score(train_df: pd.DataFrame, model_name: str, periods: int):
    if len(train_df) < periods + 5:
        return None, float("inf"), {}

    history = train_df.iloc[:-periods].reset_index(drop=True)
    actual = train_df.iloc[-periods:].reset_index(drop=True)

    try:
        if model_name == "Prophet":
            best_mse, best_f, best_p = float("inf"), None, {}
            for cps, mode, weekly in PROPHET_PARAM_GRID:
                try:
                    f = prophet_forecast_with_params(history, periods, cps, mode, weekly)
                    mse = mean_squared_error(actual["y"], f["yhat"][:len(actual)])
                    if mse < best_mse:
                        best_mse, best_f, best_p = mse, f, {
                            "changepoint_prior_scale": cps,
                            "seasonality_mode": mode,
                            "weekly_seasonality": weekly
                        }
                except:
                    continue
            return best_f, best_mse, best_p

        if model_name == "ARIMA":
            best_mse, best_f, best_p = float("inf"), None, {}
            for order in ARIMA_PARAM_GRID:
                try:
                    f = arima_forecast_with_params(history, periods, order)
                    mse = mean_squared_error(actual["y"], f["yhat"][:len(actual)])
                    if mse < best_mse:
                        best_mse, best_f, best_p = mse, f, {"order": order}
                except:
                    continue
            return best_f, best_mse, best_p

        if model_name == "LSTM":
            best_mse, best_f, best_p = float("inf"), None, {}
            for w in LSTM_WINDOW_CANDIDATES:
                for u in LSTM_UNITS_CANDIDATES:
                    try:
                        f = lstm_forecast_with_params(history, periods, w, u)
                        mse = mean_squared_error(actual["y"], f["yhat"][:len(actual)])
                        if mse < best_mse:
                            best_mse, best_f, best_p = mse, f, {"window": w, "units": u}
                    except:
                        continue
            return best_f, best_mse, best_p

    except Exception as e:
        logger.warning(f"Backtest failure for {model_name}: {e}")

    return None, float("inf"), {}


def choose_best_model(train_df: pd.DataFrame, periods: int):
    candidates, info = {}, {"tried": [], "failed": []}
    length = len(train_df)
    sparse = length < MIN_HISTORY_DAYS

    for name in ("Prophet", "ARIMA", "LSTM"):
        f, mse, params = backtest_and_score(train_df, name, periods)
        if f is not None:
            candidates[name] = (f, mse, params)
            info["tried"].append(name)
        else:
            info["failed"].append(name)

    base = {
        "history_length": length,
        "sparse_history": sparse,
        "tried": info["tried"],
        "failed": info["failed"],
        "fallback_used": None
    }

    if not candidates:
        last = train_df["y"].iloc[-1]
        ld = pd.to_datetime(train_df["ds"].iloc[-1])
        dates = pd.date_range(ld + timedelta(days=1), periods=periods)
        naive = pd.DataFrame({"ds": dates.strftime("%Y-%m-%d"), "yhat": [last]*periods})
        base["fallback_used"] = "naive_last"
        return "Naive", naive, float("inf"), base, {}

    best = min(candidates, key=lambda k: candidates[k][1])
    f, mse, params = candidates[best]
    return best, f, mse, base, params


def run_single_forecast(disease: str, district: str, periods: int = FORECAST_PERIODS):
    df = load_timeseries(disease, district)
    if df is None or df.empty:
        logger.info(f"Skipping {disease}/{district}: no data")
        return

    name, forecast_df, mse, dq, hp = choose_best_model(df, periods)
    if forecast_df is None:
        logger.warning(f"No usable forecast for {disease}/{district}")
        return

    recs = forecast_df.to_dict("records")
    doc = {
        "disease": disease,
        "district": district,
        "predictions": recs,
        "model": name,
        "mse": mse,
        "hyperparameters": hp,
        "data_quality": dq,
        "runDate": datetime.now(UTC),
        "generated_with": "grid-search-v1"
    }
    forecasts_col.update_one(
        {"disease": disease, "district": district},
        {"$set": doc},
        upsert=True
    )
    logger.info(f"Forecasted {disease}/{district} with {name}; mse={mse:.4f}")


def run_all_forecasts():
    diseases = ["Dengue", "Malaria", "Influenza", "COVID-19"]
    districts = cases_col.distinct("district")
    with ThreadPoolExecutor(max_workers=8) as ex:
        futures = [ex.submit(run_single_forecast, d, dist) 
                   for d in diseases for dist in districts]
        for fut in as_completed(futures):
            try:
                fut.result()
            except Exception as e:
                logger.error(f"Parallel forecast error: {e}")


def get_forecast(disease: str, district: str, force: bool = False):
    doc = forecasts_col.find_one({"disease": disease, "district": district})
    if doc and not force:
        rd = _ensure_aware(doc.get("runDate"))
        if rd and (datetime.now(UTC) - rd) < timedelta(hours=CACHE_TTL_HOURS):
            age = (datetime.now(UTC) - rd).total_seconds()
            return {
                "predictions": doc.get("predictions", []),
                "model": doc.get("model", ""),
                "mse": doc.get("mse"),
                "hyperparameters": doc.get("hyperparameters", {}),
                "data_quality": doc.get("data_quality", {}),
                "runDate": rd,
                "age_seconds": age,
                "generated_with": doc.get("generated_with", "")
            }

    run_single_forecast(disease, district)
    doc = forecasts_col.find_one({"disease": disease, "district": district})
    if doc:
        rd = _ensure_aware(doc.get("runDate"))
        age = (datetime.now(UTC) - rd).total_seconds() if rd else None
        return {
            "predictions": doc.get("predictions", []),
            "model": doc.get("model", ""),
            "mse": doc.get("mse"),
            "hyperparameters": doc.get("hyperparameters", {}),
            "data_quality": doc.get("data_quality", {}),
            "runDate": rd,
            "age_seconds": age,
            "generated_with": doc.get("generated_with", "")
        }

    return {"error": "No forecast could be generated"}


if __name__ == "__main__":
    from apscheduler.schedulers.blocking import BlockingScheduler

    sched = BlockingScheduler(timezone=UTC)
    sched.add_job(run_all_forecasts, "cron", hour=0, minute=5)
    logger.info("Forecast service started; running initial forecast now.")
    run_all_forecasts()
    logger.info("Scheduler running; next scheduled run at 00:05 UTC daily.")
    sched.start()