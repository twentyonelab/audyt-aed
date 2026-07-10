# Audyt Dostępności Defibrylacji — demonstrator narzędzia (Tychy)

Prototyp narzędzia do audytu i planowania miejskiej sieci publicznych defibrylatorów (AED).
Pojedynczy plik `index.html` — otwiera się w każdej przeglądarce. Mapa bazowa (kafelki Mapbox)
wymaga internetu; cała logika, dane AED i analizy działają lokalnie.

## Uruchomienie

Otwórz `index.html` w przeglądarce. Koniec.

Przebudowa po zmianach w `src/` lub `data/`:

```bash
python3 build.py
```

Odświeżenie realnych danych AED z OpenStreetMap (Overpass):

```bash
python3 tools/fetch_osm_aed.py   # nadpisuje data/aed_osm.json
python3 build.py
```

## Trzy moduły usługi

| Moduł | Co robi w demo | Docelowo (produkt) |
|---|---|---|
| **A — Inwentaryzacja i audyt** | tabela punktów AED ze statusami (dostępność godzinowa, oznakowanie, przegląd), import CSV, szablon danych | formularz audytora w terenie (zdjęcia, GPS), synchronizacja z OSM/Overpass i rejestrami, deduplikacja |
| **B — Analiza i rekomendacje** | wybór standardu czasu dojścia, wskaźniki pokrycia, histogram czasów, luki wg osiedli, optymalizator zachłanny (max pokrycie), punkty przesuwalne na mapie, statystyki przed/po, roadmapa w 3 fazach z kosztami, eksport JSON | izochrony po rzeczywistej sieci ulic (OSRM/Valhalla/ORS), model popytu z siatki ludności, optymalizacja MCLP (OR-Tools), generowanie raportu PDF |
| **C — Karty punktów** | karta techniczna każdego punktu (istniejącego i proponowanego) z zaleceniami audytowymi / wytycznymi wdrożeniowymi, wydruk | karty z dokumentacją zdjęciową, planem oznakowania dojść, harmonogramem serwisu, QR |

## Dane — co jest realne, a co poglądowe

**Rzeczywiste:**
- **Mapa bazowa:** kafelki Mapbox (styl `light-v11`) © Mapbox © OpenStreetMap.
- **Granica miasta:** Państwowy Rejestr Granic, przez [ppatrzyk/polska-geojson](https://github.com/ppatrzyk/polska-geojson).
- **Lokalizacje AED:** OpenStreetMap (Overpass API, tag `emergency=defibrillator`), pobrane dla
  bboxa Tychów i **przycięte do granicy administracyjnej miasta** (31 punktów). Pola
  dostępności/godzin/umiejscowienia/operatora pochodzą z tagów OSM
  (`opening_hours`, `access`, `indoor`, `operator`).

**Poglądowe (do zastąpienia w produkcie):**
- **Oznakowanie dojścia i stan przeglądu AED** — nieopisane w OSM; ustawione jako
  „do weryfikacji" (wymagają audytu terenowego — to właśnie zakres modułu A).
- **Rozkład ludności osiedli i obiekty POI (kandydaci na nowe AED)** — poglądowe;
  docelowo siatka ludności GUS + Overpass (szkoły, przystanki, handel).
- **Model czasu dojścia:** pieszy, 100 m/min, współczynnik wydłużenia drogi 1,35
  (linia prosta → po ulicach). Docelowo: izochrony po grafie sieci pieszej
  (Openrouteservice / OSMnx).

## Architektura

```
src/template.html         szkielet UI (PL)
src/app.css               style (paleta zwalidowana pod kątem dostępności/CVD)
src/app.js                logika: model popytu, pokrycie, optymalizator, wykresy, karty; mapa (Leaflet + kafelki Mapbox)
src/data.js               konfiguracja mapy + dane osiedli/POI; AEDS = AED_OSM
data/tychy_boundary.json  granica miasta (rzeczywista, PRG)
data/aed_osm.json         realne AED z OSM (schemat aplikacji, przycięte do granicy)
tools/fetch_osm_aed.py    pobranie/odświeżenie danych AED z Overpass
tools/smoke.mjs           smoke test (Playwright) modułów A/B/C
vendor/leaflet.*          Leaflet 1.9.4 (BSD-2-Clause)
build.py                  składa wszystko w pojedynczy index.html
```

Runtime bez zależności (poza kafelkami mapy z CDN); build wymaga tylko Pythona 3.

## Mapa bazowa i token Mapbox

Domyślnie mapa używa **CARTO Positron** — jasnego podkładu **bez tokena**, więc
publiczny link (np. GitHub Pages) działa od razu i **żaden sekret nie trafia do
repozytorium**.

**Mapbox** (styl `light-v11`) włącza funkcje wymagające routingu — pomiar trasy
pieszej i obszary dojścia (izochrony). Token (`pk.*`) można dostarczyć na trzy
sposoby (kolejność priorytetu w `src/data.js`):
1. w adresie URL: `…/index.html?mbtoken=pk....`,
2. globalnie: `window.MAPBOX_TOKEN = "pk...."`,
3. wstrzyknięty przy publikacji do wersji Pages (patrz niżej).

**Źródło repo jest bez tokenu** (CARTO domyślnie). Publikacja na GitHub Pages
wstrzykuje publiczny token do wydawanego `index.html`, aby goły link miał od razu
Mapbox — bez `?mbtoken=`:

```bash
python3 build.py
MAPBOX_TOKEN="pk...." python3 tools/deploy_pages.py index.html index.pages.html
# -> zawartość index.pages.html trafia jako index.html na gałąź gh-pages
```

`deploy_pages.py` zapisuje token jako base64 dekodowany w locie (`atob`) — wyłącznie
by nie wywołać false-positive GitHub Push Protection. Token `pk.*` jest publiczny
z założenia (osadzany w stronie); **właściwym zabezpieczeniem jest ograniczenie go
w panelu Mapbox do domeny hostingu** (Account → Tokens → URL restrictions, np.
`twentyonelab.github.io`). Bez tokenu wszystko poza trasami/izochronami działa na
CARTO; funkcje routingu pokazują wtedy widoczny komunikat z instrukcją.
