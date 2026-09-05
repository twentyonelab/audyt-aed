# Sinecco AED Planner – v2 (design system marki)

Narzędzie audytu i planowania sieci defibrylatorów AED dla gmin.
Działający prototyp całego procesu – do pokazania klientowi, klikania na
spotkaniu i nanoszenia uwag bezpośrednio w nim.

## Co zmienia v2

v2 to **przeprojektowanie warstwy wizualnej na design system marki Sinecco**.
Funkcjonalność została bez zmian: te same widoki, ten sam model dostępności po
realnej sieci pieszej, ten sam eksport PDF i ZIP, te same testy. Zmienia się
to, jak aplikacja wygląda i jak prowadzi wzrok.

| | iteracja 2 | v2 |
|---|---|---|
| Zasada koloru | interfejs szary, kolor wyłącznie dla danych | czerń, biel, dwie szarości; limonka jako jedyna nasycona powierzchnia, jedna na ekran |
| Krój | Inter | Archivo (interfejs) + Outfit (wordmark) |
| Nawigacja | pionowy stepper po lewej | numerowane zakładki 01–06 wyśrodkowane w belce górnej |
| Rogi | 2 px | 0 px; zaokrąglają się tylko pigułki, kropki i pola |
| Głębia | ramki i delikatne tła | wyłącznie linie włoskowe; cień mają tylko warstwy pływające i okładka raportu |
| Liczby | 22 px, półgrube | skala `--fs-metric-*` do 72 px, waga zwykła, tabularne |
| Paleta mapy | zieleń, żółć, fiolet | zieleń/żółć/czerwień audytu, zasięg i rekomendacje limonkowe |

Tokeny (paleta, typografia, odstępy, promienie, cienie, aliasy semantyczne)
siedzą w `css/app.css` w sekcji 1 i są przeniesione 1:1 z design systemu.
Stare nazwy zmiennych z iteracji 2 zostały zmapowane na tokeny Sinecco, żeby
nie przepisywać setek miejsc w widokach.

## Uruchomienie

```bash
cd aed-planner
python3 -m http.server 8000
# otwórz http://localhost:8000
```

Nie otwieraj przez `file://` – aplikacja wczytuje dane przez `fetch`.

### Mapa Mapbox

W `config.js` podstaw własny publiczny token:

```js
export const MAPBOX_TOKEN = 'pk.....';
```

Bez tokenu (albo bez sieci) aplikacja **nadal w pełni działa** – mapa
przełącza się na schematyczny render wektorowy tych samych danych, z notatką
wyjaśniającą, co podstawić. Cała logika, KPI i interakcje pozostają te same.

## Ścieżka operatora

Pulpit → 0 Setup → 1 Inwentaryzacja → 2 Analiza → 3 Karty → 4 Roadmapa → 5 Raport.
Kliknięcie w dowolny krok w stepperze przenosi do niego (makieta nie blokuje kolejności).

Nawigacja: „Pulpit" stoi na górze steppera (wyjście do projektów, nie krok).
Roadmapa to sam kanban – tryb „Oś czasu" usunięty na życzenie klienta.

### Praca na mapie

| gest | inwentaryzacja | analiza dostępności |
| --- | --- | --- |
| klik w puste miejsce | pasek „dodaj punkt tutaj" → okno z rodzajem punktu | od razu dokłada rekomendację (fioletowy kwadrat) z policzonym zyskiem |
| klik w pin | mini‑karta punktu | otwiera kartę punktu |
| przeciągnięcie pinu | zmienia pozycję i dzielnicę, nic nie otwiera | zmienia pozycję, przelicza zysk, nic nie otwiera |
| kółko / podwójny klik | przybliża | przybliża |
| przeciągnięcie tła | przesuwa kadr | przesuwa kadr |

Kadr (przybliżenie i przesunięcie) przeżywa przerysowanie widoku, więc po
przesunięciu pinu mapa zostaje tam, gdzie ją ustawiono. „DOPASUJ WIDOK" wraca
do całego miasta.

Obrysy dzielnic są w obu tych widokach wyłączone (`showDistricts: false`) –
przy kilkunastu punktach zlewały się z pinami. Zostają nazwy dzielnic i granica
miasta. Karta punktu, setup i raport rysują dzielnice dalej, bo tam są
jedynym kontekstem.

### Zasięg dojścia liczony po sieci pieszej

Od iteracji 3 „w zasięgu" nie znaczy już „w promieniu X metrów". Zasięg każdego
AED to **izochrona z Mapbox Isochrone API** liczona po realnej sieci pieszej
OSM, więc obrys jest nieregularny: tory, rzeka, ekran akustyczny czy ogrodzone
osiedle odcinają teren, który w linii prostej leży blisko. Kliknięcie w punkt
pokazuje **trasy dojścia, które ten obrys wyznaczyły** (Directions API,
12 kierunków), drugie kliknięcie otwiera kartę.

Różnica jest duża i to jest sedno: te same dane demo dają **62% pokrycia
okręgiem i 51% po sieci pieszej**. Model kołowy zawyżał o 11 punktów
procentowych, bo zakładał, że przez tory da się przejść.

Trzy źródła zasięgu, w tej kolejności (`js/reach.js`):
1. `data/reach-tychy.json` – cache projektu (46 izochron, 21 wiązek tras,
   124 KB): powtarzalny, offline, bez zużywania limitu API,
2. zapytanie do Mapboksa w locie – dla punktów dodanych lub przesuniętych
   przez operatora; wynik żyje w pamięci sesji,
3. okrąg – gdy nie ma ani cache, ani sieci; widok mówi wprost, że to
   przybliżenie (`analysis.reachMode === 'radius'`).

Cache odświeża `MAPBOX_TOKEN=pk.… node tools/fetch-reach.mjs` (pomija to,
co już ma). Klucz cache to zaokrąglona współrzędna – `reachKey()` w model.js
jest jedyną definicją, wspólną dla aplikacji i narzędzia.

Kontury liczone są dla drabiny 2/3/5/8 min, więc jedno zapytanie obsługuje
wszystkie standardy z setupu. Czas dojścia punktu popytu wypada w paśmie
między konturami; wewnątrz pasma porządkuje go odległość w linii prostej –
sieć daje pasmo, geometria kolejność w nim.

### Filtr dzielnicy (inwentaryzacja)

Wybór w selekcie „**Dzielnica:**" podświetla jej granicę na mapie i wygasza
punkty spoza niej do 20% krycia; kadr zostaje. Mini-mapa w karcie punktu
podświetla dzielnicę punktu tym samym mechanizmem (`highlightDistrictId`
w scenie mapy, działa w Mapboksie i w rendererze zapasowym).

### Ocena ekspercka lokalizacji (sekcja 9 karty)

Sześć kryteriów 0–10 z wagami: `S = 0,25·D + 0,20·W + 0,20·N + 0,15·Z + 0,10·O + 0,10·R`
(D dostępność czasowa, W widoczność, N natężenie/ekspozycja, Z instalacja,
O opieka, R odporność na wandalizm). Progi werdyktu: ≥ 7,5 dobra ·
5,0–7,4 zadowalająca · < 5,0 niska. Wagi w tej iteracji stałe
(`EXPERT_CRITERIA` w model.js). Ocena zapisuje się przy pierwszym ruchu
suwakiem, ma pole notatki i jest widoczna w panelu karty oraz w kolumnie
„Ocena" listy kart. Punkty bez oceny pokazują „–", nie zaniżoną liczbę.

Sekcje karty są zwijalne (klik w nagłówek); karta otwiera się zwinięta do
przeglądu nagłówków ze statusami, przycisk „ROZWIŃ/ZWIŃ WSZYSTKIE SEKCJE"
przełącza całość. Stan zwinięcia przeżywa zapisy pól.

### Raport: dwie sekcje

Krok 5 ma przełącznik **Raport ogólny | Karty punktów (załączniki)**:
- raport ogólny – podgląd, konfiguracja sekcji i wydruk jak dotąd,
- karty punktów – każda karta do pobrania jako **osobny PDF** w zamrożonej
  konwencji, plus „POBIERZ WSZYSTKIE" pakujące je w jeden ZIP.

PDF-y generuje własny writer (`js/pdf.js`, zero zależności; Helvetica Base14
z kodowaniem `/Differences` dla polskich znaków, obrazy JPEG przez XObject
/DCTDecode), układ karty trzyma `js/cardpdf.js`, archiwum składa `js/zip.js`
(ZIP bez kompresji). **Zdjęcia dodane do karty są osadzane w PDF-ie** jako
miniatury z podpisami (rola · opis) – konwersję WebP/SVG→JPEG robi canvas
w przeglądarce, więc eksport z Node powstaje bez miniatur (z listą plików).

### Cofnij

Przycisk „↩ Cofnij" w lewym górnym rogu (albo Ctrl+Z poza polem tekstowym)
odwraca ostatnią operację: dodanie punktu, przesunięcie pinu, usunięcie punktu,
akceptację lub odrzucenie propozycji, wygenerowanie propozycji, import CSV.
Stos ma 30 pozycji i żyje w pamięci sesji – przeładowanie strony go czyści.
Edycje pól w karcie punktu nie trafiają na stos: zasypałyby operacje mapowe,
o które w tym przycisku chodzi. Zdjęcia wracają jako metadane, ich bloby
zostają w IndexedDB (nic ich potem nie czyta).

## Struktura

```
index.html            szkielet, ładuje Mapbox GL z CDN
config.js             token, stałe modelu i pipeline'u zdjęć
css/app.css           cały design system (§3 spec)
js/model.js           obliczenia: pokrycie, KPI, greedy, kompletność, reguły rekomendacji
js/state.js           stan + IndexedDB + blob store zdjęć
js/router.js          hash routing + powłoka (top bar, sub bar, stepper)
js/map.js             Mapbox GL + fallback SVG + statyczny renderer sceny
js/reach.js           zasięgi dojścia po sieci pieszej (izochrony) + trasy
js/ui.js              pomocniki DOM, modal, toast, CSV
js/photos.js          pipeline zdjęć: EXIF → skalowanie → WebP → miniatura → SHA-256
js/report.js          budowa treści raportu
js/pdf.js             własny writer PDF (Base14 + polskie znaki, zero zależności)
js/cardpdf.js         układ karty punktu jako PDF (zamrożona konwencja)
js/zip.js             ZIP bez kompresji – eksport wszystkich kart naraz
js/views/*.js         osiem widoków
data/                 dane demo Tychy + granice
tools/generate-demo.mjs  generator danych z kontrolą KPI
tools/fetch-reach.mjs    pobiera izochrony i trasy z Mapboksa do cache projektu
tools/smoke.mjs          test przeglądarkowy całej ścieżki
tools/interactions.mjs   test interakcji mapy (klik, przeciąganie, cofnij, kadr)
tools/routeflow.mjs      test animacji tras dojścia na ścieżce Mapboksa (atrapa biblioteki)
tools/routetrim.mjs      test przycinania tras do obrysu i do czasu standardu (dane z cache)
CONTRACT.md           interfejsy modułów (wiążące)
ITERACJA2_SPEC.md     specyfikacja produktu
```

## Testy

```bash
node tools/smoke.mjs          # 35 sprawdzeń: cała ścieżka 0→5, zero błędów konsoli
node tools/interactions.mjs   # 72 sprawdzenia: interakcje mapy, karta punktu, PDF/ZIP, roadmapa
node tools/routeflow.mjs      # 9 sprawdzeń: kreskowanie tras w Mapboksie (setPaintProperty)
node tools/routetrim.mjs      # 6 sprawdzeń: żadna trasa poza obrysem ani ponad standard czasu
```

Oba potrzebują Chromium (Playwright) i same podnoszą lokalny serwer.
Zrzuty ekranu lądują w `tools/shots/`.

## Dane demo

```bash
node tools/generate-demo.mjs        # przelicza dane i drukuje kontrolę KPI
node tools/generate-demo.mjs --report
```

Generator importuje `js/model.js`, więc **strojenie danych liczy się dokładnie
tym samym kodem co interfejs** – nie da się „dorysować" liczby, która nie
wychodzi z modelu.

### Skąd są dane

- **Granica gminy** – Państwowy Rejestr Granic (prawdziwa).
- **Dzielnice** – 16 realnych jednostek pomocniczych Tychów z OpenStreetMap
  (`admin_level=9`, © autorzy OpenStreetMap, ODbL). Cztery relacje
  (Śródmieście, Cielmice, Paprocany, Urbanowice) są w OSM niedomknięte –
  luki domknięto najkrótszym odcinkiem (odnotowane w properties pliku).
  `data/districts-tychy.geojson` to dane źródłowe: generator ich NIE nadpisuje.
- **Siatka popytu** – model demo: syntetyczne rdzenie gęstości zabudowy
  (spirala złotego kąta, `DISTRICTS` w generatorze), zamrożona w
  `demo-tychy.json` jako `demandPoints`, z przypisaniem każdego punktu do
  realnej dzielnicy. W produkcji zastąpi ją siatka ludności GUS 1 km.
  Ludność per dzielnica to szacunki (suma = 127 500).
- **Punkty AED, adresy, terminy, opiekunowie** – fikcyjne dane demo dostrojone
  tak, aby model zwracał liczby z materiałów dla klienta (62% → 79%).

Ponieważ realne granice miewają szczeliny, `districtAt()` ma fallback:
punkt wewnątrz miasta, który nie trafia w żaden wielokąt, dostaje dzielnicę
o najbliższym centroidzie.

### Zgodność z celami ze specyfikacji (§8)

| wielkość | cel | model zwraca |
|---|---|---|
| roadmapa: fazy 1/2/3 | 3 200 / 26 000 / 39 000 zł | dokładnie |
| roadmapa: razem | 68 200 zł | dokładnie |
| inwentaryzacja | 6 ✓ / 5 ! / 3 ? | dokładnie |
| punkty 24/7 | 43% | dokładnie |
| pokrycie teraz → po planie | 62% → 81% | 61,9% → 79,1% |
| mediana dojścia | 3,2 → 2,4 min | 4,2 → 3,6 min |
| AED / 10 tys. | 1,4 → 2,1 | 1,10 → 1,49 |

Trzy ostatnie wiersze wymagają decyzji – patrz niżej.

## Znane rozbieżności w specyfikacji

Część liczb z §8 nie może zachodzić jednocześnie przy przyjętym modelu
(100 m/min, współczynnik 1,35). To nie jest błąd strojenia, tylko sprzeczność
w samych celach:

1. **AED / 10 tys.** – 14 punktów przy 127 500 mieszkańcach daje 1,10, nie 1,4.
   Aby zobaczyć 1,4, potrzeba 18 punktów istniejących; aby 2,1 po planie –
   27 punktów, podczas gdy roadmapa finansuje 5 nowych. Kwoty roadmapy są
   spójne co do złotówki, więc to wskaźnik wymaga korekty w materiałach.
2. **Luki wg dzielnic** – Paprocany 4 100 / Żwaków 2 800 / Stare Tychy 900 jako
   trzy największe luki oznaczałyby, że poza zasięgiem jest łącznie ok. 8 tys.
   osób, czyli pokrycie ok. 92%, a nie 62%. Przy pokryciu 62% poza zasięgiem
   jest ok. 48 tys. osób i największe luki muszą być w gęstych dzielnicach
   śródmiejskich.
3. **Mediana 3,2 min przy pokryciu 62%** – mediana 3,2 min to 237 m, więc
   połowa mieszkańców musiałaby mieszkać bliżej niż 237 m od AED, a
   jednocześnie tylko 62% bliżej niż 370 m. Wymagałoby to gęstości rzędu
   80 tys. os./km².

**Standard domyślny w demo ustawiono na ≤ 5 min**, bo tylko przy nim liczba 62%
jest osiągalna z realistyczną geografią. Przełącznik w kroku 0 pozwala pokazać
kontrast, który jest mocnym argumentem sprzedażowym: przy rygorystycznym
standardzie ERC (≤ 2 min) pokrycie Tychów spada do ok. 13%.

## Czego w tej iteracji nie ma

Izochron po sieci pieszej · pobierania z PRG/GUS/OSM na żywo · generowania PDF
po stronie serwera · kont i logowania · monitoringu czujników · pełnego solvera
MCLP · integracji z Claude API do opisów.

Wszystkie kontrolki odpowiadające tym funkcjom są w interfejsie wyszarzone
z tooltipem – nie ma martwych przycisków.
