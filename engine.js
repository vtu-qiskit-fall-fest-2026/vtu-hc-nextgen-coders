// EcoCharge browser engine: simulates the grid + fleet and schedules charging entirely in JavaScript,
// so the dashboard works with NO backend. It mirrors the Python model (ecocharge/*.py).
// Scheduler: peak-cap search + cheapest-slot greedy (fast heuristic; the Python LP is the exact solver).
(function () {
  const T = 48, DT = 24 / T, START = 12;
  const mod = (a, n) => ((a % n) + n) % n;

  /* ----------------------------------------------------------- random numbers */
  function makeRng(seed) {
    let a = (Math.imul(seed + 1, 2654435761) >>> 0) || 1;
    const next = () => {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return {
      uniform: (lo, hi) => lo + (hi - lo) * next(),
      int: (lo, hi) => lo + Math.floor(next() * (hi - lo)),
      choice: (arr) => arr[Math.floor(next() * arr.length)],
      normal: (m, s) => {
        let u = 0;
        while (u === 0) u = next();
        return m + s * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
      },
    };
  }

  /* ------------------------------------------------------------------ data */
  function makeGrid(seed) {
    const rng = makeRng(seed);
    const price = [], renewable = [], carbon = [], base = [];
    for (let t = 0; t < T; t++) {
      const h = (START + (t + 0.5) * 24 / T) % 24;
      price.push(Math.max(3.0,
        4.5 + 3.0 * Math.exp(-0.5 * ((h - 9) / 2.0) ** 2) + 4.5 * Math.exp(-0.5 * ((h - 19.5) / 2.2) ** 2) + rng.normal(0, 0.1)));
      const solar = Math.max(Math.sin((h - 6) / 12 * Math.PI), 0) ** 1.5;
      const wind = 0.15 + 0.08 * Math.cos((h - 2) / 24 * 2 * Math.PI);
      const r = Math.min(1, Math.max(0, 0.75 * solar + wind + rng.normal(0, 0.02)));
      renewable.push(r);
      carbon.push(0.82 * (1 - 0.85 * r));
      base.push(120 + 60 * Math.exp(-0.5 * ((h - 9) / 2.5) ** 2) + 110 * Math.exp(-0.5 * ((h - 20) / 2.5) ** 2) + rng.normal(0, 3));
    }
    return { price, renewable, carbon, base };
  }

  function makeFleet(n, seed) {
    const rng = makeRng(seed);
    const slotOf = (hour) => Math.round(mod(hour - START, 24) * T / 24);
    const evs = [];
    for (let i = 0; i < n; i++) {
      let arrival, departure;
      if (rng.uniform(0, 1) < 0.6) {
        arrival = slotOf(rng.uniform(17, 21));
        departure = Math.min(T, slotOf(rng.uniform(6, 9)));
      } else {
        arrival = slotOf(rng.uniform(12, 15)) % T;
        departure = Math.min(T, arrival + rng.int(8, 17));
      }
      departure = Math.min(T, Math.max(departure, arrival + 4));
      const maxKw = rng.choice([3.3, 7.4, 11.0]);
      const windowH = (departure - arrival) * DT;
      const energy = Math.min(rng.uniform(8, 35), 0.9 * maxKw * windowH);
      evs.push({ id: i, arrival, departure, energy, maxKw });
    }
    return evs;
  }

  /* ----------------------------------------------------------------- baseline */
  function uncontrolled(grid, evs, stationKw) {
    const x = evs.map(() => new Array(T).fill(0));
    const remaining = evs.map((e) => e.energy);
    for (let t = 0; t < T; t++) {
      const active = [];
      evs.forEach((e, i) => { if (e.arrival <= t && t < e.departure && remaining[i] > 1e-9) active.push(i); });
      if (!active.length) continue;
      const want = active.map((i) => Math.min(evs[i].maxKw * DT, remaining[i]));
      const cap = stationKw * DT, total = want.reduce((a, b) => a + b, 0);
      const scale = total > cap ? cap / total : 1;
      active.forEach((i, k) => { x[i][t] = want[k] * scale; remaining[i] -= want[k] * scale; });
    }
    return x;
  }

  /* ---------------------------------------------------------------- optimiser */
  function optimize(grid, evs, stationKw, carbonPrice, wPeak) {
    const slotCost = grid.price.map((p, t) => p + carbonPrice * grid.carbon[t]);
    const idx = evs.map((_, i) => i);
    const win = (i) => evs[i].departure - evs[i].arrival;
    const slack = (i) => win(i) * DT * evs[i].maxKw - evs[i].energy;      // spare charging capacity
    const orders = [
      [...idx].sort((a, b) => win(a) - win(b) || evs[b].energy - evs[a].energy),
      [...idx].sort((a, b) => slack(a) - slack(b)),
      [...idx].sort((a, b) => evs[b].energy - evs[a].energy),
    ];
    const slotsByCost = evs.map((e) => {
      const s = [];
      for (let t = e.arrival; t < e.departure; t++) s.push(t);
      return s.sort((a, b) => slotCost[a] - slotCost[b]);
    });

    function build(P) {
      let bestRes = null;
      for (const order of orders) {
        const r = buildWith(P, order);
        if (!bestRes || r.obj < bestRes.obj) bestRes = r;
      }
      return bestRes;
    }

    function buildWith(P, order) {
      const cap = grid.base.map((b) => Math.min(stationKw, Math.max(0, P - b)));
      const used = new Array(T).fill(0);
      const x = evs.map(() => new Array(T).fill(0));
      let unmet = 0;
      for (const i of order) {
        let need = evs[i].energy;
        for (const t of slotsByCost[i]) {
          if (need <= 1e-9) break;
          const kw = Math.min(evs[i].maxKw, cap[t] - used[t], need / DT);
          if (kw > 1e-9) { x[i][t] = kw * DT; used[t] += kw; need -= kw * DT; }
        }
        unmet += Math.max(0, need);
      }
      let cost = 0, peak = 0;
      for (let t = 0; t < T; t++) {
        cost += used[t] * DT * slotCost[t];
        peak = Math.max(peak, grid.base[t] + used[t]);
      }
      return { x, obj: cost + wPeak * peak + 1000 * unmet };
    }

    const pMin = Math.max(...grid.base), span = stationKw;
    let bestP = pMin, best = build(pMin);
    const scan = (lo, hi, steps) => {
      for (let k = 0; k <= steps; k++) {
        const P = lo + ((hi - lo) * k) / steps;
        const r = build(P);
        if (r.obj < best.obj - 1e-9) { best = r; bestP = P; }
      }
    };
    scan(pMin, pMin + span, 60);
    const step = span / 60;
    scan(Math.max(pMin, bestP - step), bestP + step, 30);
    return best.x;
  }

  /* ------------------------------------------------------------------ metrics */
  function evaluate(grid, evs, x) {
    const load = new Array(T).fill(0);
    x.forEach((row) => row.forEach((v, t) => (load[t] += v)));
    const total = load.reduce((a, b) => a + b, 0);
    let cost = 0, co2 = 0, green = 0;
    const power = load.map((l, t) => grid.base[t] + l / DT);
    load.forEach((l, t) => { cost += l * grid.price[t]; co2 += l * grid.carbon[t]; green += l * grid.renewable[t]; });
    let full = 0, unmet = 0;
    evs.forEach((e, i) => {
      const got = x[i].reduce((a, b) => a + b, 0);
      if (got >= e.energy - 1e-4) full++;
      unmet += Math.max(0, e.energy - got);
    });
    return {
      energy_kwh: total, cost_rs: cost, avg_price_rs_per_kwh: total ? cost / total : 0, co2_kg: co2,
      renewable_share: total ? green / total : 0, peak_kw: Math.max(...power),
      peak_to_avg: Math.max(...power) / (power.reduce((a, b) => a + b, 0) / T),
      evs_fully_charged: full, n_evs: evs.length, unmet_kwh: unmet,
    };
  }

  function compare(b, o) {
    const pct = (k) => (b[k] ? (100 * (b[k] - o[k])) / b[k] : 0);
    return {
      cost_saving_pct: pct("cost_rs"), co2_reduction_pct: pct("co2_kg"), peak_reduction_pct: pct("peak_kw"),
      renewable_share_gain_pts: 100 * (o.renewable_share - b.renewable_share),
    };
  }

  /* -------------------------------------------------------------------- solve */
  const RANGES = { n_evs: [30, 1, 200, true], station_kw: [150, 20, 1000], carbon_price: [6, 0, 100], w_peak: [4, 0, 100], seed: [0, 0, 9999, true] };
  const r1 = (v) => Math.round(v * 10) / 10, r2 = (v) => Math.round(v * 100) / 100, r3 = (v) => Math.round(v * 1000) / 1000;
  const labels = Array.from({ length: T }, (_, t) =>
    `${String(Math.floor((START + (t * 24) / T) % 24)).padStart(2, "0")}:${String(Math.floor(((t * 24) / T % 1) * 60)).padStart(2, "0")}`);

  function solve(raw) {
    const p = {};
    for (const [k, [d, lo, hi, isInt]] of Object.entries(RANGES)) {
      let v = Number(raw[k] ?? d);
      if (!isFinite(v)) v = d;
      if (isInt) v = Math.round(v);
      p[k] = Math.max(lo, Math.min(hi, v));
    }
    const grid = makeGrid(p.seed), evs = makeFleet(p.n_evs, p.seed + 1);
    const xOpt = optimize(grid, evs, p.station_kw, p.carbon_price, p.w_peak);
    const xBase = uncontrolled(grid, evs, p.station_kw);
    const mBase = evaluate(grid, evs, xBase), mOpt = evaluate(grid, evs, xOpt);
    const colSum = (x) => Array.from({ length: T }, (_, t) => x.reduce((a, row) => a + row[t], 0));
    const evOpt = colSum(xOpt).map((v) => v / DT), evBase = colSum(xBase).map((v) => v / DT);

    return {
      params: p, labels,
      signals: {
        price: grid.price.map(r3), renewable_pct: grid.renewable.map((v) => r1(v * 100)),
        carbon: grid.carbon.map(r3), base_load_kw: grid.base.map(r1),
      },
      load: {
        uncontrolled_kw: evBase.map((v, t) => r1(grid.base[t] + v)),
        ecocharge_kw: evOpt.map((v, t) => r1(grid.base[t] + v)),
        ev_uncontrolled_kw: evBase.map(r1), ev_ecocharge_kw: evOpt.map(r1),
      },
      metrics: { uncontrolled: mBase, ecocharge: mOpt },
      improvement: compare(mBase, mOpt),
      schedule: evs.map((e, i) => ({
        ev_id: e.id, arrival: labels[e.arrival], departure: e.departure < T ? labels[e.departure] : labels[0],
        energy_kwh: r2(e.energy), max_kw: e.maxKw, kw: xOpt[i].map((v) => r2(v / DT)),
      })),
    };
  }

  window.EcoEngine = { solve, makeGrid, makeFleet, optimize, uncontrolled, evaluate, T, DT };
})();