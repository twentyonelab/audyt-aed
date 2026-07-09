/* =========================================================================
   DANE DEMONSTRACYJNE — Tychy
   Granica miasta: rzeczywista (PRG, via ppatrzyk/polska-geojson).
   Pozostałe warstwy (AED, obiekty, ulice, osiedla) są POGLĄDOWE — służą
   pokazaniu logiki narzędzia. W produkcie zastępuje je import z inwentaryzacji
   (CSV/XLSX), OpenStreetMap (Overpass) i rejestrów miejskich.
   ========================================================================= */

const CITY = {
  name: "Tychy",
  populationTotal: 121472, // GUS, stan 31.12.2024
  center: [50.1185, 18.9990],
};

/* Warstwa bazowa mapy.
   Domyślnie: CARTO Positron — jasny podkład rastrowy BEZ tokena. Działa od razu
   na publicznym hostingu (GitHub Pages) i nie wymaga trzymania sekretów w repo.
   Mapbox (styl light-v11) włącza się, gdy poda się publiczny token Mapbox (pk.*):
     - w adresie URL:   .../index.html?mbtoken=pk....
     - albo globalnie:  window.MAPBOX_TOKEN = "pk....";
   Token NIE jest przechowywany w repozytorium (higiena sekretów + GitHub Push
   Protection blokuje commit tokenów Mapbox).
   TODO(produkcja): token wstrzykiwać ze zmiennej środowiskowej przy build/deploy
   i ograniczyć go w panelu Mapbox do domeny hostingu (URL restrictions). */
const MAPBOX_TOKEN = (function () {
  try { return new URLSearchParams(location.search).get("mbtoken") || window.MAPBOX_TOKEN || ""; }
  catch (e) { return ""; /* file:// */ }
})();

const BASEMAP = MAPBOX_TOKEN ? {
  provider: "mapbox",
  url: "https://api.mapbox.com/styles/v1/mapbox/light-v11/tiles/512/{z}/{x}/{y}@2x?access_token=" + MAPBOX_TOKEN,
  options: {
    tileSize: 512, zoomOffset: -1, minZoom: 10, maxZoom: 18, crossOrigin: true,
    attribution: '© <a href="https://www.mapbox.com/about/maps/">Mapbox</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  },
} : {
  provider: "carto",
  url: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
  options: {
    subdomains: "abcd", minZoom: 10, maxZoom: 19, crossOrigin: true,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> © <a href="https://carto.com/attributions">CARTO</a>',
  },
};

/* Osiedla i dzielnice — centroidy + szacunkowa liczba mieszkańców (demo).
   r = promień rozrzutu punktów popytu w metrach. */
const DISTRICTS = [
  // Osiedla śródmiejskie (zabudowa wielorodzinna)
  { id: "A",  name: "Osiedle A (Anna)",   lat: 50.1170, lon: 18.9880, pop: 4200, r: 420 },
  { id: "B",  name: "Osiedle B (Barbara)",   lat: 50.1215, lon: 18.9915, pop: 5400, r: 430 },
  { id: "C",  name: "Osiedle C (Celina)",   lat: 50.1260, lon: 18.9955, pop: 5800, r: 430 },
  { id: "D",  name: "Osiedle D (Dorota)",   lat: 50.1300, lon: 19.0000, pop: 4600, r: 430 },
  { id: "E",  name: "Osiedle E (Ewelina)",   lat: 50.1290, lon: 19.0090, pop: 7800, r: 500 },
  { id: "F",  name: "Osiedle F (Felicja)",   lat: 50.1240, lon: 19.0050, pop: 5400, r: 430 },
  { id: "H",  name: "Osiedle H (Honorata)",   lat: 50.1330, lon: 19.0130, pop: 8200, r: 540 },
  { id: "K",  name: "Osiedle K (Karolina)",   lat: 50.1360, lon: 19.0050, pop: 6200, r: 490 },
  { id: "M",  name: "Osiedle M (Magdalena)",   lat: 50.1305, lon: 19.0190, pop: 5600, r: 480 },
  { id: "N",  name: "Osiedle N",   lat: 50.1145, lon: 19.0050, pop: 4400, r: 430 },
  { id: "O",  name: "Osiedle O",   lat: 50.1120, lon: 18.9970, pop: 4600, r: 430 },
  { id: "P",  name: "Osiedle P",   lat: 50.1390, lon: 19.0140, pop: 3800, r: 430 },
  { id: "R",  name: "Osiedle R (Regina)",   lat: 50.1430, lon: 19.0080, pop: 6200, r: 500 },
  { id: "T",  name: "Osiedle T (Teresa)",   lat: 50.1005, lon: 18.9890, pop: 6400, r: 500 },
  { id: "U",  name: "Osiedle U (Urszula)",   lat: 50.0950, lon: 18.9990, pop: 5400, r: 490 },
  { id: "W",  name: "Osiedle W (Weronika)",   lat: 50.1090, lon: 19.0170, pop: 4200, r: 430 },
  { id: "Z",  name: "Osiedle Z (Zuzanna)",   lat: 50.1345, lon: 18.9945, pop: 4000, r: 420 },
  { id: "ST", name: "Stare Tychy", lat: 50.1235, lon: 18.9860, pop: 3600, r: 400 },
  // Dzielnice peryferyjne (zabudowa jednorodzinna)
  { id: "ZW", name: "Żwaków",      lat: 50.1030, lon: 18.9720, pop: 3200, r: 580 },
  { id: "SU", name: "Suble",       lat: 50.1105, lon: 18.9780, pop: 2800, r: 480 },
  { id: "GL", name: "Glinka",      lat: 50.1165, lon: 18.9720, pop: 1400, r: 400 },
  { id: "WK", name: "Wilkowyje",   lat: 50.1300, lon: 18.9520, pop: 3000, r: 650 },
  { id: "MK", name: "Mąkołowiec",  lat: 50.1425, lon: 18.9660, pop: 2200, r: 580 },
  { id: "CZ", name: "Czułów",      lat: 50.1540, lon: 18.9890, pop: 2600, r: 650 },
  { id: "WG", name: "Wartogłowiec",lat: 50.1540, lon: 19.0170, pop: 1600, r: 560 },
  { id: "JA", name: "Jaroszowice", lat: 50.1240, lon: 19.0570, pop: 1500, r: 560 },
  { id: "UR", name: "Urbanowice",  lat: 50.1140, lon: 19.0470, pop: 2400, r: 620 },
  { id: "CE", name: "Cielmice",    lat: 50.0965, lon: 19.0400, pop: 1800, r: 580 },
  { id: "PA", name: "Paprocany",   lat: 50.0900, lon: 19.0110, pop: 3800, r: 520 },
];

/* Istniejące AED — inwentaryzacja "as-is".
   ŹRÓDŁO RZECZYWISTE: OpenStreetMap (Overpass API, tag emergency=defibrillator),
   pobrane dla bboxa Tychów i przycięte do granicy administracyjnej miasta
   (patrz build.py + data/aed_osm.json; skrypt pobierający: tools/fetch_osm_aed.py).
   Pola access/hours/indoor/owner pochodzą z tagów OSM (opening_hours, access,
   indoor, operator). Pola signage (oznakowanie dojścia) i inspection (aktualny
   przegląd) NIE są opisane w OSM — ustawione na „brak/do weryfikacji" i wymagają
   audytu terenowego. Zmienna AED_OSM jest wstrzykiwana przez build.py.
   access: "24/7" | "godziny" | "ograniczony" ; signage: oznakowanie dojścia;
   inspection: "ok" | "brak" (aktualny przegląd). */
const AEDS = AED_OSM;
/* Poza analizą statyczną: AED mobilne w nowych trolejbusach TLT (do decyzji
   metodycznej, czy uwzględniać w pokryciu). */

/* Obiekty publiczne — generatory ryzyka i KANDYDACI na nowe lokalizacje AED
   (miejsca z gospodarzem: prąd, opieka, zasięg). risk: 1-3 (natężenie ruchu). */
const POIS = [
  { id: "P-01", name: "Plac Baczyńskiego",            type: "przestrzeń publiczna", lat: 50.1250, lon: 18.9980, risk: 3 },
  { id: "P-02", name: "Targowisko miejskie",          type: "handel",     lat: 50.1195, lon: 18.9950, risk: 3 },
  { id: "P-03", name: "Pawilony os. H (Hubala)",      type: "handel",     lat: 50.1335, lon: 19.0125, risk: 2 },
  { id: "P-04", name: "Centrum handlowe City Point",  type: "handel",     lat: 50.1220, lon: 18.9985, risk: 2 },
  { id: "P-05", name: "Market os. R",                 type: "handel",     lat: 50.1425, lon: 19.0090, risk: 2 },
  { id: "P-06", name: "Market Żwaków",                type: "handel",     lat: 50.1040, lon: 18.9755, risk: 2 },
  { id: "P-07", name: "Market Paprocany",             type: "handel",     lat: 50.0910, lon: 19.0080, risk: 2 },
  { id: "P-08", name: "Market Urbanowice",            type: "handel",     lat: 50.1140, lon: 19.0455, risk: 1 },
  { id: "P-09", name: "Market Czułów",                type: "handel",     lat: 50.1532, lon: 18.9888, risk: 1 },
  { id: "P-10", name: "SP Stare Tychy",               type: "szkoła",     lat: 50.1242, lon: 18.9845, risk: 2 },
  { id: "P-11", name: "Zespół szkół os. T",           type: "szkoła",     lat: 50.1012, lon: 18.9905, risk: 2 },
  { id: "P-12", name: "SP os. U",                     type: "szkoła",     lat: 50.0945, lon: 19.0020, risk: 2 },
  { id: "P-13", name: "SP os. K",                     type: "szkoła",     lat: 50.1372, lon: 19.0035, risk: 2 },
  { id: "P-14", name: "SP os. W",                     type: "szkoła",     lat: 50.1095, lon: 19.0185, risk: 2 },
  { id: "P-15", name: "SP Wilkowyje",                 type: "szkoła",     lat: 50.1298, lon: 18.9535, risk: 1 },
  { id: "P-16", name: "SP Paprocany",                 type: "szkoła",     lat: 50.0905, lon: 19.0125, risk: 2 },
  { id: "P-17", name: "Kościół św. Marii Magdaleny",  type: "kościół",    lat: 50.1232, lon: 18.9872, risk: 2 },
  { id: "P-18", name: "Kościół os. Z",                type: "kościół",    lat: 50.1352, lon: 18.9935, risk: 1 },
  { id: "P-19", name: "Kościół os. M (Ducha Św.)",    type: "kościół",    lat: 50.1298, lon: 19.0205, risk: 1 },
  { id: "P-20", name: "Kościół Czułów",               type: "kościół",    lat: 50.1545, lon: 18.9900, risk: 1 },
  { id: "P-21", name: "OSP Cielmice",                 type: "OSP",        lat: 50.0962, lon: 19.0408, risk: 1 },
  { id: "P-22", name: "OSP Jaroszowice",              type: "OSP",        lat: 50.1238, lon: 19.0572, risk: 1 },
  { id: "P-23", name: "OSP Urbanowice",               type: "OSP",        lat: 50.1148, lon: 19.0478, risk: 1 },
  { id: "P-24", name: "OSP Wilkowyje",                type: "OSP",        lat: 50.1305, lon: 18.9525, risk: 1 },
  { id: "P-25", name: "OSP Czułów",                   type: "OSP",        lat: 50.1548, lon: 18.9905, risk: 1 },
  { id: "P-26", name: "Węzeł przesiadkowy al. JPII",  type: "transport",  lat: 50.1188, lon: 19.0000, risk: 3 },
  { id: "P-27", name: "Plaża / molo Paprocany",       type: "rekreacja",  lat: 50.0895, lon: 18.9975, risk: 3 },
  { id: "P-28", name: "Browary Tyskie (portiernia)",  type: "zakład pracy", lat: 50.1290, lon: 18.9790, risk: 2 },
  { id: "P-29", name: "Strefa ekonomiczna (wsch.)",   type: "zakład pracy", lat: 50.1180, lon: 19.0390, risk: 2 },
  { id: "P-30", name: "Urząd Skarbowy / ZUS",         type: "urząd",      lat: 50.1332, lon: 19.0005, risk: 2 },
  { id: "P-31", name: "Dom kultury Wilkowyje",        type: "kultura",    lat: 50.1292, lon: 18.9512, risk: 1 },
  { id: "P-32", name: "Klub os. A (Magdalena)",       type: "kultura",    lat: 50.1175, lon: 18.9862, risk: 1 },
  { id: "P-33", name: "Przychodnia Mąkołowiec",       type: "zdrowie",    lat: 50.1420, lon: 18.9672, risk: 1 },
  { id: "P-34", name: "Przychodnia os. N",            type: "zdrowie",    lat: 50.1150, lon: 19.0038, risk: 2 },
  { id: "P-35", name: "Boisko / orlik Wartogłowiec",  type: "sport",      lat: 50.1535, lon: 19.0160, risk: 1 },
];

/* Schemat głównych ulic (poglądowy) — tylko tło orientacyjne mapy. */
const ROADS = [
  { name: "DK1 / al. Beskidzka", cls: "trunk", pts: [[50.1760,19.0360],[50.1500,19.0330],[50.1300,19.0340],[50.1130,19.0360],[50.0950,19.0400],[50.0772,19.0450]] },
  { name: "DK44 / ul. Oświęcimska", cls: "primary", pts: [[50.1160,18.9280],[50.1130,18.9600],[50.1110,18.9900],[50.1100,19.0150],[50.1120,19.0340],[50.1130,19.0600],[50.1100,19.0910]] },
  { name: "ul. Katowicka", cls: "primary", pts: [[50.1758,18.9900],[50.1550,18.9880],[50.1400,18.9870],[50.1235,18.9865]] },
  { name: "ul. Mikołowska", cls: "secondary", pts: [[50.1350,18.9400],[50.1280,18.9620],[50.1240,18.9800],[50.1235,18.9865]] },
  { name: "al. Bielska", cls: "primary", pts: [[50.1300,18.9550],[50.1285,18.9750],[50.1275,18.9950],[50.1270,19.0150],[50.1265,19.0330]] },
  { name: "al. Jana Pawła II", cls: "secondary", pts: [[50.1180,18.9800],[50.1185,19.0000],[50.1190,19.0150]] },
  { name: "al. Niepodległości", cls: "secondary", pts: [[50.1210,18.9930],[50.1270,19.0000],[50.1330,19.0070]] },
  { name: "ul. Budowlanych", cls: "secondary", pts: [[50.1130,18.9750],[50.1125,18.9950],[50.1130,19.0150],[50.1140,19.0300]] },
  { name: "ul. Sikorskiego", cls: "secondary", pts: [[50.1120,19.0060],[50.1050,19.0080],[50.0980,19.0090]] },
  { name: "ul. Harcerska / Stoczniowców", cls: "secondary", pts: [[50.1050,18.9850],[50.0980,18.9930],[50.0920,19.0050]] },
  { name: "dojazd Paprocany", cls: "tertiary", pts: [[50.0900,19.0100],[50.0880,18.9950]] },
  { name: "ul. Przemysłowa (wsch.)", cls: "tertiary", pts: [[50.1180,19.0390],[50.1140,19.0470],[50.0965,19.0400]] },
  { name: "ul. Czułowska", cls: "tertiary", pts: [[50.1400,18.9870],[50.1480,18.9880],[50.1540,18.9890]] },
  { name: "ul. Mąkołowska", cls: "tertiary", pts: [[50.1350,18.9700],[50.1425,18.9660]] },
  { name: "ul. Jaroszowicka", cls: "tertiary", pts: [[50.1190,19.0150],[50.1220,19.0400],[50.1240,19.0570]] },
];

/* Kolej (linia E-W) + stacja */
const RAIL = {
  line: [[50.1120,18.9280],[50.1090,18.9600],[50.1078,18.9915],[50.1085,19.0200],[50.1120,19.0500],[50.1160,19.0800]],
  station: { name: "Tychy PKP", lat: 50.1080, lon: 18.9915 },
};

/* Jezioro Paprocany (poglądowo) */
const LAKE = [
  [50.0930,18.9880],[50.0920,18.9950],[50.0905,19.0020],[50.0885,19.0060],
  [50.0860,19.0050],[50.0845,19.0000],[50.0850,18.9940],[50.0870,18.9890],
  [50.0900,18.9860],[50.0930,18.9880],
];

/* Lasy (poglądowo) — pas południowy i wschodni */
const FORESTS = [
  [[50.0870,18.9300],[50.0900,18.9600],[50.0870,18.9800],[50.0820,18.9850],[50.0790,18.9600],[50.0800,18.9350],[50.0870,18.9300]],
  [[50.0830,19.0100],[50.0860,19.0300],[50.0850,19.0600],[50.0800,19.0700],[50.0780,19.0300],[50.0790,19.0120],[50.0830,19.0100]],
  [[50.1650,19.0500],[50.1700,19.0700],[50.1620,19.0850],[50.1550,19.0700],[50.1580,19.0520],[50.1650,19.0500]],
];

/* Normy / standardy dostępności — parametr "prawno-wytycznowy" analizy.
   W Polsce brak twardej normy ustawowej: to wytyczne (ERC 2021 i literatura).
   oneWayMin = docelowy czas DOJŚCIA świadka do AED w jedną stronę. */
const STANDARDS = [
  { id: "erc5",   label: "ERC 2021 — defibrylacja do 5 min (dojście ≤ 2 min w jedną stronę)", oneWayMin: 2 },
  { id: "std3",   label: "Standard miejski — dojście ≤ 3 min w jedną stronę",                 oneWayMin: 3 },
  { id: "std5",   label: "Standard podstawowy — dojście ≤ 5 min w jedną stronę",              oneWayMin: 5 },
];

const MODEL = {
  walkSpeedMPerMin: 100, // szybki marsz/trucht świadka ~6 km/h
  detourFactor: 1.35,    // korekta: odległość w linii prostej -> po sieci ulic
};
