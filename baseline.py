"""Uncontrolled baseline: every EV charges at full power as soon as it plugs in."""
import numpy as np

from .data import GridSignals, EV


def uncontrolled(grid: GridSignals, evs: list[EV], station_kw: float = 150.0) -> np.ndarray:
    n, T, dt = len(evs), grid.T, grid.dt
    x = np.zeros((n, T))
    remaining = np.array([ev.energy_kwh for ev in evs], dtype=float)
    for t in range(T):
        active = [i for i, ev in enumerate(evs)
                  if ev.arrival <= t < ev.departure and remaining[i] > 1e-9]
        if not active:
            continue
        want = np.array([min(evs[i].max_power_kw * dt, remaining[i]) for i in active])
        cap = station_kw * dt
        if want.sum() > cap:
            want *= cap / want.sum()
        for k, i in enumerate(active):
            x[i, t] = want[k]
            remaining[i] -= want[k]
    return x