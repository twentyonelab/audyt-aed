# CONTRACT.md – interfejsy modułów (iteracja 2)

Dokument wiążący dla wszystkich plików w `js/views/`. Rdzeń (`state.js`,
`model.js`, `ui.js`, `map.js`, `router.js`, `css/app.css`) jest **gotowy i nie
wolno go zmieniać** – widoki mają się do niego dostosować. Jeśli czegoś
naprawdę brakuje, dopisz to lokalnie w swoim pliku widoku.

Kod i nazwy zmiennych po angielsku, **cały interfejs po polsku** (z polskimi
znakami). Bez frameworków, bez bundlera, moduły ES.

---

## 1. Interfejs widoku

Każdy plik w `js/views/` eksportuje:

```js
export const meta = {
  step: 1,                 // numer kroku w stepperze; null/undefined = brak
  title: 'Inwentaryzacja', // tytuł w sub barze
  subtitle: 'jak jest',    // podtytuł w cudzysłowie; opcjonalny
  layout: 'split',         // 'split' (widok sam zarządza wysokością) | 'scroll'
  chrome: 'full',          // 'full' | 'none' (bez sub bara i steppera)
  hideStepper: false,      // ukryj stepper zachowując sub bar
};

export async function render(root, ctx) { /* buduje UI wewnątrz root */ }
export function destroy() {}   // opcjonalne: sprzątanie (mapa, listenery)
```

`ctx` zawiera:

| pole | opis |
|---|---|
| `ctx.params` | parametry trasy, np. `{ id: 'AED-003' }` dla `#/card/:id` |
| `ctx.navigate(hash)` | przejście do innej trasy |
| `ctx.subbar.controls` | pusty `<div class="subbar__controls">` – wstaw tam przełączniki |
| `ctx.setMeta(html)` | ustawia licznik w sub barze, np. `14 punktów: 6 ✓ · 5 ! · 3 ?` |

`root` jest już elementem `.workspace` (dla `layout:'scroll'` ma padding i
przewijanie). Przy `layout:'split'` widok sam robi `display:flex`.

**Po zmianie danych wołaj `await save()`** ze `state.js` – to zapisuje do
IndexedDB i przerysowuje bieżący widok. Nie wołaj `render()` ręcznie.

---

## 2. `state.js`

```js
import {
  state, save, subscribe, resetToDemo,
  getPoint, getPreset, getDistrict, districtName,
  photosForPoint, recommendationsForPoint,
  upsertPoint, removePoint, upsertRecommendation, removeRecommendation,
  nextId, makePoint, districtAt, markStepDone,
  exportProject, importProject,
  savePhotoBlob, getPhotoUrl, deletePhotoBlob,
} from '../state.js';   // z katalogu views/
```

`state` (kształt wg SPEC §4):

```
state.project        {id,name,label,status,population,standardMinutes,districts[],stepsDone[],center,zoom,...}
state.points[]       punkty AED (existing | proposed)
state.photos[]       metadane zdjęć (bajty w IndexedDB)
state.recommendations[]  rekomendacje i zadania roadmapy
state.presets[]      P1..P5
state.candidates[]   kandydaci dla optymalizatora {id,name,districtId,presetId,category,lat,lon}
state.boundary       GeoJSON Feature (granica gminy)
state.districtsGeo   GeoJSON FeatureCollection (dzielnice)
state.demandPoints[] {lat,lon,weight,districtId} – policzone, nie zapisywane
state.projects[]     kafelki pulpitu {id,name,label,status,available}
state.pendingProposals[]  propozycje czekające na akceptację
state.ui             {scenario,mode,selectedPointId,inventoryFilter,cardsFilter,
                      roadmapView,proposeCount,reportSections}
```

Rozszerzenia względem SPEC §4 (dodane, nic nie usunięte):
`recommendations[].rule`, `.startMonth`, `.lengthMonths`, `pointId: null` dla
zadań roadmapy niezwiązanych z punktem; `points[].phase`, `.gainPct`,
`.gainWeight`, `.candidateId` dla propozycji.

---

## 3. `model.js`

```js
import {
  analyze, proposeNewPoints, coverageGainFor,
  completeness, autoRecommendations, pointStatusLevel,
  roadmapTotals, PHASE_META,
  distanceM, walkTimeMin, coverageRadiusM, buildDemandPoints,
  fmtPct, fmtMin, fmtNum, fmtCost,
  WALK_SPEED, DETOUR,
} from '../model.js';
```

Najważniejsze:

```js
const a = analyze({
  demandPoints: state.demandPoints,
  points: state.points,
  districts: state.project.districts,
  standardMinutes: state.project.standardMinutes,
  population: state.project.population,
  scenario: 'now' | 'plan',
  mode: 'day' | 'night',
});
// a.coveragePct, a.medianMin, a.aedPer10k, a.always247Pct, a.activeCount,
// a.radiusM, a.gaps[{districtId,name,uncoveredPeople,maxMin,uncoveredPct}],
// a.demandStatus[{lat,lon,weight,districtId,nearestMin,covered}], a.activePoints[]

const picks = proposeNewPoints({ demandPoints, points, candidates,
  standardMinutes, count, mode });     // [{candidateId,name,lat,lon,presetId,districtId,gainWeight,gainPct}]

const c = completeness(point, preset, state.photos);
// {pct, filled, required, missingFields[], missingPhotos[]}

const recs = autoRecommendations(point, preset, state.photos);
// [{id:'auto-<pointId>-<rule>', pointId, rule, text, priority, cost, owner, phase:null, auto:true, done:false}]
```

Formatowanie **zawsze** przez `fmtPct/fmtMin/fmtNum/fmtCost` (spacja jako
separator tysięcy, przecinek dziesiętny, „zł”).

---

## 4. `ui.js`

```js
import { h, el, frag, mount, clear, escapeHtml, qs, qsa,
         barHtml, pillHtml, dotHtml, statusMeta,
         PRIORITY_LABEL, PRIORITY_VARIANT, PHOTO_ROLES, photoRoleLabel,
         toast, modal, disabledControl, download, pickFile, toCsv, parseCsv } from '../ui.js';
```

- `h(tag, props, ...children)` – `class`, `text`, `html`, `style` (obiekt),
  `dataset` (obiekt), `onclick`/`oninput`/… jako funkcje.
- `modal({title, body, confirmLabel, cancelLabel, hideCancel})` → `Promise<boolean>`.
- `disabledControl(node, 'poza zakresem iteracji 2')` – **tak oznaczamy
  wszystko, czego nie ma w iteracji 2. Żadnego martwego przycisku.**
- `statusMeta(point, completenessPct)` → `{level:'ok'|'warn'|'crit'|'proposed', label, variant}`.

---

## 5. `map.js`

```js
import { createMap, renderSceneSvg, bboxOf } from '../map.js';

const map = createMap(containerEl, { center, zoom });
map.setScene({
  boundary: state.boundary,
  districts: state.districtsGeo,
  showDistricts: true,
  coverage: [{lat, lon, radiusM, kind:'existing'|'proposed'}],
  showCoverage: true,
  demand: analysis.demandStatus,      // {lat,lon,covered,nearestMin}
  showDemand: true,
  targetMinutes: state.project.standardMinutes,
  points: [{id, lat, lon, level, name, draggable:false}],
  labels: [{lat, lon, text, kind:'district'|'gap'}],
  selectedId: state.ui.selectedPointId,
});
map.on('pointclick', (p) => {});
map.on('pointdrag', (p) => {});      // live, throttle ~100 ms po Twojej stronie
map.on('pointdragend', (p) => {});
map.on('mapclick', ({lat, lon, addMode}) => {});
map.setAddMode(true);                // kursor krzyżyk
map.fit(); map.flyTo(lat, lon); map.destroy();
```

`renderSceneSvg(scene, {width,height,showDemand,showCoverage,showLabels})`
zwraca **string SVG** – używaj do mini-mapy w karcie punktu i map w raporcie
(działa bez Mapboxa).

Kontener mapy musi mieć klasę `map-wrap` i niezerową wysokość.
**Zawsze wołaj `map.destroy()` w `destroy()` widoku.**

---

## 6. Klasy CSS (`css/app.css`)

Układ: `.workspace`, `.panel` + `.panel__head/__body/__foot`, `.map-wrap`,
`.map-legend`, `.map-toolbar`, `.map-hint`, `.card`.
Kontrolki: `.btn` (`--primary --ghost --sm --block --danger`), `.seg`+`.seg__btn.is-on`,
`.chip.is-on`, `.input .select .textarea`, `.field`+`.field__label`, `.checkline`, `.radio-row`.
Dane: `.kpi-grid .kpi .kpi__label .kpi__value .kpi__delta.is-up/.is-down`,
`.bar .bar__fill--ok/warn/crit`, `.pill--ok/warn/crit/phase1/phase2/phase3`,
`.dot--ok/warn/crit/proposed`, `.table`, `.list-row`.
Karta punktu: `.card-section` (`--warn`, `--crit` = pasek statusu po lewej),
`.card-section__head/__body`, `.photo-slots .photo-slot.is-required-missing`.
Roadmapa: `.kanban .kanban__col .kanban__stripe--1/2/3 .kanban__card.is-dragging`,
`.gantt .gantt__grid .gantt__lane .gantt__bar--1/2/3 .gantt__milestone .gantt__curve`.
Raport: `.report-layout .report-thumbs .report-thumb.is-on .report-preview
.report-page .report-kpis .report-kpi .report-maps .report-map .report-quote`.
Pulpit: `.dash .dash__grid .project-card .project-card__step.is-done .preset-grid`.
Pomocnicze: `.label-caps .muted .num .row .stack .spacer .divider .note
.empty-state .toast [data-tip]`.

**Nie dodawaj nowych kolorów.** Interfejs jest szary; kolor (`--ok #4CAF7D`,
`--warn #E8B33C`, `--crit #D9534F`, `--phase-3 #8A6FC7`) niesie wyłącznie
informację o danych. Zaokrąglenia ≤ 2 px, brak cieni i gradientów.

---

## 7. Zasady, których nie łamiemy (SPEC §10)

1. Żadnego martwego przycisku – `disabledControl()` z tooltipem.
2. Kolor tylko dla danych.
3. **Wszystkie liczby liczone z modelu**, nigdy wpisane w HTML.
4. Polskie znaki wszędzie.
5. Bez bibliotek UI.
6. Nie zmieniaj nazw pól z §4 – iteracja 3 buduje na tym kontrakcie.
