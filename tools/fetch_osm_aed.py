#!/usr/bin/env python3
"""Pobiera realne AED z OpenStreetMap (Overpass API) dla Tychów i zapisuje
do data/aed_osm.json w schemacie aplikacji.

Kroki:
  1. Zapytanie Overpass o node/way emergency=defibrillator w bboxie Tychów.
  2. Mapowanie tagów OSM -> pola aplikacji (access/hours/indoor/owner/…).
     Pola signage (oznakowanie dojścia) i inspection (przegląd) NIE są opisane
     w OSM — ustawiane na wartości „do weryfikacji" (audyt terenowy).
  3. Przycięcie do granicy administracyjnej miasta (data/tychy_boundary.json).
  4. Dedupe punktów bliższych niż 25 m.

Uwaga: główny serwer overpass-api.de bywa przeciążony (błąd dispatchera);
skrypt próbuje kilku mirrorów po kolei.

Użycie:  python3 tools/fetch_osm_aed.py
"""
import json
import math
import pathlib
import re
import sys
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
BBOX = (50.06, 18.90, 50.19, 19.10)  # (S, W, N, E) — Tychy
MIRRORS = [
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
UA = "aed-audit-demo/1.0 (accessibility audit tool; github twentyonelab)"


def fetch_overpass() -> list:
    s, w, n, e = BBOX
    query = (
        "[out:json][timeout:60];("
        f'node["emergency"="defibrillator"]({s},{w},{n},{e});'
        f'way["emergency"="defibrillator"]({s},{w},{n},{e});'
        ");out center tags;"
    )
    data = urllib.parse.urlencode({"data": query}).encode()
    for url in MIRRORS:
        try:
            req = urllib.request.Request(url, data=data,
                                         headers={"User-Agent": UA, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=90) as r:
                payload = json.loads(r.read().decode("utf-8"))
            els = payload.get("elements", [])
            if els:
                print(f"Overpass OK ({url}): {len(els)} elementów", file=sys.stderr)
                return els
        except Exception as ex:  # noqa: BLE001
            print(f"  mirror nieudany {url}: {ex}", file=sys.stderr)
    raise SystemExit("Wszystkie mirrory Overpass zawiodły — spróbuj później.")


def clean(x: str) -> str:
    return re.sub(r"\s+", " ", (x or "").strip())


def to_schema(els: list) -> list:
    out = []
    for el in els:
        t = el.get("tags") or {}
        lat = el.get("lat") or (el.get("center") or {}).get("lat")
        lon = el.get("lon") or (el.get("center") or {}).get("lon")
        if lat is None or lon is None:
            continue
        oper = clean(t.get("operator", ""))
        locpl = clean(t.get("defibrillator:location:pl") or t.get("defibrillator:location") or "")
        oh = clean(t.get("opening_hours", ""))
        acc = t.get("access", "")
        street, hn = clean(t.get("addr:street", "")), clean(t.get("addr:housenumber", ""))
        addr = (street + " " + hn).strip() if street else (locpl or "lokalizacja wg OSM")
        if oh == "24/7":
            access, hours = "24/7", "całodobowo"
        elif oh:
            access, hours = "godziny", oh
        else:
            access, hours = "godziny", "b.d."
        if acc in ("private", "no"):
            access, hours = "ograniczony", hours + " (dostęp ograniczony)"
        out.append({
            "id": "OSM-%d" % el["id"],
            "name": oper or (locpl[:48] if locpl else "AED (OSM)"),
            "addr": addr,
            "lat": round(lat, 5), "lon": round(lon, 5),
            "indoor": (t.get("indoor", "yes") != "no"),
            "access": access, "hours": hours,
            "signage": False,       # OSM nie opisuje oznakowania dojścia -> audyt terenowy
            "inspection": "brak",   # OSM nie opisuje serwisu -> audyt terenowy
            "owner": oper or "wg OSM",
            "source": "OSM", "osm_id": el["id"],
            "loc_desc": locpl, "check_date": clean(t.get("check_date", "")),
            "phone": clean(t.get("phone", "")),
        })
    return out


def inside(lat: float, lon: float, ring: list) -> bool:
    n, ins, j = len(ring), False, len(ring) - 1
    for i in range(n):
        yi, xi = ring[i]
        yj, xj = ring[j]
        if ((xi > lon) != (xj > lon)) and (lat < (yj - yi) * (lon - xi) / (xj - xi) + yi):
            ins = not ins
        j = i
    return ins


def dist_m(a: dict, b: dict) -> float:
    dy = (a["lat"] - b["lat"]) * 111320
    dx = (a["lon"] - b["lon"]) * 111320 * math.cos(math.radians((a["lat"] + b["lat"]) / 2))
    return math.hypot(dx, dy)


def main() -> None:
    ring = json.loads((ROOT / "data/tychy_boundary.json").read_text(encoding="utf-8"))["ring_latlon"]
    pts = [p for p in to_schema(fetch_overpass()) if inside(p["lat"], p["lon"], ring)]
    dedup = []
    for p in pts:
        if not any(dist_m(p, q) < 25 for q in dedup):
            dedup.append(p)
    dedup.sort(key=lambda p: p["lat"])
    for i, p in enumerate(dedup, 1):
        p["id"] = "AED-%02d" % i
    (ROOT / "data/aed_osm.json").write_text(
        json.dumps(dedup, ensure_ascii=False, indent=1), encoding="utf-8")
    n247 = sum(1 for p in dedup if p["access"] == "24/7")
    print(f"Zapisano {len(dedup)} AED w granicy Tychów (24/7: {n247}) -> data/aed_osm.json")


if __name__ == "__main__":
    main()
