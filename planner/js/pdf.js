/**
 * pdf.js — minimalny generator PDF pisany od zera, zero zależności.
 *
 * Powstał, bo klient chce pobierać karty punktów jako OSOBNE pliki PDF
 * (nie wydruk przeglądarki), a spec iteracji 2 zakazuje bibliotek runtime.
 *
 * Co umie i czego nie umie:
 *   • fonty: wbudowane Helvetica / Helvetica-Bold (Base14) — bez osadzania,
 *   • polskie znaki: /BaseEncoding /WinAnsiEncoding + /Differences dla liter
 *     z ogonkami i kreskami (kody jak w CP1250, glify nazwane wg Adobe),
 *   • tekst z łamaniem wierszy (metryki Helvetiki wpisane niżej), linie,
 *     prostokąty z wypełnieniem i obrysem,
 *   • wielostronicowość; współrzędne API idą OD GÓRY (jak w CSS) i są
 *     przeliczane na PDF-owe od dołu przy zapisie.
 * Świadomie nie ma: obrazków, kerningu, fontów osadzonych. Do kart audytu
 * to wystarcza; zdjęcia w karcie reprezentuje lista plików, nie miniatury.
 */

/* ------------------------------------------------------------------ *
 * Znaki spoza ASCII
 * ------------------------------------------------------------------ */

/**
 * Litery polskie: kod bajtu (jak w CP1250) + nazwa glifu Adobe. WinAnsi ma już
 * Ó/ó, cudzysłowy „ ” i pauzy, więc different są tylko te litery.
 */
const PL = {
  Ą: [0xa5, 'Aogonek'],
  ą: [0xb9, 'aogonek'],
  Ć: [0xc6, 'Cacute'],
  ć: [0xe6, 'cacute'],
  Ę: [0xca, 'Eogonek'],
  ę: [0xea, 'eogonek'],
  Ł: [0xa3, 'Lslash'],
  ł: [0xb3, 'lslash'],
  Ń: [0xd1, 'Nacute'],
  ń: [0xf1, 'nacute'],
  Ś: [0x8c, 'Sacute'],
  ś: [0x9c, 'sacute'],
  Ź: [0x8f, 'Zacute'],
  ź: [0x9f, 'zacute'],
  Ż: [0xaf, 'Zdotaccent'],
  ż: [0xbf, 'zdotaccent'],
};

/** Znaki WinAnsi poza ASCII, których używa interfejs. */
const WINANSI = {
  '„': 0x84,
  '…': 0x85,
  '‘': 0x91,
  '’': 0x92,
  '“': 0x93,
  '”': 0x94,
  '•': 0x95,
  '–': 0x96,
  '—': 0x97,
  '°': 0xb0,
  '·': 0xb7,
  Ó: 0xd3,
  ó: 0xf3,
};

/** Zamienniki znaków, których Helvetica Base14 nie ma. */
const FALLBACK = {
  '≤': '<=',
  '≥': '>=',
  '→': '->',
  '←': '<-',
  '✓': 'x',
  '✗': '-',
  '×': 'x',
  '↩': '<-',
  ' ': ' ',
  '’': "'",
};

function sanitize(str) {
  let out = String(str ?? '');
  for (const [from, to] of Object.entries(FALLBACK)) out = out.split(from).join(to);
  return out;
}

/** Tekst → bajty w naszym kodowaniu; znak nieznany → '?'. */
function encodeBytes(str) {
  const bytes = [];
  for (const ch of sanitize(str)) {
    const code = ch.codePointAt(0);
    if (code >= 32 && code <= 126) bytes.push(code);
    else if (PL[ch]) bytes.push(PL[ch][0]);
    else if (WINANSI[ch] !== undefined) bytes.push(WINANSI[ch]);
    else bytes.push(63); // '?'
  }
  return bytes;
}

/** Bajty tekstu → literał PDF ( … ) z oktalnymi sekwencjami dla >127. */
function pdfString(str) {
  let out = '(';
  for (const b of encodeBytes(str)) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) out += `\\${String.fromCharCode(b)}`;
    else if (b >= 32 && b <= 126) out += String.fromCharCode(b);
    else out += `\\${b.toString(8).padStart(3, '0')}`;
  }
  return `${out})`;
}

/* ------------------------------------------------------------------ *
 * Metryki Helvetiki (AFM, 1/1000 em) — do łamania wierszy
 * ------------------------------------------------------------------ */

// prettier-ignore
const HELV_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, // 32..47
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, // 48..63
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, // 64..79
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, // 80..95
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, // 96..111
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584, // 112..126
];

/** Szerokość litery polskiej = szerokość litery bazowej. */
const PL_BASE = { Ą: 'A', ą: 'a', Ć: 'C', ć: 'c', Ę: 'E', ę: 'e', Ł: 'L', ł: 'l', Ń: 'N', ń: 'n', Ś: 'S', ś: 's', Ź: 'Z', ź: 'z', Ż: 'Z', ż: 'z', Ó: 'O', ó: 'o' };

function charWidth(ch) {
  const code = ch.codePointAt(0);
  if (code >= 32 && code <= 126) return HELV_WIDTHS[code - 32];
  if (PL_BASE[ch]) return charWidth(PL_BASE[ch]);
  if (ch === '„' || ch === '”' || ch === '“') return 333;
  if (ch === '—') return 1000;
  if (ch === '–') return 556;
  if (ch === '…') return 1000;
  if (ch === '·' || ch === '•') return 350;
  return 556;
}

/* ------------------------------------------------------------------ *
 * Dokument
 * ------------------------------------------------------------------ */

const A4 = { width: 595.28, height: 841.89 };

export function createPdf(opts = {}) {
  const width = opts.width || A4.width;
  const height = opts.height || A4.height;

  /** Strumienie treści stron — tablica tablic operatorów. */
  const pages = [];
  let ops = null;

  const num = (v) => (Math.round(v * 100) / 100).toString();
  const toY = (y) => height - y; // API liczy od góry, PDF od dołu

  function addPage() {
    ops = [];
    pages.push(ops);
  }

  function measure(str, size, bold = false) {
    let units = 0;
    for (const ch of sanitize(str)) units += charWidth(ch);
    // Odmiana bold jest szersza — mnożnik trzyma łamanie po bezpiecznej stronie.
    return (units / 1000) * size * (bold ? 1.08 : 1);
  }

  /** Łamanie po słowach; słowo dłuższe niż wiersz jest cięte twardo. */
  function wrap(str, size, maxWidth, bold = false) {
    const lines = [];
    for (const rawLine of sanitize(str).split('\n')) {
      const words = rawLine.split(/\s+/).filter(Boolean);
      if (!words.length) {
        lines.push('');
        continue;
      }
      let line = '';
      for (const word of words) {
        const candidate = line ? `${line} ${word}` : word;
        if (measure(candidate, size, bold) <= maxWidth) {
          line = candidate;
          continue;
        }
        if (line) lines.push(line);
        if (measure(word, size, bold) <= maxWidth) {
          line = word;
          continue;
        }
        let chunk = '';
        for (const ch of word) {
          if (measure(chunk + ch, size, bold) > maxWidth && chunk) {
            lines.push(chunk);
            chunk = '';
          }
          chunk += ch;
        }
        line = chunk;
      }
      if (line) lines.push(line);
    }
    return lines;
  }

  const color = (c) => `${num(c[0])} ${num(c[1])} ${num(c[2])}`;

  /**
   * Rysuje tekst; zwraca liczbę narysowanych wierszy.
   * y = linia bazowa pierwszego wiersza, licząc od góry strony.
   */
  function text(str, x, y, o = {}) {
    const size = o.size || 10;
    const bold = o.bold === true;
    const lineHeight = (o.lineHeight || 1.35) * size;
    const lines = o.maxWidth ? wrap(str, size, o.maxWidth, bold) : [sanitize(str)];
    const fill = o.color || [0.12, 0.12, 0.12];
    lines.forEach((line, i) => {
      let tx = x;
      if (o.align === 'right') tx = x - measure(line, size, bold);
      else if (o.align === 'center') tx = x - measure(line, size, bold) / 2;
      ops.push(
        `BT /${bold ? 'F2' : 'F1'} ${num(size)} Tf ${color(fill)} rg ${num(tx)} ${num(toY(y + i * lineHeight))} Td ${pdfString(line)} Tj ET`
      );
    });
    return lines.length;
  }

  function rect(x, y, w, hgt, o = {}) {
    const parts = [];
    if (o.lineWidth) parts.push(`${num(o.lineWidth)} w`);
    if (o.fill) parts.push(`${color(o.fill)} rg`);
    if (o.stroke) parts.push(`${color(o.stroke)} RG`);
    parts.push(`${num(x)} ${num(toY(y + hgt))} ${num(w)} ${num(hgt)} re`);
    parts.push(o.fill && o.stroke ? 'B' : o.fill ? 'f' : 'S');
    ops.push(parts.join(' '));
  }

  function line(x1, y1, x2, y2, o = {}) {
    ops.push(
      `${num(o.width || 0.7)} w ${color(o.color || [0.85, 0.85, 0.83])} RG ` +
        `${num(x1)} ${num(toY(y1))} m ${num(x2)} ${num(toY(y2))} l S`
    );
  }

  /* ---------------- składanie pliku ---------------- */

  function output() {
    const objects = []; // 1-indeksowane treści obiektów (bez nagłówka "N 0 obj")

    const diffs = Object.values(PL)
      .sort((a, b) => a[0] - b[0])
      .map(([code, glyph]) => `${code} /${glyph}`)
      .join(' ');

    objects.push('<< /Type /Catalog /Pages 2 0 R >>'); // 1
    // Po sześciu obiektach stałych każda strona to para (treść, strona):
    // treść = 7 + 2i, strona = 8 + 2i.
    const pageObjIds = pages.map((_, i) => 8 + i * 2);
    objects.push(`<< /Type /Pages /Kids [${pageObjIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`); // 2
    objects.push(`<< /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [${diffs}] >>`); // 3
    objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding 3 0 R >>'); // 4
    objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding 3 0 R >>'); // 5
    objects.push('<< /F1 4 0 R /F2 5 0 R >>'); // 6 — słownik fontów wspólny dla stron

    for (const pageOps of pages) {
      const stream = pageOps.join('\n');
      objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`); // treść
      const contentId = objects.length;
      objects.push(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(width)} ${num(height)}] ` +
          `/Resources << /Font 6 0 R >> /Contents ${contentId} 0 R >>`
      );
    }

    let body = '%PDF-1.4\n%âãÏÓ\n';
    const offsets = [0];
    objects.forEach((content, i) => {
      offsets.push(body.length);
      body += `${i + 1} 0 obj\n${content}\nendobj\n`;
    });
    const xrefAt = body.length;
    body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (let i = 1; i <= objects.length; i++) {
      body += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
    }
    body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;

    const bytes = new Uint8Array(body.length);
    for (let i = 0; i < body.length; i++) bytes[i] = body.charCodeAt(i) & 0xff;
    return bytes;
  }

  addPage();
  return { width, height, addPage, text, rect, line, measure, wrap, output, pageCount: () => pages.length };
}
