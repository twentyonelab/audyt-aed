# Sinecco AED Planner — iteracja 2 (klikalna makieta)

Narzędzie audytu i planowania sieci defibrylatorów AED dla gmin.
Ta iteracja to **klikalna makieta całego procesu** — do pokazania klientowi,
klikania na spotkaniu i nanoszenia uwag bezpośrednio w niej.

## Uruchomienie

```bash
cd aed-planner
python3 -m http.server 8000
# otwórz http://localhost:8000
```

Nie otwieraj przez `file://` — aplikacja wczytuje dane przez `fetch`.

### Mapa Mapbox

W `config.js` podstaw własny publiczny token:

```js
export const MAPBOX_TOKEN = 'pk.....';
```

Bez tokenu (albo bez sieci) aplikacja **nadal w pełni działa** — mapa
przełącza się na schematyczny render wektorowy tych samych danych, z notatką
wyjaśniającą, co podstawić. Cała logika, KPI i interakcje pozostają te same.

## Ścieżka operatora

Pulpit → 0 Setup → 1 Inwentaryzacja → 2 Analiza → 3 Karty → 4 Roadmapa → 5 Raport.
Kliknięcie w dowolny krok w stepperze przenosi do niego (makieta nie blokuje kolejności).

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

Obrysy dzielnic są w obu tych widokach wyłączone (`showDistricts: false`) —
przy kilkunastu punktach zlewały się z pinami. Zostają nazwy dzielnic i granica
miasta. Karta punktu, setup i raport rysują dzielnice dalej, bo tam są
jedynym kontekstem.

### Cofnij

Przycisk „↩ Cofnij" w lewym górnym rogu (albo Ctrl+Z poza polem tekstowym)
odwraca ostatnią operację: dodanie punktu, przesunięcie pinu, usunięcie punktu,
akceptację lub odrzucenie propozycji, wygenerowanie propozycji, import CSV.
Stos ma 30 pozycji i żyje w pamięci sesji — przeładowanie strony go czyści.
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
js/ui.js              pomocniki DOM, modal, toast, CSV
js/photos.js          pipeline zdjęć: EXIF → skalowanie → WebP → miniatura → SHA-256
js/report.js          budowa treści raportu
js/views/*.js         osiem widoków
data/                 dane demo Tychy + granice
tools/generate-demo.mjs  generator danych z kontrolą KPI
tools/smoke.mjs          test przeglądarkowy całej ścieżki
tools/interactions.mjs   test interakcji mapy (klik, przeciąganie, cofnij, kadr)
CONTRACT.md           interfejsy modułów (wiążące)
ITERACJA2_SPEC.md     specyfikacja produktu
```

## Testy

```bash
node tools/smoke.mjs          # 31 sprawdzeń: cała ścieżka 0→5, zero błędów konsoli
node tools/interactions.mjs   # 18 sprawdzeń: klik, przeciąganie, cofnij, kadr mapy
```

Oba potrzebują Chromium (Playwright) i same podnoszą lokalny serwer.
Zrzuty ekranu lądują w `tools/shots/`.

## Dane demo

```bash
node tools/generate-demo.mjs        # przelicza dane i drukuje kontrolę KPI
node tools/generate-demo.mjs --report
```

Generator importuje `js/model.js`, więc **strojenie danych liczy się dokładnie
tym samym kodem co interfejs** — nie da się „dorysować" liczby, która nie
wychodzi z modelu.

Granica gminy pochodzi z Państwowego Rejestru Granic. Dzielnice, punkty AED,
kandydaci i ludność są danymi demonstracyjnymi dostrojonymi tak, aby model
zwracał liczby z materiałów dla klienta.

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

Trzy ostatnie wiersze wymagają decyzji — patrz niżej.

## Znane rozbieżności w specyfikacji

Część liczb z §8 nie może zachodzić jednocześnie przy przyjętym modelu
(100 m/min, współczynnik 1,35). To nie jest błąd strojenia, tylko sprzeczność
w samych celach:

1. **AED / 10 tys.** — 14 punktów przy 127 500 mieszkańcach daje 1,10, nie 1,4.
   Aby zobaczyć 1,4, potrzeba 18 punktów istniejących; aby 2,1 po planie —
   27 punktów, podczas gdy roadmapa finansuje 5 nowych. Kwoty roadmapy są
   spójne co do złotówki, więc to wskaźnik wymaga korekty w materiałach.
2. **Luki wg dzielnic** — Paprocany 4 100 / Żwaków 2 800 / Stare Tychy 900 jako
   trzy największe luki oznaczałyby, że poza zasięgiem jest łącznie ok. 8 tys.
   osób, czyli pokrycie ok. 92%, a nie 62%. Przy pokryciu 62% poza zasięgiem
   jest ok. 48 tys. osób i największe luki muszą być w gęstych dzielnicach
   śródmiejskich.
3. **Mediana 3,2 min przy pokryciu 62%** — mediana 3,2 min to 237 m, więc
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
z tooltipem — nie ma martwych przycisków.
