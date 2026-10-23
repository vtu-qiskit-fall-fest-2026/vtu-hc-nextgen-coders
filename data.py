"""Simulated grid signals and EV fleet (day runs 12:00 -> 12:00)."""
from dataclasses import dataclass
import numpy as np

SLOTS_PER_DAY = 48
DT_HOURS = 24 / SLOTS_PER_DAY  # 0.5 h
START_HOUR = 12


@dataclass
class GridSignals:
    price: np.ndarray
    renewable: np.ndarray
    carbon: np.ndarray
    base_load: np.ndarray
    dt: float = DT_HOURS

    @property
    def T(self) -> int:
        return len(self.price)


@dataclass
class EV:
    ev_id: int
    arrival: int
    departure: int
    energy_kwh: float
    max_power_kw: float


def make_grid(T: int = SLOTS_PER_DAY, seed: int = 0) -> GridSignals:
    rng = np.random.default_rng(seed)
    hours = (START_HOUR + (np.arange(T) + 0.5) * 24 / T) % 24

    price = (
        4.5
        + 3.0 * np.exp(-0.5 * ((hours - 9) / 2.0) ** 2)
        + 4.5 * np.exp(-0.5 * ((hours - 19.5) / 2.2) ** 2)
        + rng.normal(0, 0.1, T)
    )
    price = np.clip(price, 3.0, None)

    solar = np.clip(np.sin((hours - 6) / 12 * np.pi), 0, None) ** 1.5
    wind = 0.15 + 0.08 * np.cos((hours - 2) / 24 * 2 * np.pi)
    renewable = np.clip(0.75 * solar + wind + rng.normal(0, 0.02, T), 0, 1)

    carbon = 0.82 * (1 - 0.85 * renewable)

    base_load = (
        120
        + 60 * np.exp(-0.5 * ((hours - 9) / 2.5) ** 2)
        + 110 * np.exp(-0.5 * ((hours - 20) / 2.5) ** 2)
        + rng.normal(0, 3, T)
    )
    return GridSignals(price, renewable, carbon, base_load)


def make_fleet(n: int = 30, T: int = SLOTS_PER_DAY, seed: int = 1) -> list[EV]:
    rng = np.random.default_rng(seed)
    slot_of = lambda hour: int(round((hour - START_HOUR) % 24 * T / 24))
    evs: list[EV] = []
    for i in range(n):
        if rng.random() < 0.6:
            arrival = slot_of(rng.uniform(17, 21))
            departure = min(T, slot_of(rng.uniform(6, 9)))
        else:
            arrival = slot_of(rng.uniform(12, 15)) % T
            departure = min(T, arrival + int(rng.integers(8, 17)))
        departure = max(departure, arrival + 4)
        departure = min(departure, T)
        max_p = float(rng.choice([3.3, 7.4, 11.0]))
        window_h = (departure - arrival) * DT_HOURS
        energy = float(min(rng.uniform(8, 35), 0.9 * max_p * window_h))
        evs.append(EV(i, arrival, departure, energy, max_p))
    return evs