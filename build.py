#!/usr/bin/env python3
"""Składa pojedynczy plik index.html z szablonu, danych i bibliotek (vendor)."""
import json
import pathlib

ROOT = pathlib.Path(__file__).parent

def read(p: str) -> str:
    return (ROOT / p).read_text(encoding="utf-8")

boundary = json.loads(read("data/tychy_boundary.json"))
boundary_js = "const BOUNDARY = " + json.dumps(boundary, ensure_ascii=False, separators=(",", ":")) + ";"

# Realne AED z OpenStreetMap (Overpass), przycięte do granicy Tychów.
aed_osm = json.loads(read("data/aed_osm.json"))
aed_osm_js = "const AED_OSM = " + json.dumps(aed_osm, ensure_ascii=False, separators=(",", ":")) + ";"

html = read("src/template.html")
html = html.replace("{{LEAFLET_CSS}}", read("vendor/leaflet.css"))
html = html.replace("{{APP_CSS}}", read("src/app.css"))
html = html.replace("{{LEAFLET_JS}}", read("vendor/leaflet.js"))
html = html.replace("{{BOUNDARY_JS}}", boundary_js)
html = html.replace("{{AED_OSM_JS}}", aed_osm_js)
html = html.replace("{{DATA_JS}}", read("src/data.js"))
html = html.replace("{{APP_JS}}", read("src/app.js"))

out = ROOT / "index.html"
out.write_text(html, encoding="utf-8")
print(f"OK -> {out} ({out.stat().st_size/1024:.0f} KB)")
