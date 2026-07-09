/* =========================================================================
   Audyt Dostępności Defibrylacji — logika aplikacji (prototyp)
   Moduł A: inwentaryzacja | Moduł B: analiza i rekomendacje | Moduł C: karty
   ========================================================================= */
"use strict";

/* ---------- geometria ---------- */
const M_PER_DEG_LAT = 111320;
function mPerDegLon(lat) { return 111320 * Math.cos((lat * Math.PI) / 180); }
function distM(a, b) {
  const dy = (a.lat - b.lat) * M_PER_DEG_LAT;
  const dx = (a.lon - b.lon) * mPerDegLon((a.lat + b.lat) / 2);
  return Math.hypot(dx, dy);
}

/* ---------- stan aplikacji ---------- */
const state = {
  scenario: "asis",            // 'asis' | 'tobe'
  standardId: "std3",
  only247: false,
  onlySigned: false,
  nNew: 8,
  unitCost: 15000,             // zł / punkt (urządzenie + szafka + montaż + oznakowanie)
  proposals: [],               // {id,lat,lon,gain,host,phase}
  selected: null,              // {kind:'aed'|'prop'|'poi', id}
  aeds: AEDS.map((a) => ({ ...a })),
};

function standard() { return STANDARDS.find((s) => s.id === state.standardId); }
function radiusM() { return (standard().oneWayMin * MODEL.walkSpeedMPerMin) / MODEL.detourFactor; }
function timeOneWayMin(dStraight) { return (dStraight * MODEL.detourFactor) / MODEL.walkSpeedMPerMin; }

/* ---------- model popytu: punkty z osiedli (rozeta słonecznikowa) ---------- */
const GOLDEN = 2.399963229728653;
const demand = [];
(function buildDemand() {
  const popSum = DISTRICTS.reduce((s, d) => s + d.pop, 0);
  const scale = CITY.populationTotal / popSum;
  DISTRICTS.forEach((d) => {
    const pop = d.pop * scale;
    const n = Math.max(4, Math.min(26, Math.round(pop / 550)));
    for (let i = 0; i < n; i++) {
      const rr = d.r * Math.sqrt((i + 0.5) / n);
      const th = i * GOLDEN;
      demand.push({
        lat: d.lat + (rr * Math.cos(th)) / M_PER_DEG_LAT,
        lon: d.lon + (rr * Math.sin(th)) / mPerDegLon(d.lat),
        w: pop / n,
        dist: d.id,
      });
    }
  });
})();

/* ---------- AED aktywne w analizie (filtry scenariusza) ---------- */
function activeAeds() {
  return state.aeds.filter((a) => {
    if (state.only247 && a.access !== "24/7") return false;
    if (state.onlySigned && !a.signage) return false;
    return true;
  });
}
function analysisPoints(includeProposals) {
  const pts = activeAeds().map((a) => ({ lat: a.lat, lon: a.lon }));
  if (includeProposals) state.proposals.forEach((p) => pts.push({ lat: p.lat, lon: p.lon }));
  return pts;
}

/* ---------- pokrycie i statystyki ---------- */
function nearestTime(pt, aedPts) {
  let dmin = Infinity;
  for (const a of aedPts) { const d = distM(pt, a); if (d < dmin) dmin = d; }
  return timeOneWayMin(dmin);
}
function computeStats(aedPts) {
  const target = standard().oneWayMin;
  let wAll = 0, wCov = 0, tSumW = 0;
  const times = [];
  for (const p of demand) {
    const t = nearestTime(p, aedPts);
    times.push({ t, w: p.w, dist: p.dist });
    wAll += p.w; tSumW += t * p.w;
    if (t <= target) wCov += p.w;
  }
  times.sort((x, y) => x.t - y.t);
  let acc = 0, median = 0;
  for (const x of times) { acc += x.w; if (acc >= wAll / 2) { median = x.t; break; } }
  const poiCov = POIS.filter((poi) => nearestTime(poi, aedPts) <= target).length;
  // luki wg osiedli
  const byDist = {};
  for (const x of times) {
    if (!byDist[x.dist]) byDist[x.dist] = { w: 0, wUn: 0, tMax: 0 };
    byDist[x.dist].w += x.w;
    if (x.t > target) byDist[x.dist].wUn += x.w;
    byDist[x.dist].tMax = Math.max(byDist[x.dist].tMax, x.t);
  }
  const gaps = Object.entries(byDist)
    .map(([id, v]) => ({ id, name: (DISTRICTS.find((d) => d.id === id) || {}).name || id, ...v }))
    .filter((g) => g.wUn > 0)
    .sort((a, b) => b.wUn - a.wUn);
  return {
    covPct: (100 * wCov) / wAll,
    medianT: median,
    avgT: tSumW / wAll,
    poiCovPct: (100 * poiCov) / POIS.length,
    nAed: aedPts.length,
    per10k: (10000 * aedPts.length) / CITY.populationTotal,
    gaps, times, wAll,
  };
}
function histogram(times, wAll) {
  const bins = [
    { label: "≤ 2 min", max: 2 }, { label: "2–4", max: 4 }, { label: "4–6", max: 6 },
    { label: "6–8", max: 8 }, { label: "> 8 min", max: Infinity },
  ].map((b) => ({ ...b, w: 0 }));
  for (const x of times) {
    for (const b of bins) if (x.t <= b.max) { b.w += x.w; break; }
  }
  return bins.map((b) => ({ label: b.label, pct: (100 * b.w) / wAll }));
}

/* ---------- optymalizator (zachłanne maksymalne pokrycie) ---------- */
function optimize(n) {
  const base = analysisPoints(false);
  const cand = [
    ...POIS.map((p) => ({ lat: p.lat, lon: p.lon, host: p.name, type: p.type })),
    ...DISTRICTS.map((d) => ({ lat: d.lat, lon: d.lon, host: d.name + " (centrum osiedla)", type: "lokalizacja do uzgodnienia" })),
  ];
  const target = standard().oneWayMin;
  const covered = demand.map((p) => nearestTime(p, base) <= target);
  const chosen = [];
  for (let k = 0; k < n; k++) {
    let best = null, bestGain = 0;
    for (const c of cand) {
      if (chosen.includes(c)) continue;
      let gain = 0;
      for (let i = 0; i < demand.length; i++) {
        if (covered[i]) continue;
        if (timeOneWayMin(distM(demand[i], c)) <= target) gain += demand[i].w;
      }
      if (gain > bestGain) { bestGain = gain; best = c; }
    }
    if (!best || bestGain < 50) break; // nic sensownego do pokrycia
    chosen.push(best);
    for (let i = 0; i < demand.length; i++) {
      if (!covered[i] && timeOneWayMin(distM(demand[i], best)) <= target) covered[i] = true;
    }
    state.proposals.push({
      id: "NOWY-" + String(state.proposals.length + 1).padStart(2, "0"),
      lat: best.lat, lon: best.lon, host: best.host, type: best.type,
      gain: Math.round(bestGain),
    });
  }
  // fazy roadmapy wg zysku
  state.proposals.forEach((p, i) => { p.phase = i < Math.ceil(n / 3) ? 1 : i < Math.ceil((2 * n) / 3) ? 2 : 3; });
}

/* ---------- mapa ---------- */
const map = L.map("map", { zoomControl: true, attributionControl: true, zoomSnap: 0.25, minZoom: 10, maxZoom: 18 });
map.attributionControl.setPrefix("");
map.fitBounds(BOUNDARY.ring_latlon);
const layers = {
  base: L.layerGroup().addTo(map),
  coverage: L.layerGroup().addTo(map),
  demand: L.layerGroup().addTo(map),
  pois: L.layerGroup(),
  aeds: L.layerGroup().addTo(map),
  props: L.layerGroup().addTo(map),
};

function drawBase() {
  layers.base.clearLayers();
  // Realna mapa bazowa — kafelki rastrowe (CARTO domyślnie, Mapbox z tokenem).
  // Zastępuje wcześniej rysowane warstwy poglądowe (lasy, jezioro, ulice, kolej).
  L.tileLayer(BASEMAP.url, BASEMAP.options).addTo(layers.base);
  // Realna granica administracyjna miasta (PRG) — sam obrys, bez wypełnienia,
  // aby prześwitywała mapa bazowa.
  L.polygon(BOUNDARY.ring_latlon, { color: "#334155", weight: 1.8, dashArray: "6 4", fill: false, interactive: false }).addTo(layers.base);
  // Etykiety osiedli — opisują klastry modelu popytu (ludność poglądowa).
  DISTRICTS.forEach((d) => {
    L.marker([d.lat, d.lon], {
      icon: L.divIcon({ className: "dist-label", html: d.name.replace(/Osiedle (\S+) \([^)]*\)/, "OS. $1").replace("Osiedle ", "OS. "), iconSize: [90, 12], iconAnchor: [45, 6] }),
      interactive: false, keyboard: false,
    }).addTo(layers.base);
  });
}

function statusColor(t) {
  const target = standard().oneWayMin;
  if (t <= target) return "#0ca30c";
  if (t <= 2 * target) return "#fab219";
  return "#d03b3b";
}

function redrawAnalysis() {
  const withProps = state.scenario === "tobe";
  const pts = analysisPoints(withProps);
  // zasięgi
  layers.coverage.clearLayers();
  const r = radiusM();
  activeAeds().forEach((a) =>
    L.circle([a.lat, a.lon], { radius: r, color: "#2a78d6", weight: 1, opacity: 0.4, fillColor: "#2a78d6", fillOpacity: 0.09, interactive: false }).addTo(layers.coverage));
  if (withProps) state.proposals.forEach((p) =>
    L.circle([p.lat, p.lon], { radius: r, color: "#4a3aa7", weight: 1, dashArray: "4 4", opacity: 0.5, fillColor: "#4a3aa7", fillOpacity: 0.09, interactive: false }).addTo(layers.coverage));
  // popyt
  layers.demand.clearLayers();
  for (const p of demand) {
    const t = nearestTime(p, pts);
    L.circleMarker([p.lat, p.lon], {
      radius: 2.4 + Math.min(2.2, p.w / 400), stroke: false,
      fillColor: statusColor(t), fillOpacity: 0.6, interactive: false,
    }).addTo(layers.demand);
  }
}

function aedPopup(a) {
  const issues = [];
  if (!a.signage) issues.push("brak oznakowania dojścia");
  if (a.inspection !== "ok") issues.push("brak aktualnego przeglądu");
  if (a.access !== "24/7") issues.push("dostępność ograniczona: " + a.hours);
  return `<b>${a.name}</b><br>${a.addr} · ${a.owner}<br>` +
    (issues.length ? `<span style="color:#b45309">⚠ ${issues.join("; ")}</span><br>` : `<span style="color:#006300">✓ bez uwag krytycznych</span><br>`) +
    `<a href="#" data-card="${a.id}">Otwórz kartę punktu →</a>`;
}
function drawAeds() {
  layers.aeds.clearLayers();
  state.aeds.forEach((a) => {
    const issue = !a.signage || a.inspection !== "ok";
    const mk = L.marker([a.lat, a.lon], {
      icon: L.divIcon({ className: "", html: `<div class="aed-icon ${issue ? "issue" : ""}" style="position:relative"><svg viewBox=\"0 0 24 24\" width=\"13\" height=\"13\" style=\"display:block\"><path d=\"M13.5 2 5.5 13.5h5l-1.5 8.5 8.5-12h-5.2z\" fill=\"#fff\"/></svg></div>`, iconSize: [24, 24], iconAnchor: [12, 12] }),
      title: a.name,
    }).addTo(layers.aeds);
    mk.bindPopup(aedPopup(a));
    mk.on("popupopen", (e) => bindCardLinks(e.popup.getElement()));
  });
}
function drawProps() {
  layers.props.clearLayers();
  state.proposals.forEach((p, i) => {
    const mk = L.marker([p.lat, p.lon], {
      draggable: true,
      icon: L.divIcon({ className: "", html: `<div class="aed-icon prop" style="position:relative">${i + 1}</div>`, iconSize: [24, 24], iconAnchor: [12, 12] }),
      title: p.host,
    }).addTo(layers.props);
    mk.bindPopup(
      `<b>Propozycja ${i + 1}: ${p.host}</b><br>typ: ${p.type}<br>` +
      `nowo objęci mieszkańcy: ~${p.gain.toLocaleString("pl-PL")}<br>` +
      `<a href="#" data-card="${p.id}">Karta wdrożenia →</a> · <a href="#" data-del="${p.id}">usuń</a>`
    );
    mk.on("popupopen", (e) => bindCardLinks(e.popup.getElement()));
    mk.on("dragend", () => {
      const ll = mk.getLatLng();
      p.lat = ll.lat; p.lon = ll.lng; p.host = p.host.includes("(przesunięto)") ? p.host : p.host + " (przesunięto)";
      refresh(false);
    });
  });
}
function drawPois() {
  layers.pois.clearLayers();
  POIS.forEach((p) => {
    L.marker([p.lat, p.lon], {
      icon: L.divIcon({ className: "", html: '<div class="poi-icon"></div>', iconSize: [9, 9], iconAnchor: [5, 5] }),
      title: `${p.name} (${p.type})`,
    }).addTo(layers.pois).bindTooltip(`${p.name} · ${p.type}`);
  });
}
function bindCardLinks(el) {
  if (!el) return;
  el.querySelectorAll("a[data-card]").forEach((a) =>
    a.addEventListener("click", (ev) => { ev.preventDefault(); openCard(a.dataset.card); }));
  el.querySelectorAll("a[data-del]").forEach((a) =>
    a.addEventListener("click", (ev) => {
      ev.preventDefault();
      state.proposals = state.proposals.filter((p) => p.id !== a.dataset.del);
      map.closePopup(); refresh(true);
    }));
}

/* legenda na mapie */
const legendCtl = L.control({ position: "bottomright" });
legendCtl.onAdd = () => {
  const div = L.DomUtil.create("div", "map-legend");
  div.innerHTML =
    `<b>Legenda</b>` +
    `<div class="row"><span class="aed-icon" style="width:14px;height:14px;font-size:9px;border-radius:4px;padding:1px"><svg viewBox=\"0 0 24 24\" width=\"10\" height=\"10\" style=\"display:block\"><path d=\"M13.5 2 5.5 13.5h5l-1.5 8.5 8.5-12h-5.2z\" fill=\"#fff\"/></svg></span> AED istniejący</div>` +
    `<div class="row"><span class="aed-icon prop" style="width:14px;height:14px;font-size:9px;border-radius:4px">+</span> AED proponowany</div>` +
    `<div class="row"><span class="stat-dot" style="background:#0ca30c"></span> mieszkańcy w zasięgu (✓)</div>` +
    `<div class="row"><span class="stat-dot" style="background:#fab219"></span> do 2× celu (!)</div>` +
    `<div class="row"><span class="stat-dot" style="background:#d03b3b"></span> poza zasięgiem (✗)</div>` +
    `<div class="row"><span style="width:12px;height:12px;border-radius:50%;border:1.5px solid #2a78d6;background:rgba(42,120,214,.12);display:inline-block"></span> strefa dojścia ≤ cel</div>`;
  return div;
};
legendCtl.addTo(map);

/* ---------- statystyki / panel B ---------- */
function fmtMin(t) {
  if (!isFinite(t)) return "—";
  return t.toFixed(1).replace(".", ",") + " min";
}
function tile(v, label, delta) {
  return `<div class="tile"><div class="v">${v}</div><div class="l">${label}</div>${delta || ""}</div>`;
}
function deltaHtml(before, after, goodWhenUp, fmt) {
  const d = after - before;
  if (Math.abs(d) < 0.05) return `<div class="d">bez zmian</div>`;
  const up = d > 0;
  const good = goodWhenUp ? up : !up;
  const arrow = up ? "▲" : "▼";
  return `<div class="d ${good ? "up" : "down"}">${arrow} ${fmt(Math.abs(d))} vs stan obecny</div>`;
}

let lastBefore = null, lastAfter = null;
function renderStats() {
  const before = computeStats(analysisPoints(false));
  const after = state.proposals.length ? computeStats(analysisPoints(true)) : null;
  lastBefore = before; lastAfter = after;
  const s = after && state.scenario === "tobe" ? after : before;
  const el = document.getElementById("stats-tiles");
  el.innerHTML =
    tile(`${s.covPct.toFixed(0)}<small>%</small>`, `mieszkańców w zasięgu ≤ ${standard().oneWayMin} min dojścia`,
      after ? deltaHtml(before.covPct, after.covPct, true, (x) => x.toFixed(0) + " p.p.") : "") +
    tile(fmtMin(s.medianT), "mediana czasu dojścia do AED (pieszo)",
      after ? deltaHtml(before.medianT, after.medianT, false, (x) => x.toFixed(1).replace(".", ",") + " min") : "") +
    tile(`${s.nAed}`, "punktów AED w analizie (po filtrach)",
      after ? deltaHtml(before.nAed, after.nAed, true, (x) => x.toFixed(0)) : "") +
    tile(s.per10k.toFixed(1).replace(".", ","), "AED na 10 tys. mieszkańców",
      after ? deltaHtml(before.per10k, after.per10k, true, (x) => x.toFixed(1).replace(".", ",")) : "") +
    tile(`${s.poiCovPct.toFixed(0)}<small>%</small>`, "obiektów publicznych w zasięgu",
      after ? deltaHtml(before.poiCovPct, after.poiCovPct, true, (x) => x.toFixed(0) + " p.p.") : "");

  // luki
  const gapsEl = document.getElementById("gaps");
  const gs = s.gaps.slice(0, 6);
  gapsEl.innerHTML = gs.length
    ? gs.map((g) => `<tr><td>${g.name}</td><td style="text-align:right">${Math.round(g.wUn).toLocaleString("pl-PL")}</td><td style="text-align:right">${fmtMin(g.tMax)}</td></tr>`).join("")
    : `<tr><td colspan="3" style="color:var(--good-text);font-weight:600">Brak luk przy tym standardzie ✓</td></tr>`;

  renderChart(before, after);
  renderRoadmap();
  renderCompliance(s, before, after);
}

function renderCompliance(s) {
  const el = document.getElementById("compliance");
  const target = standard().oneWayMin;
  const pass = s.covPct >= 90;
  el.innerHTML =
    `<span class="pill ${pass ? "ok" : s.covPct >= 60 ? "warn" : "crit"}">` +
    (pass ? "✓ zgodne z przyjętym standardem" : s.covPct >= 60 ? "! częściowo zgodne" : "✗ niezgodne") +
    `</span> <span style="font-size:12px;color:var(--ink-3)">kryterium robocze: ≥ 90% mieszkańców ≤ ${target} min dojścia. W Polsce brak normy ustawowej — stosujemy wytyczne (ERC 2021) jako standard umowny.</span>`;
}

/* ---------- wykres: rozkład czasów dojścia (SVG) ---------- */
function renderChart(before, after) {
  const el = document.getElementById("chart");
  const hb = histogram(before.times, before.wAll);
  const ha = after ? histogram(after.times, after.wAll) : null;
  const W = 340, H = 150, padL = 30, padB = 22, padT = 8;
  const maxPct = Math.max(...hb.map((b) => b.pct), ...(ha ? ha.map((b) => b.pct) : [0]), 10);
  const bw = ha ? 14 : 22, gap = 2, groupW = (W - padL - 8) / hb.length;
  let bars = "", labels = "", grid = "";
  [0, 25, 50, 75].forEach((g) => {
    if (g > maxPct + 5) return;
    const y = padT + (H - padT - padB) * (1 - g / maxPct);
    grid += `<line x1="${padL}" x2="${W}" y1="${y}" y2="${y}" stroke="#e1e0d9" stroke-width="1"/>` +
      `<text x="${padL - 5}" y="${y + 3}" text-anchor="end" font-size="9" fill="#898781">${g}%</text>`;
  });
  hb.forEach((b, i) => {
    const cx = padL + i * groupW + groupW / 2;
    const h1 = Math.max(1.5, (H - padT - padB) * (b.pct / maxPct));
    const x1 = ha ? cx - bw - gap / 2 : cx - bw / 2;
    bars += `<rect x="${x1}" y="${H - padB - h1}" width="${bw}" height="${h1}" rx="3" fill="#2a78d6" data-tip="Stan obecny · ${b.label}: ${b.pct.toFixed(0)}% mieszkańców"/>`;
    if (ha) {
      const h2 = Math.max(1.5, (H - padT - padB) * (ha[i].pct / maxPct));
      bars += `<rect x="${cx + gap / 2}" y="${H - padB - h2}" width="${bw}" height="${h2}" rx="3" fill="#1baf7a" data-tip="Po wdrożeniu · ${ha[i].label}: ${ha[i].pct.toFixed(0)}% mieszkańców"/>`;
    }
    labels += `<text x="${cx}" y="${H - 7}" text-anchor="middle" font-size="9.5" fill="#52514e">${b.label}</text>`;
  });
  el.innerHTML =
    `<div class="chart-title">Rozkład czasu dojścia do najbliższego AED</div>` +
    `<div class="chart-sub">% mieszkańców wg czasu dojścia w jedną stronę (model pieszy)</div>` +
    `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Histogram czasów dojścia">${grid}${bars}` +
    `<line x1="${padL}" x2="${W}" y1="${H - padB}" y2="${H - padB}" stroke="#c3c2b7"/>${labels}</svg>` +
    `<div class="legend"><span class="key"><span class="swatch" style="background:#2a78d6"></span>Stan obecny</span>` +
    (ha ? `<span class="key"><span class="swatch" style="background:#1baf7a"></span>Po wdrożeniu (plan)</span>` : "") + `</div>`;
  const tip = document.getElementById("chart-tip");
  el.querySelectorAll("rect[data-tip]").forEach((r) => {
    r.addEventListener("mousemove", (e) => {
      tip.style.display = "block"; tip.textContent = r.dataset.tip;
      tip.style.left = e.clientX + 12 + "px"; tip.style.top = e.clientY + 12 + "px";
    });
    r.addEventListener("mouseleave", () => (tip.style.display = "none"));
  });
}

/* ---------- roadmapa ---------- */
function renderRoadmap() {
  const el = document.getElementById("roadmap");
  if (!state.proposals.length) {
    el.innerHTML = `<p class="note">Wygeneruj rekomendacje, aby zobaczyć plan wdrożenia w fazach.</p>`;
    return;
  }
  const phases = [1, 2, 3].map((ph) => state.proposals.filter((p) => p.phase === ph));
  const names = ["Faza 1 — luki krytyczne (0–6 mies.)", "Faza 2 — dogęszczenie (6–18 mies.)", "Faza 3 — standard docelowy (18–36 mies.)"];
  el.innerHTML = phases.map((list, i) => list.length ? `
    <div class="phase p${i + 1}">
      <h4>${names[i]}</h4>
      <div class="meta">${list.length} pkt · ~${(list.length * state.unitCost).toLocaleString("pl-PL")} zł · nowo objęci: ~${list.reduce((s, p) => s + p.gain, 0).toLocaleString("pl-PL")} osób</div>
      <ul>${list.map((p) => `<li>${p.id}: ${p.host} <span style="color:var(--ink-3)">(+${p.gain.toLocaleString("pl-PL")} os.)</span></li>`).join("")}</ul>
    </div>` : "").join("") +
    `<p class="note">Koszt jednostkowy (urządzenie, szafka zewnętrzna z ogrzewaniem, montaż, oznakowanie): <b>${state.unitCost.toLocaleString("pl-PL")} zł</b> — edytowalny w ustawieniach poniżej. Do tego utrzymanie ~8–12% wartości rocznie (elektrody, baterie, przeglądy).</p>`;
}

/* ---------- moduł A: tabela inwentaryzacji ---------- */
function renderInventory() {
  const el = document.getElementById("inv-rows");
  el.innerHTML = state.aeds.map((a) => {
    const st = [];
    st.push(a.access === "24/7" ? `<span class="pill ok">24/7</span>` : `<span class="pill warn">${a.access}</span>`);
    st.push(a.signage ? `<span class="pill ok">oznak.</span>` : `<span class="pill crit">brak oznak.</span>`);
    if (a.inspection !== "ok") st.push(`<span class="pill crit">przegląd!</span>`);
    return `<tr data-id="${a.id}" class="${state.selected && state.selected.id === a.id ? "sel" : ""}">
      <td><b>${a.name}</b><br><span style="color:var(--ink-3)">${a.addr}</span></td>
      <td>${st.join(" ")}</td></tr>`;
  }).join("");
  el.querySelectorAll("tr").forEach((tr) =>
    tr.addEventListener("click", () => { openCard(tr.dataset.id); }));
  const n = state.aeds.length;
  const n247 = state.aeds.filter((a) => a.access === "24/7").length;
  const nSig = state.aeds.filter((a) => a.signage).length;
  const nIns = state.aeds.filter((a) => a.inspection === "ok").length;
  document.getElementById("inv-tiles").innerHTML =
    tile(String(n), "punktów AED zinwentaryzowanych") +
    tile(`${n247}<small>/${n}</small>`, "dostępnych całodobowo") +
    tile(`${nSig}<small>/${n}</small>`, "z oznakowaniem dojścia") +
    tile(`${nIns}<small>/${n}</small>`, "z aktualnym przeglądem");
}

/* ---------- moduł C: karta punktu ---------- */
function openCard(id) {
  state.selected = { id };
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === "c"));
  document.querySelectorAll(".tabbody > .tabpane").forEach((s) => (s.style.display = s.id === "tab-c" ? "" : "none"));
  const a = state.aeds.find((x) => x.id === id);
  const p = state.proposals.find((x) => x.id === id);
  const el = document.getElementById("card");
  if (a) {
    const reco = [];
    if (!a.signage) reco.push("Oznakowanie: znak ILCOR/ISO 7010 E010 przy urządzeniu + tabliczki kierunkowe od głównych ciągów pieszych (maks. 2 zwroty do celu).");
    if (a.access !== "24/7") reco.push("Dostępność: przenieść urządzenie do zewnętrznej szafki z ogrzewaniem (dostęp 24/7) lub formalnie uzgodnić dostęp poza godzinami pracy obiektu.");
    if (a.inspection !== "ok") reco.push("Serwis: wykonać przegląd (elektrody, bateria, autotesty) i objąć punkt harmonogramem utrzymania z rejestrem zdarzeń.");
    reco.push("Rejestracja: zgłosić lokalizację do dyspozytorni PRM / bazy AED, aby dyspozytor mógł wskazać urządzenie dzwoniącemu.");
    reco.push("Opiekun punktu: wyznaczyć osobę odpowiedzialną (comiesięczna kontrola wzrokowa, zgłaszanie użyć).");
    el.innerHTML = `
      <div class="card"><div class="aed-sign">AED</div>
      <h3>${a.name}</h3><div class="addr">${a.addr} · operator: ${a.owner} · ID: ${a.id}</div>
      <dl class="kv">
        <dt>Współrzędne</dt><dd>${a.lat.toFixed(5)}, ${a.lon.toFixed(5)}</dd>
        <dt>Umiejscowienie</dt><dd>${a.indoor ? "wewnątrz budynku" : "na zewnątrz"}</dd>
        <dt>Dostępność</dt><dd>${a.access === "24/7" ? "całodobowa" : a.hours}</dd>
        <dt>Oznakowanie</dt><dd>${a.signage ? "jest (E010)" : "BRAK"}</dd>
        <dt>Przegląd</dt><dd>${a.inspection === "ok" ? "aktualny" : "BRAK / nieudokumentowany"}</dd>
      </dl>
      <div class="reco"><h3>Zalecenia audytowe</h3><ol>${reco.map((r) => `<li>${r}</li>`).join("")}</ol></div>
      <div class="btnrow noprint"><button class="btn primary" onclick="window.print()">🖨 Drukuj kartę punktu</button></div>
      </div>`;
    map.setView([a.lat, a.lon], Math.max(map.getZoom(), 14));
  } else if (p) {
    el.innerHTML = `
      <div class="card"><div class="aed-sign" style="background:#4a3aa7">AED+</div>
      <h3>Nowy punkt: ${p.host}</h3><div class="addr">propozycja ${p.id} · typ gospodarza: ${p.type}</div>
      <dl class="kv">
        <dt>Współrzędne</dt><dd>${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}</dd>
        <dt>Efekt</dt><dd>~${p.gain.toLocaleString("pl-PL")} mieszkańców nowo objętych zasięgiem ≤ ${standard().oneWayMin} min</dd>
        <dt>Faza wdrożenia</dt><dd>Faza ${p.phase}</dd>
        <dt>Koszt (szac.)</dt><dd>${state.unitCost.toLocaleString("pl-PL")} zł + utrzymanie</dd>
      </dl>
      <div class="reco"><h3>Karta wdrożenia (wytyczne)</h3><ol>
        <li>Urządzenie: AED półautomatyczny z instrukcją głosową PL, elektrody uniwersalne dorosły/dziecko.</li>
        <li>Zabudowa: szafka zewnętrzna z ogrzewaniem i alarmem otwarcia (IP55, zasilanie 230 V), montaż na elewacji od strony ciągu pieszego, panel 120–140 cm nad poziomem terenu (dostępność dla osób na wózkach).</li>
        <li>Oznakowanie: znak ILCOR/ISO 7010 E010 nad szafką (podświetlany), tabliczki kierunkowe w promieniu dojścia, oznaczenie w nawigacji (Google/OSM) i bazie dyspozytorni.</li>
        <li>Formalności: umowa z gospodarzem obiektu (zasilanie, opieka), rejestracja urządzenia, ubezpieczenie.</li>
        <li>Uruchomienie: szkolenie BLS/AED dla gospodarza i sąsiedztwa (min. 8 osób), komunikat lokalny, wpis do harmonogramu przeglądów.</li>
      </ol></div>
      <div class="btnrow noprint"><button class="btn primary" onclick="window.print()">🖨 Drukuj kartę wdrożenia</button></div>
      </div>`;
    map.setView([p.lat, p.lon], Math.max(map.getZoom(), 14));
  } else {
    el.innerHTML = `<p class="note">Kliknij punkt na mapie albo wiersz w inwentaryzacji (moduł A), aby wygenerować kartę techniczną punktu.</p>`;
  }
  renderInventory();
}

/* ---------- import CSV (moduł A) ---------- */
function importCsv(text) {
  const sep = text.includes(";") ? ";" : ",";
  const rows = text.trim().split(/\r?\n/).map((l) => l.split(sep).map((c) => c.trim()));
  const head = rows.shift().map((h) => h.toLowerCase());
  const idx = (n) => head.indexOf(n);
  if (idx("nazwa") < 0 || idx("lat") < 0 || idx("lon") < 0) {
    alert("CSV musi mieć kolumny: nazwa; adres; lat; lon; dostep; oznakowanie; przeglad"); return;
  }
  state.aeds = rows.filter((r) => r.length >= 3 && r[idx("lat")]).map((r, i) => ({
    id: "AED-" + String(i + 1).padStart(2, "0"),
    name: r[idx("nazwa")], addr: idx("adres") >= 0 ? r[idx("adres")] : "",
    lat: parseFloat(r[idx("lat")].replace(",", ".")), lon: parseFloat(r[idx("lon")].replace(",", ".")),
    indoor: true,
    access: idx("dostep") >= 0 && /24/.test(r[idx("dostep")]) ? "24/7" : "godziny",
    hours: idx("dostep") >= 0 ? r[idx("dostep")] : "b.d.",
    signage: idx("oznakowanie") >= 0 ? /tak|1|true/i.test(r[idx("oznakowanie")]) : false,
    inspection: idx("przeglad") >= 0 && /tak|ok|1|true/i.test(r[idx("przeglad")]) ? "ok" : "brak",
    owner: "wg importu",
  }));
  state.proposals = []; state.selected = null;
  refresh(true);
}
const CSV_TEMPLATE = "nazwa;adres;lat;lon;dostep;oznakowanie;przeglad\nUrząd Miasta;al. Niepodległości 49;50.1310;19.0020;pn-pt 7:30-15:30;tak;ok\n";

/* ---------- eksport planu ---------- */
function exportPlan() {
  const payload = {
    miasto: CITY.name, standard: standard().label,
    parametry: { predkoscMarszu_m_min: MODEL.walkSpeedMPerMin, wspolczynnikDrogi: MODEL.detourFactor },
    stanObecny: lastBefore && { pokrycie_pct: +lastBefore.covPct.toFixed(1), mediana_min: +lastBefore.medianT.toFixed(1), liczbaAED: lastBefore.nAed },
    poWdrozeniu: lastAfter && { pokrycie_pct: +lastAfter.covPct.toFixed(1), mediana_min: +lastAfter.medianT.toFixed(1), liczbaAED: lastAfter.nAed },
    rekomendacje: state.proposals,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = "aed-plan-tychy-demo.json"; a.click();
}

/* ---------- odświeżanie ---------- */
function refresh(full) {
  if (full) { drawAeds(); drawProps(); }
  redrawAnalysis();
  renderStats();
  renderInventory();
}

/* ---------- zdarzenia UI ---------- */
function initUI() {
  // scenariusz
  document.querySelectorAll("#seg-scenario button").forEach((b) =>
    b.addEventListener("click", () => {
      state.scenario = b.dataset.v;
      document.querySelectorAll("#seg-scenario button").forEach((x) => x.classList.toggle("on", x === b));
      refresh(false);
    }));
  // zakładki
  document.querySelectorAll(".tabs button").forEach((b) =>
    b.addEventListener("click", () => {
      document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("on", x === b));
      document.querySelectorAll(".tabbody > .tabpane").forEach((s) => (s.style.display = s.id === "tab-" + b.dataset.tab ? "" : "none"));
    }));
  // standard
  const sel = document.getElementById("standard");
  STANDARDS.forEach((s) => sel.add(new Option(s.label, s.id)));
  sel.value = state.standardId;
  sel.addEventListener("change", () => { state.standardId = sel.value; state.proposals = []; refresh(true); });
  // filtry
  document.getElementById("f-247").addEventListener("change", (e) => { state.only247 = e.target.checked; refresh(false); });
  document.getElementById("f-sig").addEventListener("change", (e) => { state.onlySigned = e.target.checked; refresh(false); });
  // liczba nowych
  const rng = document.getElementById("n-new"), out = document.getElementById("n-new-out");
  rng.value = state.nNew; out.textContent = state.nNew + " szt.";
  rng.addEventListener("input", () => { state.nNew = +rng.value; out.textContent = rng.value + " szt."; });
  // koszt
  const cost = document.getElementById("unit-cost");
  cost.value = state.unitCost;
  cost.addEventListener("change", () => { state.unitCost = +cost.value || 15000; renderRoadmap(); });
  // optymalizacja
  document.getElementById("btn-opt").addEventListener("click", () => {
    state.proposals = [];
    optimize(state.nNew);
    state.scenario = "tobe";
    document.querySelectorAll("#seg-scenario button").forEach((x) => x.classList.toggle("on", x.dataset.v === "tobe"));
    refresh(true);
  });
  document.getElementById("btn-clear").addEventListener("click", () => { state.proposals = []; refresh(true); });
  // dodaj ręcznie
  let addMode = false;
  const btnAdd = document.getElementById("btn-add");
  btnAdd.addEventListener("click", () => {
    addMode = !addMode;
    btnAdd.classList.toggle("primary", addMode);
    btnAdd.textContent = addMode ? "Kliknij na mapie… (anuluj)" : "+ Dodaj punkt ręcznie";
    map.getContainer().style.cursor = addMode ? "crosshair" : "";
  });
  map.on("click", (e) => {
    if (!addMode) return;
    state.proposals.push({
      id: "NOWY-" + String(state.proposals.length + 1).padStart(2, "0"),
      lat: e.latlng.lat, lon: e.latlng.lng, host: "lokalizacja wskazana ręcznie", type: "do uzgodnienia",
      gain: 0, phase: 1,
    });
    // policz zysk dla ręcznego punktu
    const p = state.proposals[state.proposals.length - 1];
    const base = analysisPoints(false); const target = standard().oneWayMin;
    p.gain = Math.round(demand.reduce((s, d) => {
      const before = nearestTime(d, base) <= target;
      const after = timeOneWayMin(distM(d, p)) <= target;
      return s + (!before && after ? d.w : 0);
    }, 0));
    addMode = false; btnAdd.classList.remove("primary"); btnAdd.textContent = "+ Dodaj punkt ręcznie";
    map.getContainer().style.cursor = "";
    state.scenario = "tobe";
    document.querySelectorAll("#seg-scenario button").forEach((x) => x.classList.toggle("on", x.dataset.v === "tobe"));
    refresh(true);
  });
  // warstwa POI
  document.getElementById("f-poi").addEventListener("change", (e) => {
    if (e.target.checked) layers.pois.addTo(map); else map.removeLayer(layers.pois);
  });
  // import / szablon / eksport
  document.getElementById("csv-file").addEventListener("change", (e) => {
    const f = e.target.files[0]; if (!f) return;
    const rd = new FileReader(); rd.onload = () => importCsv(rd.result); rd.readAsText(f, "utf-8");
  });
  document.getElementById("btn-tpl").addEventListener("click", () => {
    const blob = new Blob([CSV_TEMPLATE], { type: "text/csv" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "szablon-inwentaryzacji-aed.csv"; a.click();
  });
  document.getElementById("btn-export").addEventListener("click", exportPlan);
}

/* ---------- start ---------- */
drawBase();
drawPois();
initUI();
refresh(true);
