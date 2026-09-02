#!/usr/bin/env python3
"""
bundle.py – squash the whole makieta into one self-contained HTML file.

Needed for previews that can only host a single file (and for handing the demo
to someone on a pendrive). ES modules are turned into lazily evaluated factory
functions in a tiny registry, data files are inlined and served through a fetch
shim, and the Mapbox CDN tags are dropped – the schematic map renderer takes
over, which is exactly what happens offline anyway.

    python3 tools/bundle.py            # -> dist/aed-planner-standalone.html
"""

import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "dist" / "aed-planner-standalone.html"

# Load order is irrelevant – the registry evaluates lazily – but listing them
# explicitly keeps the bundle deterministic and makes a missing file loud.
MODULES = [
    "config.js",
    "js/model.js",
    "js/ui.js",
    "js/state.js",
    "js/map.js",
    "js/photos.js",
    "js/report.js",
    "js/router.js",
    "js/views/dashboard.js",
    "js/views/setup.js",
    "js/views/inventory.js",
    "js/views/analysis.js",
    "js/views/cards.js",
    "js/views/card.js",
    "js/views/roadmap.js",
    "js/views/report-view.js",
    "js/views/field.js",
    "js/app.js",
]

DATA_FILES = [
    "data/boundary-tychy.geojson",
    "data/districts-tychy.geojson",
    "data/presets.json",
    "data/demo-tychy.json",
]

IMPORT_RE = re.compile(
    r"^import\s*\{(?P<names>[^}]*)\}\s*from\s*['\"](?P<path>[^'\"]+)['\"]\s*;?\s*$",
    re.MULTILINE | re.DOTALL,
)
DYNAMIC_IMPORT_RE = re.compile(r"import\(\s*['\"](?P<path>[^'\"]+)['\"]\s*\)")
EXPORT_RE = re.compile(
    r"^export\s+(?P<kind>const|let|var|function|async\s+function)\s+(?P<name>[A-Za-z_$][\w$]*)",
    re.MULTILINE,
)


def _norm(base: pathlib.PurePosixPath, rel: str) -> str:
    parts = list(base.parts)
    for chunk in rel.split("/"):
        if chunk in ("", "."):
            continue
        if chunk == "..":
            if parts:
                parts.pop()
        else:
            parts.append(chunk)
    return "/".join(parts)


def destructure(names: str) -> str:
    """`a, b as c` -> `a, b: c` so it works as an object pattern."""
    out = []
    for raw in names.split(","):
        item = raw.strip()
        if not item:
            continue
        m = re.match(r"^(\S+)\s+as\s+(\S+)$", item)
        out.append(f"{m.group(1)}: {m.group(2)}" if m else item)
    return ", ".join(out)


def transform(key: str, source: str) -> str:
    exported: list[str] = []

    def on_import(m: re.Match) -> str:
        target = _norm(pathlib.PurePosixPath(key).parent, m.group("path"))
        return f"const {{ {destructure(m.group('names'))} }} = __req('{target}');"

    code = IMPORT_RE.sub(on_import, source)

    def on_dynamic(m: re.Match) -> str:
        target = _norm(pathlib.PurePosixPath(key).parent, m.group("path"))
        return f"Promise.resolve(__req('{target}'))"

    code = DYNAMIC_IMPORT_RE.sub(on_dynamic, code)

    for m in EXPORT_RE.finditer(code):
        exported.append(m.group("name"))
    code = EXPORT_RE.sub(lambda m: f"{m.group('kind')} {m.group('name')}", code)

    if re.search(r"^\s*(import|export)\s", code, re.MULTILINE):
        leftovers = [
            line for line in code.splitlines()
            if re.match(r"^\s*(import|export)\s", line)
        ]
        sys.exit(f"nieprzetworzone instrukcje modułowe w {key}:\n  " + "\n  ".join(leftovers[:5]))

    returns = ", ".join(sorted(set(exported)))
    return f"__defs['{key}'] = function () {{\n{code}\nreturn {{ {returns} }};\n}};"


def main() -> None:
    missing = [p for p in MODULES + DATA_FILES if not (ROOT / p).exists()]
    if missing:
        sys.exit("brakuje plików: " + ", ".join(missing))

    modules_js = "\n\n".join(
        transform(key, (ROOT / key).read_text(encoding="utf-8")) for key in MODULES
    )
    data = {p: json.loads((ROOT / p).read_text(encoding="utf-8")) for p in DATA_FILES}
    css = (ROOT / "css" / "app.css").read_text(encoding="utf-8")

    html = f"""<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sinecco · AED Planner – makieta iteracji 2</title>
<style>
{css}
</style>
</head>
<body>
<div id="app" class="app"><div class="boot">Wczytywanie danych projektu…</div></div>
<script>
/* Inlined project data, served to the app through a fetch shim. */
const __FILES = {json.dumps(data, ensure_ascii=False, separators=(",", ":"))};
const __origFetch = window.fetch ? window.fetch.bind(window) : null;
window.fetch = function (input, init) {{
  const key = String(input && input.url ? input.url : input).replace(/^\\.\\//, '');
  if (Object.prototype.hasOwnProperty.call(__FILES, key)) {{
    return Promise.resolve(new Response(JSON.stringify(__FILES[key]), {{
      status: 200,
      headers: {{ 'Content-Type': 'application/json' }},
    }}));
  }}
  return __origFetch ? __origFetch(input, init) : Promise.reject(new Error('fetch niedostępny'));
}};

/* Minimal lazy module registry replacing the ES module graph. */
const __defs = {{}};
const __cache = {{}};
function __req(key) {{
  if (!(key in __cache)) {{
    if (!(key in __defs)) throw new Error('Brak modułu: ' + key);
    __cache[key] = __defs[key]();
  }}
  return __cache[key];
}}

{modules_js}

__req('js/app.js');
</script>
</body>
</html>
"""

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(html, encoding="utf-8")
    print(f"OK -> {OUT.relative_to(ROOT)} ({OUT.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
