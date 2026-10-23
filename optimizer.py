"""Linear-programming EV charging scheduler (HiGHS via SciPy)."""
from dataclasses import dataclass
import numpy as np
from scipy.optimize import linprog
from scipy.sparse import lil_matrix

from .data import GridSignals, EV


@dataclass
class Weights:
    w_cost: float = 1.0
    w_carbon: float = 1.0
    carbon_price: float = 6.0
    w_peak: float = 4.0
    w_shortfall: float = 1000.0


def optimize(grid: GridSignals, evs: list[EV], station_kw: float = 150.0,
             weights: Weights | None = None) -> np.ndarray:
    w = weights or Weights()
    n, T, dt = len(evs), grid.T, grid.dt
    if n == 0:
        return np.zeros((0, T))

    n_x = n * T
    idx_P = n_x
    idx_s = n_x + 1
    n_var = n_x + 1 + n

    def xi(i, t):
        return i * T + t

    c = np.zeros(n_var)
    slot_cost = w.w_cost * grid.price + w.w_carbon * w.carbon_price * grid.carbon
    for i in range(n):
        c[i * T:(i + 1) * T] = slot_cost
    c[idx_P] = w.w_peak
    c[idx_s:] = w.w_shortfall

    bounds = []
    for ev in evs:
        for t in range(T):
            if ev.arrival <= t < ev.departure:
                bounds.append((0, ev.max_power_kw * dt))
            else:
                bounds.append((0, 0))
    bounds.append((0, None))
    bounds += [(0, None)] * n

    A_eq = lil_matrix((n, n_var))
    b_eq = np.zeros(n)
    for i, ev in enumerate(evs):
        for t in range(T):
            A_eq[i, xi(i, t)] = 1.0
        A_eq[i, idx_s + i] = 1.0
        b_eq[i] = ev.energy_kwh

    A_ub = lil_matrix((2 * T, n_var))
    b_ub = np.zeros(2 * T)
    for t in range(T):
        for i in range(n):
            A_ub[t, xi(i, t)] = 1.0
        b_ub[t] = station_kw * dt
        for i in range(n):
            A_ub[T + t, xi(i, t)] = 1.0 / dt
        A_ub[T + t, idx_P] = -1.0
        b_ub[T + t] = -grid.base_load[t]

    res = linprog(c, A_ub=A_ub.tocsr(), b_ub=b_ub, A_eq=A_eq.tocsr(), b_eq=b_eq,
                  bounds=bounds, method="highs")
    if not res.success:
        raise RuntimeError(f"LP failed: {res.message}")
    return np.clip(res.x[:n_x].reshape(n, T), 0, None)