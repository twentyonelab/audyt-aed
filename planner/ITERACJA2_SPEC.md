# SPEC – Sinecco AED Planner · ITERACJA 2 (klikalna makieta)

**Dokument wykonawczy dla Claude Code.** Wersja 1.0 · 2026-07-29
Źródła: makiety Figma (board „Sinecco – iteracja 1"), BRIEF_narzedzie_AED_v2.md

---

## 0. Prompt startowy (wklej jako pierwszą wiadomość w Claude Code)

> Buduję prototyp aplikacji webowej „Sinecco AED Planner" – narzędzie audytu i planowania sieci defibrylatorów AED dla gmin. Pełna specyfikacja jest w pliku `ITERACJA2_SPEC.md` w tym repo – przeczytaj go w całości przed pisaniem kodu.
>
> To iteracja 2: **klikalna makieta**, nie produkcja. Ma działać w przeglądarce, z prawdziwą mapą Mapbox i danymi demo Tychów, żeby dało się ją pokazać klientowi i klikać cały proces od dashboardu do raportu.
>
> Zanim zaczniesz kodować: przedstaw mi plan plików i kolejność budowy do akceptacji. Potem buduj etapami wg §9 spec, po każdym etapie krótko raportuj co działa.
>
> Zasady: bez frameworków i bez build-stepu (vanilla JS + moduły ES), stan w jednym obiekcie, dane w JSON, zapis do IndexedDB. Kod po angielsku, cały interfejs po polsku.

---

## 1. Czym jest ta iteracja

**Cel:** klikalna makieta całego procesu audytu – do pokazania klientowi (Sinecco) i gminom, do zbierania uwag i do nanoszenia zmian bezpośrednio w niej.

| | Iteracja 2 (TA) | Iteracja 3 (później) |
|---|---|---|
| Dane | JSON demo (Tychy) + edycja w przeglądarce | SQLite + import z PRG/GUS/OSM |
| Zapis | IndexedDB + eksport/import ZIP | serwer, `data/` na dysku |
| Czasy dojścia | model uproszczony (wzór §5) | izochrony Mapbox |
| Raport | podgląd HTML + druk do PDF | generowany PDF z brandingiem |
| Użytkownicy | brak logowania | operator Sinecco |

**Kryterium sukcesu:** operator przechodzi całą ścieżkę 0→5, dodaje punkt, uzupełnia kartę ze zdjęciem, generuje propozycje, buduje roadmapę i widzi raport – bez ani jednego martwego przycisku.

---

## 2. Stack i zasady techniczne

- **Vanilla JS (moduły ES), HTML, CSS. Bez Reacta, bez bundlera, bez npm build.** Otwierasz `index.html` przez lokalny serwer (`python -m http.server`) i działa.
- **Mapbox GL JS** z CDN. Token w `config.js` (placeholder `MAPBOX_TOKEN`, ja podstawię swój).
- **Stan aplikacji:** jeden obiekt `state` w pamięci + zapis do **IndexedDB** (nie localStorage – potrzebne Bloby zdjęć).
- **Zdjęcia:** Blob w IndexedDB, referencja w danych punktu. Pipeline jak w §7.
- **Zero zależności runtime** poza Mapbox GL JS.
- Kod i nazwy zmiennych po angielsku, **cały interfejs po polsku** (z polskimi znakami).

**Dlaczego tak:** ta makieta ma być łatwa do modyfikacji na żywo podczas spotkania i musi otworzyć się u każdego bez instalacji. Struktura modułów ma odpowiadać przyszłej aplikacji, żeby iteracja 3 była rozbudową, nie przepisaniem.

### Struktura plików

```
/aed-planner
  index.html
  config.js                 ← MAPBOX_TOKEN, stałe modelu
  /css
    app.css                 ← cały styl (design system §3)
  /js
    state.js                ← model stanu + IndexedDB (load/save/export/import)
    router.js               ← przełączanie widoków (hash routing)
    map.js                  ← Mapbox: warstwy, piny, strefy, interakcje
    model.js                ← obliczenia: pokrycie, KPI, propozycje punktów
    photos.js               ← wgrywanie, kompresja, EXIF, miniatury
    report.js               ← budowa raportu HTML + druk
    /views
      dashboard.js  setup.js  inventory.js  analysis.js
      cards.js  card.js  roadmap.js  report-view.js
  /data
    demo-tychy.json         ← dane demo (§8)
    presets.json            ← presety P1–P5
    districts-tychy.geojson ← poglądowe granice dzielnic
    boundary-tychy.geojson  ← granica gminy
```

---

## 3. Design system (z makiet Figma – trzymać się dokładnie)

**Kolory**

| Rola | HEX |
|---|---|
| Tekst główny / akcent | `#1E1E1E` |
| Top bar, przyciski główne | `#3A3A3A` |
| Tekst drugorzędny | `#666666` |
| Obramowania | `#D0D0D0` |
| Tło paneli | `#F4F4F4` |
| Tło sekcji | `#F9F9F9` |
| Status OK | `#4CAF7D` |
| Status braki / ostrzeżenie | `#E8B33C` |
| Status krytyczny | `#D9534F` |
| Faza 3 / akcent dodatkowy | `#8A6FC7` |

**Zasada:** interfejs jest szary. Kolor niesie **wyłącznie** informację o danych (status punktu, faza, luka). Żadnych gradientów, cieni, zaokrągleń powyżej 2 px.

**Typografia:** Inter (system-ui fallback). 11–12 px etykiety wersalikami `#666`, 13–14 px treść, 15–17 px nagłówki sekcji, 20 px+ liczby KPI (bold).

**Siatka:** 8 px. Obramowanie 1 px `#D0D0D0`, aktywne elementy 1,5–2 px `#3A3A3A`.

### Szkielet aplikacji (wspólny dla kroków 0–5)

```
┌──────────────────────────────────────────────────────────┐
│ TOP BAR 56px  #3A3A3A                                    │
│ SINECCO · AED Planner   Projekt: TYCHY   Operator   [PDF]│
├──────────────────────────────────────────────────────────┤
│ SUB BAR 48px  #F4F4F4                                    │
│ Krok N z 5 · Nazwa – „podtytuł"      [przełączniki]      │
├────────────┬─────────────────────────────────────────────┤
│ STEPPER    │  OBSZAR ROBOCZY                             │
│ 232px      │  (mapa / tabela / karta / kanban / raport)   │
│ #F4F4F4    │                                             │
│ 0 ✓ …5     │                                             │
└────────────┴─────────────────────────────────────────────┘
```

Stepper: kółko 26 px z numerem + nazwa. Krok aktywny = ciemna pigułka, białe kółko. Kroki ukończone = szare wypełnienie kółka. **Kliknięcie w dowolny krok przenosi do niego** (bez blokad – to makieta).

---

## 4. Model danych (JSON)

```jsonc
{
  "project": {
    "id": "tychy-2026",
    "name": "Tychy",
    "label": "TYCHY – Audyt 2026",
    "status": "w_toku",              // w_toku | oferta | zakonczony
    "population": 127500,
    "standardMinutes": 2,            // 2 = ERC | 3 = miejski | 5 = podstawowy
    "boundary": "boundary-tychy.geojson",
    "districts": [
      { "id": "paprocany", "name": "Paprocany", "population": 8200 }
    ],
    "stepsDone": [0, 1],
    "updatedAt": "2026-07-29"
  },

  "points": [{
    "id": "AED-007",
    "kind": "existing",              // existing | proposed
    "status": "verified_gaps",       // unverified | verified_ok | verified_gaps
                                     // proposed | accepted | rejected
    "name": "SP nr 7 – hol główny",
    "address": "ul. Szkolna 3",
    "districtId": "zwakow",
    "lat": 50.1312, "lon": 18.9762,
    "presetId": "P1",
    "placement": "hol główny, przy portierni",
    "access": {
      "always": false,
      "hours": "pn–pt 8:00–16:00",
      "weekend": "zamknięte",
      "barriers": "domofon po 15:00"
    },
    "keeper": { "org": null, "person": null, "contact": null },
    "signage": { "atDevice": true, "route": false },
    "device": {
      "model": "Philips HS1",
      "inspectionDue": "2026-03",
      "padsDue": "2026-09"
    },
    "dispatcherRegistered": false,   // zgłoszenie do CPR 112/999
    "technical": {                   // głównie punkty zewnętrzne
      "power": null, "distanceToSource": null,
      "works": null, "connectionCost": null, "monitoring": false
    },
    "photos": ["ph-001", "ph-002"],
    "verification": { "date": "2026-07-12", "by": "KB", "source": "operator" },
    "recommendations": ["rec-001", "rec-002"],
    "notes": ""
  }],

  "photos": [{
    "id": "ph-001",
    "pointId": "AED-007",
    "role": "device",                // device | signage_device | signage_route
                                     // mounting_spot | power | context
    "caption": "AED przy portierni",
    "takenAt": "2026-07-12T10:22",
    "gps": { "lat": 50.1312, "lon": 18.9762 },
    "width": 1600, "height": 1200, "bytes": 287000,
    "blobKey": "ph-001",             // klucz w IndexedDB
    "thumbKey": "ph-001-t"
  }],

  "recommendations": [{
    "id": "rec-001",
    "pointId": "AED-007",
    "text": "Wyznaczyć opiekuna punktu",
    "priority": "high",              // high | medium | low
    "cost": 0,
    "owner": "gmina",                // gmina | serwis | wykonawca
    "phase": 1,                      // 1 | 2 | 3 | null
    "auto": true,                    // wygenerowana z reguł
    "done": false
  }],

  "presets": [{
    "id": "P1",
    "name": "Wewnętrzny – budynek publiczny",
    "cost": 8500,
    "requiredFields": ["name","address","placement","access","keeper",
                       "signage.atDevice","signage.route","device.model",
                       "device.inspectionDue","dispatcherRegistered"],
    "requiredPhotos": ["device","signage_route"],
    "checklist": ["opiekun","oznakowanie wewnętrzne","oznakowanie dojścia"]
  }]
}
```

**Presety (stałe):** P1 Wewnętrzny – budynek publiczny 8 500 zł · P2 Wewnętrzny – obiekt 24/7 9 000 zł · P3 Zewnętrzny – szafka na elewacji 15 000 zł · P4 Zewnętrzny – słupek wolnostojący 24 000 zł · P5 Sezonowy / mobilny 6 000 zł.

---

## 5. Obliczenia (model.js) – dokładne wzory

**Czas dojścia** liczymy dla świadka biegnącego **do AED i z powrotem** do poszkodowanego – dlatego „w jedną stronę ≤ 2 min".

```js
const WALK_SPEED = 100;      // m/min
const DETOUR = 1.35;         // korekta linii prostej na trasę po ulicach

// promień strefy pokrycia dla standardu N minut (w jedną stronę)
radius = standardMinutes * WALK_SPEED / DETOUR;   // ERC 2 min → 148 m

// odległość (przybliżenie równopołudnikowe, wystarczające w skali miasta)
dy = (lat2 - lat1) * 111320;
dx = (lon2 - lon1) * 111320 * Math.cos(lat1 * Math.PI / 180);
dist = Math.hypot(dx, dy);

walkTime = dist * DETOUR / WALK_SPEED;            // minuty w jedną stronę
```

**Punkty popytu:** dla każdej dzielnicy rozrzuć `N` punktów (N ∝ ludność, np. `Math.max(20, population/200)`) w obrębie jej wielokąta, każdy z wagą `population / N`. Rozkład spiralny (golden angle) lub losowy z ziarnem – ważne, żeby był **deterministyczny** (te same dane = ten sam wynik).

**Pokrycie:** punkt popytu jest pokryty, jeśli istnieje AED w promieniu `radius`. Filtr trybu nocnego: bierz tylko punkty z `access.always === true`.

**KPI (panel „Wskaźniki – na żywo"):**

- `pokrycie` = suma wag pokrytych / suma wag × 100%
- `aedNa10tys` = liczba punktów / (population / 10000)
- `punkty24_7` = % punktów z `access.always`
- `medianaDojscia` = mediana `walkTime` do najbliższego AED po wszystkich punktach popytu
- Każdy KPI pokazywany jako **„teraz → po planie"** (plan = istniejące + zaakceptowane proponowane)

**Propozycje nowych punktów (greedy max coverage):**

1. Kandydaci = obiekty publiczne z `demo-tychy.json` (`candidates[]`).
2. Dla każdego kandydata policz sumę wag punktów popytu jeszcze niepokrytych w promieniu.
3. Wybierz najlepszego, oznacz jego zasięg jako pokryty, powtórz N razy (domyślnie 2, parametr w UI).
4. Wynik → punkty `kind:"proposed"`, `status:"proposed"`, z wyliczonym `+X% pokrycia`.
5. Przeciągnięcie pinu = przeliczenie KPI **na żywo** (throttle ~100 ms).

**Reguły auto-rekomendacji (uruchamiane po każdym zapisie karty):**

| Warunek | Rekomendacja | Priorytet | Koszt |
|---|---|---|---|
| `keeper.org` puste | Wyznaczyć opiekuna punktu | high | 0 |
| `dispatcherRegistered === false` | Zarejestrować AED u dyspozytora 112 | high | 0 |
| `device.inspectionDue` < dziś | Wykonać przegląd + wymiana elektrod | high | 600 |
| `signage.route === false` | Doznakować dojście od ulicy (ILCOR) | medium | 800 |
| `signage.atDevice === false` | Oznakować urządzenie znakiem ILCOR | medium | 300 |
| `access.always === false` | Rozważyć przeniesienie do strefy 24/7 | low | 0 |
| brak wymaganego zdjęcia | Uzupełnić dokumentację fotograficzną | low | 0 |

**Kompletność karty:** `(wypełnione pola wymagane presetu + wgrane wymagane zdjęcia) / (wszystkie wymagane) × 100%`, zaokrąglone. Steruje kolorem pinu: 100% → zielony, częściowo → żółty, `status:"unverified"` → czerwony.

---

## 6. Widoki – co dokładnie zbudować

Każdy widok odwzorowuje makietę z Figmy. Poniżej elementy obowiązkowe i zachowania.

### 6.0 Dashboard (`#/`)
Bez steppera. Top bar z „+ NOWY AUDYT". Kafelki projektów (Tychy / Brodnica / Człuchów) z: nazwą, statusem (`W TOKU` / `OFERTA`), paskiem postępu kroków 0–5, kluczowym wskaźnikiem, przyciskiem OTWÓRZ i akcjami Duplikuj / Archiwizuj. Czwarty kafelek = „+ NOWY AUDYT". Pod spodem dwie sekcje: **Ostatnie raporty** (lista z POBIERZ) i **Biblioteka presetów** (P1–P5 z kosztami, przycisk Edytuj presety).

### 6.1 Setup projektu (`#/setup`) – krok 0
Formularz w jednej kolumnie (560 px) + podgląd mapy po prawej.
Pola: nazwa gminy · granica (przycisk „Pobierz z rejestru PRG ⟳" – w makiecie: ładuje `boundary-tychy.geojson` z opóźnieniem 800 ms i pokazuje ✓) · ludność i dzielnice (CSV – akceptuj drop pliku, w demo wczytaj gotowy) · **standard czasu dojścia jako segmented control** (ERC ≤2 / miejski ≤3 / podstawowy ≤5 – zmiana natychmiast wpływa na `radius`) · import punktów AED (CSV / GeoJSON / OSM).
**Kandydatów NIE ma w tym kroku** – pojawiają się dopiero w kroku 2.
Podgląd mapy pokazuje granicę i zaimportowane piny. Pod nim „PODSUMOWANIE DANYCH": `14 AED · 12 dzielnic · 127 500 mieszkańców`.
CTA: „UTWÓRZ PROJEKT → KROK 1".

### 6.2 Inwentaryzacja (`#/inventory`) – krok 1
Mapa (lewa, ~65%) + panel „Rejestr punktów" (prawa, 480 px).
- Piny kolorowane statusem; **klik w pin → popup mini-karty** (nazwa, adres, preset, 3 znaczniki stanu, przycisk „OTWÓRZ KARTĘ →").
- Przycisk „+ DODAJ PUNKT" → tryb dodawania: klik na mapie tworzy pin i otwiera mini-formularz (nazwa, preset, adres) → punkt trafia do rejestru ze statusem `unverified`.
- Chipy filtrów: Wszystkie / 24/7 / z brakami / niezweryf. / dzielnica.
- Wiersz rejestru: kropka statusu, nazwa, meta, data weryfikacji (lub czerwone `NIEZWERYFIKOWANY`), menu `⋯`.
- Licznik w sub barze: `14 punktów: 6 ✓ · 5 ! · 3 ?`.
- Legenda na mapie (3 statusy).
- „IMPORT / EKSPORT CSV" na dole panelu.

### 6.3 Analiza dostępności (`#/analysis`) – krok 2
Mapa (~1100 px) + panel wskaźników (380 px).
- Warstwy: strefy pokrycia (wypełnienie 15% + obrys), cieniowanie luk z etykietą `LUKA: nazwa`, piny istniejące, **kwadratowe piny proponowane (przeciągalne)**.
- Przełączniki w sub barze: **[Stan obecny | Plan]** i **[Dzień | Noc (24/7)]** – oba przeliczają mapę i KPI.
- Panel: 4 kafelki KPI (2×2) → sekcja **Luki wg dzielnic** (nazwa, „X os. poza · max Y min", pasek) → **Propozycje nowych punktów** (karta z nazwą, presetem, `+X% pokrycia`, przyciskami ✓ / ✕) → przycisk **„ZAPROPONUJ NOWE PUNKTY"** → nota o modelu.
- Kandydaci pobierani (w demo: wczytywani z JSON) przy pierwszym uruchomieniu analizy.
- Akceptacja propozycji → punkt zmienia status na `accepted` i pojawia się w krokach 3 i 4.

### 6.4 Lista kart (`#/cards`) – krok 3
Tabela pełnej szerokości. Kolumny: PUNKT (kropka + nazwa + typ) · PRESET · KOMPLETNOŚĆ (pasek + %) · REKOMENDACJE (liczba + priorytet) · STATUS (pigułka) · [OTWÓRZ].
Pasek filtrów: [Wszystkie | Istniejące | Nowe], Preset ▾, Dzielnica ▾, ☐ tylko z brakami, Sortuj ▾.
Pasek akcji zbiorczych na dole: zaznaczanie, EKSPORT CSV, WYŚLIJ FORMULARZ TERENOWY (nieaktywny, tooltip „opcja poza MVP").

### 6.5 Karta punktu (`#/card/:id`) – krok 3
Dwie kolumny: sekcje karty (880 px) + panel boczny (520 px).
Sekcje 1–7 wg modelu danych, **każda z paskiem statusu po lewej** (czerwony = brak krytyczny, żółty = braki, brak paska = OK):
1 Identyfikacja (z galerią zdjęć wg slotów – §7) · 2 Preset (select) · 3 Dostępność · 4 Opiekun · 5 Oznakowanie · 6 Urządzenie · 7 **Rejestracja w systemie CPR 112/999** · 8 **Checklist zgodności + rekomendacje** (auto, z checkboxami, priorytetem i kosztem, edytowalne, możliwość dodania ręcznej).
Panel boczny: mini-mapa z przeciąganym pinem · pasek kompletności („60% · pola obowiązkowe: 6/10") · pigułka statusu · przyciski **ZAPISZ** i **DODAJ REKOM. → ROADMAPA** · nieaktywny „WYŚLIJ FORMULARZ TERENOWY".
Dla `kind:"proposed"` sekcje 3–6 puste, sekcja 7 pokazuje wytyczne montażu z presetu, nagłówek: „specyfikacja wdrożeniowa".

### 6.6 Roadmapa (`#/roadmap`) – krok 4, **dwa tryby**
Przełącznik w sub barze: **[Kanban | Oś czasu]**.

**Kanban:** 3 kolumny faz (zielona / żółta / fioletowa listwa u góry), nagłówek z zakresem miesięcy, kosztem i efektem na pokrycie. Karty pozycji z uchwytem `⋮⋮`, nazwą, meta (`odpowiedzialny · koszt`) i efektem. **Drag & drop między fazami** przelicza sumy. Przycisk „+ pozycja". Pod spodem pasek mapy z punktami w kolorach faz i przycisk „ZATWIERDŹ → RAPORT".

**Oś czasu (Gantt):** kolumna zadań (430 px) + oś 24 miesięcy w kwartałach (Q1 2026 … Q4 2027). Wiersze grupowane fazami, paski w kolorze fazy. Pod osią: **kamienie milowe** (trójkąty: „Zgodność podstawowa", „Pokrycie 71%", „Pokrycie 81%") i **krzywa pokrycia w czasie** (62% → 81%). W iteracji 2 wystarczy: przeciąganie paska zmienia `startMonth`, rozciąganie krawędzi zmienia `lengthMonths`.

Zadania spoza kart (dodać do danych demo): „Zamówienie 3 szt. AED (przetarg uproszczony)", „Dokumentacja i uzgodnienia (PZT, OSD)", „Przetarg na roboty + dostawę" – to one, nie montaż, decydują o terminach.

### 6.7 Raport (`#/report`) – krok 5
Trzy kolumny: miniatury stron (170 px) · podgląd strony A4 (620 px) · konfiguracja (562 px).
- Miniatury: 8 sekcji (Okładka, Exec summary, Stan obecny, Analiza, Rekomendacje, Roadmapa, Metodyka, Karty – załącznik). Klik przewija podgląd.
- Podgląd: nagłówek z brandingiem, **„PODSUMOWANIE DLA DECYDENTA – na jednej kartce"**: mapa jest/będzie + 5 KPI + zdanie kontekstowe: *„Karetka dojeżdża średnio w 8–15 min. Defibrylacja w 3–5 min daje 50–70% przeżywalności – każda minuta zwłoki to −10%."*
- Konfiguracja: checkboxy sekcji, data i kontakt, **GENERUJ PDF – SNAPSHOT** (w iteracji 2: `window.print()` z arkuszem `@media print`), eksporty CSV/XLSX/GeoJSON (CSV i GeoJSON zaimplementuj realnie), historia wersji.
- **5 KPI raportu:** pokrycie ≤2 min (62%→81%) · AED/10 tys. (1,4→2,1) · % 24/7 (43%) · % z opiekunem i ważnym przeglądem (57%) · koszt planu na mieszkańca objętego ochroną (3,10 zł).

### 6.8 Formularz terenowy (`#/field/:token`) – opcja
Widok mobilny (max 420 px), bez steppera i bez nawigacji: zdjęcia (min. 2 sloty), godziny dostępu, oznakowanie (radio), urządzenie, GPS auto, uwagi, „WYŚLIJ". Po wysłaniu: dane wpadają do karty z `verification.source = "formularz_terenowy"`. W iteracji 2 wystarczy działanie lokalne (bez realnego linku).

---

## 7. Zdjęcia – implementacja

**Sloty (role):** `device` (urządzenie) · `signage_device` (oznakowanie przy AED) · `signage_route` (oznakowanie dojścia) · `mounting_spot` (miejsce montażu – dla nowych) · `power` (punkt zasilania / trasa kabla) · `context` (otoczenie).

Zdjęcia to **dowody przypisane do kryteriów audytu**, nie galeria: preset określa, które sloty są wymagane, brak zdjęcia obniża % kompletności karty i generuje rekomendację, a raport wstawia zdjęcie z danego slotu we właściwą sekcję.

**Pipeline przy wgraniu (w całości po stronie przeglądarki):**

1. Odczytaj EXIF → zapisz GPS i datę do metadanych; **potem usuń EXIF** (RODO, orientacja).
2. Przeskaluj przez `canvas` do max 1600 px dłuższy bok, eksport WebP q0.8 (z ~5 MB robi się ~300 KB).
3. Wygeneruj miniaturę 300 px.
4. Policz SHA-256 → jeśli identyczne zdjęcie już istnieje przy punkcie, nie duplikuj.
5. Zapisz Blob w IndexedDB (store `photos`), metadane w `state`.

**W UI karty:** rząd slotów, każdy slot to kwadrat 106 px – miniatura albo pusty z etykietą i ikoną aparatu. Klik = podgląd/podmiana. Wymagane sloty bez zdjęcia mają żółte obramowanie.

**Ważne:** ta sama struktura metadanych zostaje w iteracji 3 – zmienia się tylko warstwa zapisu (dysk zamiast IndexedDB). Trzymaj dostęp do plików za dwiema funkcjami: `savePhoto(blob, meta)` i `getPhotoUrl(key)`.

---

## 8. Dane demo (`demo-tychy.json`)

**Tychy, 127 500 mieszkańców, 12 dzielnic** (poglądowe wielokąty). Granica gminy – realna z PRG, jeśli dostępna; inaczej uproszczony wielokąt.

**14 punktów istniejących**, w tym nazwane z makiet (pozostałe dogeneruj wiarygodnie):

| Nazwa | Preset | Status | Cechy |
|---|---|---|---|
| MOSiR, ul. Piłsudskiego 12 | P2 | verified_ok | 24/7, opiekun ✓, oznakowanie ✓, przegląd 05.2027, karta 90% |
| SP nr 7 – hol główny | P1 | verified_gaps | pn–pt 8–16, opiekun ✗, przegląd przeterminowany 03.2026, dojście nieoznakowane, brak rejestracji 112, karta 60% |
| UM Tychy, wejście A | P1 | verified_ok | 24/7, komplet, karta 100% |
| Basen „Paprocany" | P5 | verified_gaps | sezonowy, brak godzin zimą, oznakowanie częściowe, karta 55% |
| OSP Wilkowyje (z OSM) | – | unverified | brak danych, wymaga wizyty, karta 20% |
| Galeria „Azet" (z OSM) | – | unverified | prywatny właściciel, karta 20% |

**Kandydaci (~32):** 14 szkół, 6 obiektów sportowych, 5 urzędów/instytucji, 7 innych – z nazwami i współrzędnymi.

**Wynik działania modelu ma dawać w przybliżeniu:** pokrycie 62% → 81%, AED/10 tys. 1,4 → 2,1, punkty 24/7 43%, mediana 3,2 → 2,4 min, luki: Paprocany 4 100 os. / max 7 min, Żwaków 2 800 / 6 min, Stare Tychy 900 / 4 min. **Dostrój rozkład punktów demo tak, żeby liczby się zgadzały** – te wartości są w makietach i w materiałach dla klienta.

Roadmapa demo: Faza 1 3 200 zł (opiekunowie, rejestracja 112, przeglądy, doznakowanie) · Faza 2 26 000 zł (SP nr 1, biblioteka, hala sportowa) · Faza 3 39 000 zł (totem Paprocany 24 000, szafka Żwaków 15 000). Suma 68 200 zł.

---

## 9. Kolejność budowy (etapy – raportuj po każdym)

1. **Szkielet + design system.** `index.html`, `app.css`, router, top bar, sub bar, stepper, puste widoki. Klikanie po krokach działa.
2. **Stan i dane.** `state.js` + IndexedDB + wczytanie `demo-tychy.json`. Dashboard z prawdziwymi kafelkami. Eksport/import projektu do JSON.
3. **Mapa.** `map.js`: Mapbox, granica, piny wg statusu, popup mini-karty, dodawanie punktu klikiem. Widok Inwentaryzacja kompletny.
4. **Model + Analiza.** `model.js` (pokrycie, KPI, luki, greedy), strefy i luki na mapie, panel KPI na żywo, propozycje z akceptacją, przełączniki Plan i Noc.
5. **Karty.** Lista kart + karta punktu ze wszystkimi sekcjami, auto-rekomendacje, pasek kompletności.
6. **Zdjęcia.** `photos.js`: sloty, kompresja, EXIF, miniatury, IndexedDB, wpływ na kompletność.
7. **Roadmapa.** Kanban z drag & drop, potem tryb Oś czasu z kamieniami milowymi i krzywą pokrycia.
8. **Raport.** Podgląd HTML wszystkich sekcji, arkusz druku, eksport CSV i GeoJSON.
9. **Domknięcie.** Setup projektu (krok 0), formularz terenowy, przegląd wszystkich przycisków – żaden nie może być martwy.

---

## 10. Zasady, których nie łamiemy

- **Żadnego martwego przycisku.** Element niezaimplementowany ma być wyszarzony z tooltipem „poza zakresem iteracji 2".
- **Kolor tylko dla danych**, interfejs zostaje szary.
- **Wszystkie liczby liczone z modelu**, nie wpisane na sztywno w HTML – klient będzie klikał i sprawdzał, czy KPI reagują.
- **Polskie znaki wszędzie**, żadnych „Analiza dostepnosci".
- **Nie wprowadzaj bibliotek UI** (Tailwind, Bootstrap, React) – makieta ma być czytelna i modyfikowalna na żywo.
- **Nie usuwaj EXIF przed odczytaniem GPS** (kolejność ma znaczenie).
- Struktura danych z §4 jest kontraktem – iteracja 3 buduje na niej, więc nie zmieniaj nazw pól bez powodu.

---

## 11. Czego w tej iteracji NIE robimy

Izochron po sieci pieszej · realnego pobierania z PRG/GUS/OSM (dane z JSON) · generowania PDF po stronie serwera · kont i logowania · monitoringu czujników · pełnego solvera MCLP · integracji z Claude API do opisów.
