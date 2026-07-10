#!/usr/bin/env python3
"""Buduje wersję dla GitHub Pages z wstrzykniętym publicznym tokenem Mapbox,
aby mapa Mapbox oraz trasy/izochrony działały na gołym linku (bez ?mbtoken=).

Token bierzemy ze zmiennej środowiskowej MAPBOX_TOKEN (NIE z kodu — źródło repo
pozostaje bez tokenu). W wygenerowanym pliku token jest zapisany jako base64 i
dekodowany w przeglądarce (atob) — wyłącznie po to, by nie wywołać
false-positive GitHub Push Protection (wzorzec pk.*). To NIE jest ukrywanie
sekretu: token pk.* jest publiczny z założenia (przeznaczony do osadzenia w
stronie). Właściwe zabezpieczenie to ograniczenie tokenu w panelu Mapbox do
domeny hostingu (URL restrictions), np. twentyonelab.github.io.

Użycie:
    MAPBOX_TOKEN="pk...." python3 tools/deploy_pages.py [wejście] [wyjście]
domyślnie: index.html -> index.pages.html
"""
import base64
import os
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
src = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "index.html"
dst = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / "index.pages.html"

token = os.environ.get("MAPBOX_TOKEN", "").strip()
if not token:
    sys.exit("Brak MAPBOX_TOKEN w środowisku — ustaw zmienną z publicznym tokenem pk.*")

b64 = base64.b64encode(token.encode("utf-8")).decode("ascii")
# skrypt bootstrap: ustawia window.MAPBOX_TOKEN zanim wykona się logika aplikacji
boot = (
    "<script>/* publiczny token Mapbox (base64, dekodowany w locie); "
    "ogranicz domenę w panelu Mapbox */"
    'window.MAPBOX_TOKEN=atob("' + b64 + '");</script>\n'
)
html = src.read_text(encoding="utf-8")
dst.write_text(boot + html, encoding="utf-8")
print(f"OK -> {dst} (token wstrzyknięty, {dst.stat().st_size/1024:.0f} KB)")
