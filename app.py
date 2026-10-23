"""EcoCharge backend (Flask). Run: python backend/app.py"""
import os
import sys

from flask import Flask, jsonify, request, send_from_directory

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from ecocharge import (make_grid, make_fleet, optimize, uncontrolled,  # noqa: E402
                       evaluate, compare, Weights)
from ecocharge.data import START_HOUR  # noqa: E402

FRONTEND = os.path.join(ROOT, "frontend")
app = Flask(__name__, static_folder=FRONTEND, static_url_path="")

PARAMS = {
    "n_evs": (30, 1, 200, int),
    "station_kw": (150.0, 20.0, 1000.0, float),
    "carbon_price": (6.0, 0.0, 100.0, float),
    "w_peak": (4.0, 0.0, 100.0, float),
    "seed": (0, 0, 9999, int),
}


def parse_params(data: dict) -> dict:
    out = {}
    for name, (default, lo, hi, typ) in PARAMS.items():
        try:
            val = typ(data.get(name, default))
        except (TypeError, ValueError):
            raise ValueError(f"'{name}' must be a number")
        out[name] = max(lo, min(hi, val))
    return out


def slot_labels(T: int) -> list[str]:
    return [f"{int((START_HOUR + t * 24 / T) % 24):02d}:{int((t * 24 / T % 1) * 60):02d}"
            for t in range(T)]


@app.get("/api/health")
def health():
    return jsonify(status="ok")


@app.post("/api/optimize")
def run_optimize():
    try:
        p = parse_params(request.get_json(silent=True) or {})
    except ValueError as e:
        return jsonify(error=str(e)), 400

    grid = make_grid(seed=p["seed"])
    evs = make_fleet(n=p["n_evs"], seed=p["seed"] + 1)
    try:
        x_opt = optimize(grid, evs, p["station_kw"],
                         Weights(carbon_price=p["carbon_price"], w_peak=p["w_peak"]))
    except RuntimeError as e:
        return jsonify(error=str(e)), 500
    x_base = uncontrolled(grid, evs, p["station_kw"])

    m_base, m_opt = evaluate(grid, evs, x_base), evaluate(grid, evs, x_opt)
    dt, T = grid.dt, grid.T
    labels = slot_labels(T)

    schedule = [{
        "ev_id": ev.ev_id,
        "arrival": labels[ev.arrival],
        "departure": labels[ev.departure] if ev.departure < T else labels[0],
        "energy_kwh": round(ev.energy_kwh, 2),
        "max_kw": ev.max_power_kw,
        "kw": [round(float(v) / dt, 2) for v in row],
    } for ev, row in zip(evs, x_opt)]

    return jsonify(
        params=p,
        labels=labels,
        signals={
            "price": [round(float(v), 3) for v in grid.price],
            "renewable_pct": [round(float(v) * 100, 1) for v in grid.renewable],
            "carbon": [round(float(v), 3) for v in grid.carbon],
            "base_load_kw": [round(float(v), 1) for v in grid.base_load],
        },
        load={
            "uncontrolled_kw": [round(float(v), 1) for v in grid.base_load + x_base.sum(axis=0) / dt],
            "ecocharge_kw": [round(float(v), 1) for v in grid.base_load + x_opt.sum(axis=0) / dt],
            "ev_uncontrolled_kw": [round(float(v), 1) for v in x_base.sum(axis=0) / dt],
            "ev_ecocharge_kw": [round(float(v), 1) for v in x_opt.sum(axis=0) / dt],
        },
        metrics={"uncontrolled": m_base, "ecocharge": m_opt},
        improvement=compare(m_base, m_opt),
        schedule=schedule,
    )


@app.get("/")
def index():
    return send_from_directory(FRONTEND, "index.html")


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)