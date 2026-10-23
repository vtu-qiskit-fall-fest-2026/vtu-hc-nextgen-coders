// EcoCharge dashboard v2 — works with the Flask backend OR fully in the browser (engine.js)
const IDS = ["n_evs", "station_kw", "carbon_price", "w_peak", "seed"];
const $ = (id) => document.getElementById(id);
const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const state = { data: null, slot: 0, timer: null, history: [], preset: "Custom", stalls: [] };
const charts = {};

/* ------------------------------------------------------------------ helpers */
const fmt = (v, dec = 0) => Number(v).toLocaleString("en-IN", { minimumFractionDigits: dec, maximumFractionDigits: dec });
const num = (v, dec = 0, pre = "", suf = "") =>
  `<span class="num" data-to="${v}" data-dec="${dec}" data-pre="${pre}" data-suf="${suf}">${pre}${fmt(v, dec)}${suf}</span>`;

function countUp(el) {
  const to = parseFloat(el.dataset.to), dec = +el.dataset.dec || 0;
  const pre = el.dataset.pre || "", suf = el.dataset.suf || "";
  if (reduceMotion || !isFinite(to)) { el.textContent = pre + fmt(to, dec) + suf; return; }
  const t0 = performance.now(), dur = 900;
  (function step(now) {
    const p = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - p, 3);
    el.textContent = pre + fmt(to * e, dec) + suf;
    if (p < 1) requestAnimationFrame(step);
  })(t0);
}
const animateNums = (root) => root.querySelectorAll(".num").forEach(countUp);

function setStatus(msg, isError = false) {
  const s = $("status");
  s.textContent = msg;
  s.className = isError ? "error" : "";
}

function say(text) {
  $("bubble").textContent = text;
  const v = $("volty");
  v.classList.remove("pop");
  void v.getBoundingClientRect();
  v.classList.add("pop");
}

/* -------------------------------------------------------------------- theme */
function themeCharts() {
  if (!window.Chart) return;
  const cs = getComputedStyle(document.documentElement);
  Chart.defaults.color = cs.getPropertyValue("--muted").trim();
  Chart.defaults.borderColor = cs.getPropertyValue("--line").trim();
}

function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  $("theme").textContent = t === "dark" ? "☀️" : "🌙";
  $("theme").setAttribute("aria-pressed", String(t === "dark"));
  try { localStorage.setItem("eco-theme", t); } catch (e) { /* storage may be blocked */ }
  themeCharts();
  if (state.data) renderCharts(state.data);
}

function initTheme() {
  let t = null;
  try { t = localStorage.getItem("eco-theme"); } catch (e) { /* ignore */ }
  if (!t) t = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  applyTheme(t);
}

/* ----------------------------------------------------------------- controls */
IDS.forEach((id) => {
  const el = $(id), out = $("o_" + id);
  const show = () => (out.textContent = el.value);
  el.addEventListener("input", () => { show(); setPresetActive(null); });
  show();
});

function params() {
  const p = {};
  IDS.forEach((id) => (p[id] = Number($(id).value)));
  return p;
}

function setPresetActive(name) {
  state.preset = name || "Custom";
  document.querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", c.dataset.name === name));
}

document.querySelectorAll(".chip").forEach((chip) =>
  chip.addEventListener("click", () => {
    $("carbon_price").value = chip.dataset.carbon;
    $("w_peak").value = chip.dataset.peak;
    ["carbon_price", "w_peak"].forEach((id) => ($("o_" + id).textContent = $(id).value));
    setPresetActive(chip.dataset.name);
    run(true);
  })
);

/* ------------------------------------------------------------------- charts */
const cursorPlugin = {
  id: "cursor",
  afterDatasetsDraw(chart) {
    if (!state.data) return;
    const x = chart.scales.x.getPixelForValue(state.slot);
    const { top, bottom } = chart.chartArea;
    const ctx = chart.ctx;
    ctx.save();
    ctx.strokeStyle = "#f0a62b";
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
    ctx.restore();
  },
};

function drawChart(key, canvasId, config) {
  if (charts[key]) charts[key].destroy();
  config.plugins = [cursorPlugin];
  charts[key] = new Chart($(canvasId), config);
}

const baseOpts = () => ({
  responsive: true,
  maintainAspectRatio: false,
  animation: reduceMotion ? false : { duration: 900, easing: "easeOutQuart" },
  interaction: { mode: "index", intersect: false },
  plugins: { legend: { position: "bottom" } },
  elements: { point: { radius: 0 } },
});

function renderCharts(d) {
  if (!window.Chart) { setStatus("Charts could not load (check your internet connection).", true); return; }
  drawChart("signals", "c_signals", {
    type: "line",
    data: {
      labels: d.labels,
      datasets: [
        { label: "Price (Rs/kWh)", data: d.signals.price, borderColor: "#c0392b", yAxisID: "y", tension: .3 },
        { label: "Renewable share (%)", data: d.signals.renewable_pct, borderColor: "#1e8e5a",
          backgroundColor: "rgba(30,142,90,.18)", fill: true, yAxisID: "y2", tension: .3 },
      ],
    },
    options: { ...baseOpts(), scales: {
      x: { ticks: { maxTicksLimit: 12 } },
      y: { title: { display: true, text: "Rs/kWh" } },
      y2: { position: "right", grid: { drawOnChartArea: false }, title: { display: true, text: "%" } },
    } },
  });

  drawChart("load", "c_load", {
    type: "line",
    data: {
      labels: d.labels,
      datasets: [
        { label: "Base load only", data: d.signals.base_load_kw, borderColor: "#888", borderDash: [2, 3] },
        { label: "Uncontrolled", data: d.load.uncontrolled_kw, borderColor: "#8a96a0", borderDash: [6, 4] },
        { label: "EcoCharge", data: d.load.ecocharge_kw, borderColor: "#2b6cb0", borderWidth: 3 },
      ],
    },
    options: { ...baseOpts(), scales: {
      x: { ticks: { maxTicksLimit: 12 } },
      y: { title: { display: true, text: "kW" } },
    } },
  });

  drawChart("ev", "c_ev", {
    type: "bar",
    data: {
      labels: d.labels,
      datasets: [
        { label: "Uncontrolled", data: d.load.ev_uncontrolled_kw, backgroundColor: "#8a96a0" },
        { label: "EcoCharge", data: d.load.ev_ecocharge_kw, backgroundColor: "#2b6cb0" },
      ],
    },
    options: { ...baseOpts(), scales: {
      x: { ticks: { maxTicksLimit: 12 } },
      y: { title: { display: true, text: "kW" } },
    } },
  });
}

/* -------------------------------------------------------- KPIs, score, impact */
function ecoScore(g) {
  const s = g.cost_saving_pct * 0.8 + g.peak_reduction_pct * 0.8 + g.co2_reduction_pct * 4 + g.renewable_share_gain_pts * 1.5;
  return Math.round(Math.max(0, Math.min(100, s)));
}

function renderKpis(d) {
  const b = d.metrics.uncontrolled, o = d.metrics.ecocharge, g = d.improvement;
  const cards = [
    ["💰 Cost saved", num(g.cost_saving_pct, 1, "", "%"), `Rs ${fmt(b.cost_rs)} → Rs ${fmt(o.cost_rs)}`],
    ["🌍 CO₂ reduced", num(g.co2_reduction_pct, 1, "", "%"), `${fmt(b.co2_kg)} → ${fmt(o.co2_kg)} kg`],
    ["📉 Peak load cut", num(g.peak_reduction_pct, 1, "", "%"), `${fmt(b.peak_kw)} → ${fmt(o.peak_kw)} kW`],
    ["☀️ Renewable share", num(o.renewable_share * 100, 1, "", "%"),
      `+${g.renewable_share_gain_pts.toFixed(1)} pts vs ${(b.renewable_share * 100).toFixed(1)}%`],
    ["🔋 EVs fully charged", `${o.evs_fully_charged}/${o.n_evs}`, `Unmet: ${o.unmet_kwh.toFixed(2)} kWh`],
  ];
  $("kpis").innerHTML = cards.map(([l, v, s]) =>
    `<div class="kpi"><div class="label">${l}</div><div class="value">${v}</div><div class="sub">${s}</div></div>`).join("");
  animateNums($("kpis"));
}

function renderScore(d) {
  const score = ecoScore(d.improvement);
  const circ = 326.7;
  $("ring").style.strokeDashoffset = String(circ * (1 - score / 100));
  const el = $("score");
  el.dataset.to = score; el.dataset.dec = 0; el.className = "num";
  countUp(el);
  const grade = score >= 80 ? "Eco Hero 🏆" : score >= 60 ? "Green Machine 🌿" : score >= 40 ? "Getting greener 🌱" : "Seedling 🌰";
  $("grade").textContent = grade;
  return score;
}

function renderImpact(d) {
  const co2 = Math.max(0, d.metrics.uncontrolled.co2_kg - d.metrics.ecocharge.co2_kg);
  const rs = Math.max(0, d.metrics.uncontrolled.cost_rs - d.metrics.ecocharge.cost_rs);
  const items = [
    ["🌳", num(co2 / 0.0575, 0), "days for one tree to absorb the CO₂ you avoided"],
    ["🚗", num(co2 / 0.12, 0, "", " km"), "of petrol driving avoided"],
    ["☕", num(rs / 15, 0), "cups of chai from today's savings"],
  ];
  $("impact").innerHTML = items.map(([e, n, t]) =>
    `<div class="impact-item"><span class="emo">${e}</span><span class="big">${n}</span><span class="txt">${t}</span></div>`).join("");
  animateNums($("impact"));
}

function mood(d) {
  const g = d.improvement, score = ecoScore(g);
  if (score >= 80) return "WOW! Super green AND cheap. I'm doing a happy dance! 🎉";
  if (g.peak_reduction_pct > 25 && g.cost_saving_pct > 25) return "Big savings and a much flatter grid. Nice work! 🌟";
  if (g.co2_reduction_pct > 8) return "Lots of CO₂ avoided! The planet says thanks 🌍";
  if (g.cost_saving_pct > 20) return "Cheap charging unlocked! Try 'Go Green' to cut more CO₂ 🌱";
  return "Try a preset or move the sliders to see what changes! 🔧";
}

/* -------------------------------------------------------------- best window */
function renderBest(d) {
  const L = d.labels, T = L.length, W = 4; // 4 slots = 2 hours
  const mp = Math.max(...d.signals.price), mc = Math.max(...d.signals.carbon);
  const cost = d.signals.price.map((p, i) => p / mp + d.signals.carbon[i] / mc);
  let best = 0, worst = 0, bs = Infinity, ws = -Infinity;
  for (let i = 0; i + W <= T; i++) {
    let s = 0;
    for (let k = 0; k < W; k++) s += cost[i + k];
    if (s < bs) { bs = s; best = i; }
    if (s > ws) { ws = s; worst = i; }
  }
  const avg = (arr, i) => arr.slice(i, i + W).reduce((a, b) => a + b, 0) / W;
  const win = (i) => `${L[i]}–${L[(i + W) % T]}`;
  const desc = (i) =>
    `Avg Rs ${avg(d.signals.price, i).toFixed(2)}/kWh · ${avg(d.signals.renewable_pct, i).toFixed(0)}% renewable · ${avg(d.signals.carbon, i).toFixed(2)} kg CO₂/kWh`;
  $("best").innerHTML =
    `<div class="best-box good"><div class="t">✅ Cheapest + greenest 2-hour window</div><div class="w">${win(best)}</div><div class="d">${desc(best)}</div></div>` +
    `<div class="best-box bad"><div class="t">⛔ Most expensive + dirtiest window</div><div class="w">${win(worst)}</div><div class="d">${desc(worst)}</div></div>`;
}

/* ----------------------------------------------------------- live charging lot */
function prepareLot(d) {
  const T = d.labels.length, dt = 24 / T;
  d.schedule.forEach((e) => {
    e._a = d.labels.indexOf(e.arrival);
    e._d = e.departure === d.labels[0] ? T : d.labels.indexOf(e.departure);
    let c = 0;
    e._cum = e.kw.map((v) => (c += v * dt));
  });
  $("scrub").max = T - 1;
  $("lotGrid").innerHTML = d.schedule.map((e) =>
    `<div class="stall away" title="EV ${e.ev_id}: ${e.energy_kwh} kWh needed, ${e.max_kw} kW max">
       <span class="tag">⚡</span><span class="car-ico">🚗</span><span class="id">EV ${e.ev_id}</span>
       <div class="bat"><i></i></div></div>`).join("");
  state.stalls = Array.from($("lotGrid").children);
}

function updateLot() {
  const d = state.data;
  if (!d) return;
  const t = state.slot;
  $("scrub").value = t;
  let charging = 0;
  d.schedule.forEach((e, i) => {
    const el = state.stalls[i];
    if (!el) return;
    const here = t >= e._a && t < e._d;
    const pct = Math.min(100, (e._cum[t] / e.energy_kwh) * 100);
    const done = pct >= 99.9;
    const isCharging = here && e.kw[t] > 0.01;
    if (isCharging) charging++;
    el.className = "stall " + (!here ? "away" : isCharging ? "charging" : done ? "done" : "waiting");
    el.querySelector(".bat i").style.width = (here || t >= e._d ? pct : 0) + "%";
    el.querySelector(".car-ico").textContent = done && here ? "😎" : isCharging ? "🚙" : here ? "🚗" : "🚗";
    el.querySelector(".tag").textContent = done ? "✅" : "⚡";
  });
  const hour = parseInt(d.labels[t].slice(0, 2), 10);
  const sun = hour >= 6 && hour < 18 ? "☀️" : "🌙";
  $("live").innerHTML =
    `<div>Time<b>${sun} ${d.labels[t]}</b></div>` +
    `<div>Price<b>Rs ${d.signals.price[t].toFixed(2)}</b></div>` +
    `<div>Renewable<b>${d.signals.renewable_pct[t].toFixed(0)}%</b></div>` +
    `<div>Grid load<b>${d.load.ecocharge_kw[t].toFixed(0)} kW</b></div>` +
    `<div>Cars charging<b>${charging}</b></div>`;
  if (charts.load) charts.load.draw();
  if (charts.signals) charts.signals.draw();
  if (charts.ev) charts.ev.draw();
}

function stopPlayback() {
  if (state.timer) { clearInterval(state.timer); state.timer = null; }
  $("play").textContent = "▶ Play day";
}

function togglePlayback() {
  if (!state.data) return;
  if (state.timer) { stopPlayback(); return; }
  if (state.slot >= state.data.labels.length - 1) state.slot = 0;
  $("play").textContent = "⏸ Pause";
  const speed = Number($("speed").value) || 1;
  state.timer = setInterval(() => {
    if (state.slot >= state.data.labels.length - 1) { stopPlayback(); return; }
    state.slot += 1;
    updateLot();
  }, 400 / speed);
}

$("play").addEventListener("click", togglePlayback);
$("speed").addEventListener("change", () => { if (state.timer) { stopPlayback(); togglePlayback(); } });
$("scrub").addEventListener("input", (e) => { state.slot = Number(e.target.value); updateLot(); });

/* ------------------------------------------------------- history + schedule */
function renderHistory(d) {
  const o = d.metrics.ecocharge, g = d.improvement, p = d.params;
  state.history.unshift({
    name: state.preset, evs: p.n_evs, cap: p.station_kw,
    cost: g.cost_saving_pct, co2: g.co2_reduction_pct, peak: g.peak_reduction_pct, score: ecoScore(g),
  });
  state.history = state.history.slice(0, 6);
  $("history").innerHTML =
    "<tr><th>Run</th><th>Preset</th><th>EVs</th><th>Station kW</th><th>Cost saved</th><th>CO₂ cut</th><th>Peak cut</th><th>Score</th></tr>" +
    state.history.map((h, i) =>
      `<tr><td>#${state.history.length - i}${i === 0 ? " (latest)" : ""}</td><td>${h.name}</td><td>${h.evs}</td><td>${h.cap}</td>` +
      `<td>${h.cost.toFixed(1)}%</td><td>${h.co2.toFixed(1)}%</td><td>${h.peak.toFixed(1)}%</td><td>${h.score}</td></tr>`).join("");
}

function renderSchedule(d) {
  const maxKw = Math.max(1, ...d.schedule.map((e) => e.max_kw));
  const head = "<tr><th>EV</th><th>Window</th><th>kWh</th>" +
    d.labels.map((l, i) => `<th>${i % 4 === 0 ? l.slice(0, 2) : ""}</th>`).join("") + "</tr>";
  const rows = d.schedule.map((e) => {
    const cells = e.kw.map((v, i) => {
      const a = v > 0.01 ? 0.15 + 0.85 * Math.min(1, v / maxKw) : 0;
      return `<td class="cell" title="${d.labels[i]}: ${v} kW" style="background:rgba(43,108,176,${a})"></td>`;
    }).join("");
    return `<tr><td class="ev">EV ${e.ev_id}</td><td>${e.arrival}–${e.departure}</td><td>${e.energy_kwh}</td>${cells}</tr>`;
  }).join("");
  $("schedule").innerHTML = head + rows;
}

function exportCsv() {
  const d = state.data;
  if (!d) return;
  const lines = [["ev_id", "arrival", "departure", "energy_kwh", "max_kw", ...d.labels.map((l) => l + " kW")].join(",")];
  d.schedule.forEach((e) => lines.push([e.ev_id, e.arrival, e.departure, e.energy_kwh, e.max_kw, ...e.kw].join(",")));
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "ecocharge_schedule.csv";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$("export").addEventListener("click", exportCsv);

/* ----------------------------------------------------------------- confetti */
function confetti() {
  if (reduceMotion) return;
  const c = $("confetti"), ctx = c.getContext("2d");
  c.width = window.innerWidth; c.height = window.innerHeight;
  const cols = ["#43b97f", "#f0a62b", "#2b6cb0", "#ff9db1", "#ffe066", "#8be0b0"];
  const ps = Array.from({ length: 120 }, () => ({
    x: c.width / 2 + (Math.random() - 0.5) * 240, y: c.height * 0.3,
    vx: (Math.random() - 0.5) * 13, vy: -Math.random() * 12 - 4, s: 6 + Math.random() * 6,
    c: cols[Math.floor(Math.random() * cols.length)], r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4,
  }));
  let f = 0;
  (function tick() {
    ctx.clearRect(0, 0, c.width, c.height);
    ps.forEach((p) => {
      p.vy += 0.35; p.x += p.vx; p.y += p.vy; p.r += p.vr;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r);
      ctx.fillStyle = p.c; ctx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * 0.6); ctx.restore();
    });
    if (++f < 160) requestAnimationFrame(tick); else ctx.clearRect(0, 0, c.width, c.height);
  })();
}

/* -------------------------------------------------- solve: backend if present, else browser */
async function solve(p) {
  if (location.protocol !== "file:") {
    try {
      const res = await fetch("/api/optimize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(p),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Request failed");
      return { data, mode: "server" };
    } catch (err) {
      if (!(err instanceof TypeError) || !window.EcoEngine) throw err; // real server error -> show it
    }
  }
  return { data: window.EcoEngine.solve(p), mode: "browser" };
}

/* ---------------------------------------------------------------------- run */
async function run(celebrate = false) {
  const btn = $("run");
  btn.disabled = true;
  stopPlayback();
  setStatus("Optimising…");
  try {
    const { data, mode } = await solve(params());
    state.data = data;
    state.slot = 0;
    prepareLot(data);
    renderKpis(data);
    const score = renderScore(data);
    renderImpact(data);
    renderBest(data);
    renderCharts(data);
    renderHistory(data);
    renderSchedule(data);
    updateLot();
    say(mood(data));
    setStatus(mode === "browser" ? "Done (running in your browser, no server needed)." : "Done.");
    if (celebrate && score >= 60) confetti();
  } catch (err) {
    setStatus("Error: " + err.message, true);
    say("Oops, something went wrong. Is the server still running? 🔌");
  } finally {
    btn.disabled = false;
  }
}

$("run").addEventListener("click", () => run(true));
$("theme").addEventListener("click", () =>
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));

initTheme();
setPresetActive("Balanced");
run(false);