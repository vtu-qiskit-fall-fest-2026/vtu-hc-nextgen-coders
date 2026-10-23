"""KPIs for comparing charging schedules."""
import numpy as np

from .data import GridSignals, EV


def evaluate(grid: GridSignals, evs: list[EV], x: np.ndarray) -> dict:
    dt = grid.dt
    load_t = x.sum(axis=0)
    total = load_t.sum()
    cost = float((load_t * grid.price).sum())
    co2 = float((load_t * grid.carbon).sum())
    green_kwh = float((load_t * grid.renewable).sum())
    total_power = grid.base_load + load_t / dt
    need = np.array([ev.energy_kwh for ev in evs])
    delivered = x.sum(axis=1)
    return {
        "energy_kwh": float(total),
        "cost_rs": cost,
        "avg_price_rs_per_kwh": cost / total if total else 0.0,
        "co2_kg": co2,
        "renewable_share": green_kwh / total if total else 0.0,
        "peak_kw": float(total_power.max()),
        "peak_to_avg": float(total_power.max() / total_power.mean()),
        "evs_fully_charged": int((delivered >= need - 1e-4).sum()),
        "n_evs": len(evs),
        "unmet_kwh": float(np.clip(need - delivered, 0, None).sum()),
    }


def compare(base: dict, opt: dict) -> dict:
    def pct(k):
        return 100 * (base[k] - opt[k]) / base[k] if base[k] else 0.0
    return {
        "cost_saving_pct": pct("cost_rs"),
        "co2_reduction_pct": pct("co2_kg"),
        "peak_reduction_pct": pct("peak_kw"),
        "renewable_share_gain_pts": 100 * (opt["renewable_share"] - base["renewable_share"]),
    }