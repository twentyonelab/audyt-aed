/**
 * cardpdf.js – układ karty punktu jako PDF w „zamrożonej konwencji".
 *
 * Konwencja jest częścią umowy z klientem: karta wysłana do gminy ma wyglądać
 * tak samo niezależnie od tego, kto i kiedy ją wygeneruje. Dlatego layout
 * siedzi w jednym miejscu, liczby biorą się wyłącznie z model.js, a data na
 * stopce to TODAY z config.js (data odniesienia audytu, nie zegar komputera).
 *
 * Zdjęcia z audytu są osadzane w sekcji 1 jako miniatury JPEG (konwersja
 * WebP/SVG→JPEG przez canvas; wymaga przeglądarki – w Node karta powstaje
 * bez zdjęć, z samą listą plików).
 */

import { createPdf } from './pdf.js';
import { state, getPreset, districtName, recommendationsForPoint, getPhotoUrl } from './state.js';
import { completeness, expertScore, EXPERT_CRITERIA, EXPERT_FORMULA, PHASE_META, fmtPct, fmtNum, fmtCost } from './model.js';
import { statusMeta, photoRoleLabel, PRIORITY_LABEL } from './ui.js';
import { TODAY } from '../config.js';

const M = 44; // margines
const INK = [0.12, 0.12, 0.12];
const MUTED = [0.45, 0.45, 0.43];
const LINE = [0.85, 0.85, 0.83];
const BAR = [0.23, 0.23, 0.23];
const OK = [0.3, 0.69, 0.49];
const WARN = [0.91, 0.7, 0.24];
const CRIT = [0.85, 0.33, 0.31];

const VERDICT_COLOR = { ok: OK, warn: WARN, crit: CRIT };

function tri(value) {
  if (value === true) return 'tak';
  if (value === false) return 'NIE';
  return 'brak danych';
}

/** Nazwa pliku bez polskich znaków – bezpieczna dla każdego systemu plików. */
export function cardPdfFilename(point) {
  const translit = { ą: 'a', ć: 'c', ę: 'e', ł: 'l', ń: 'n', ó: 'o', ś: 's', ź: 'z', ż: 'z' };
  const slug = String(point.name || 'punkt')
    .toLowerCase()
    .replace(/[ąćęłńóśźż]/g, (ch) => translit[ch] || ch)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `${point.id}${slug ? `_${slug}` : ''}.pdf`;
}

/**
 * Blob zdjęcia (WebP/SVG/JPEG…) → JPEG do osadzenia w PDF.
 * Wymaga DOM – w środowisku bez przeglądarki zwraca null i karta powstaje
 * bez miniatur. Białe tło zamiast alfy, bo JPEG przezroczystości nie ma.
 */
async function blobToJpeg(blob, maxSide = 640) {
  if (typeof document === 'undefined' || typeof Image === 'undefined') return null;
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    let w = img.naturalWidth || 800;
    let h = img.naturalHeight || 600;
    const scale = Math.min(1, maxSide / Math.max(w, h));
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    const out = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
    if (!out) return null;
    return { bytes: new Uint8Array(await out.arrayBuffer()), w, h };
  } catch (err) {
    console.warn('Nie udało się przekonwertować zdjęcia do JPEG', err);
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Zdjęcia punktu jako JPEG-i gotowe do osadzenia (te, które dały się przekonwertować). */
async function loadPointJpegs(photos) {
  const out = [];
  for (const ph of photos) {
    try {
      const url = await getPhotoUrl(ph.blobKey);
      if (!url) continue;
      const blob = await (await fetch(url)).blob();
      const jpeg = await blobToJpeg(blob);
      if (jpeg) out.push({ ...jpeg, meta: ph });
    } catch (err) {
      console.warn(`Zdjęcie ${ph.id} pominięte w PDF`, err);
    }
  }
  return out;
}

export async function buildCardPdf(point) {
  const project = state.project || {};
  const preset = getPreset(point.presetId);
  const comp = completeness(point, preset, state.photos);
  const status = statusMeta(point, comp.pct);
  const score = expertScore(point);
  const recs = recommendationsForPoint(point.id);
  const photos = state.photos.filter((ph) => ph.pointId === point.id);
  const jpegs = await loadPointJpegs(photos);
  const isProposed = point.kind === 'proposed';

  const pdf = createPdf();
  const W = pdf.width;
  const contentW = W - 2 * M;
  let y = 0;
  let pageNo = 1;

  const footer = () => {
    pdf.line(M, pdf.height - 40, W - M, pdf.height - 40);
    pdf.text(`Audyt dostępności defibrylacji · ${project.label || project.name || ''} · wygenerowano ${TODAY}`, M, pdf.height - 28, {
      size: 8,
      color: MUTED,
    });
    pdf.text(`${point.id} · str. ${pageNo}`, W - M, pdf.height - 28, { size: 8, color: MUTED, align: 'right' });
  };

  const header = () => {
    pdf.rect(0, 0, W, 46, { fill: BAR });
    pdf.text('SINECCO · AED Planner', M, 29, { size: 12, bold: true, color: [1, 1, 1] });
    pdf.text('KARTA PUNKTU', W - M, 29, { size: 10, color: [1, 1, 1], align: 'right' });
    y = 74;
  };

  const breakIfNeeded = (needed) => {
    if (y + needed <= pdf.height - 56) return;
    footer();
    pdf.addPage();
    pageNo += 1;
    header();
  };

  /** Nagłówek sekcji: numer, tytuł, linia. */
  const section = (num, title, badge = null, badgeColor = MUTED) => {
    breakIfNeeded(46);
    y += 14;
    pdf.text(`${num} · ${title.toUpperCase()}`, M, y, { size: 9.5, bold: true, color: INK });
    if (badge) pdf.text(badge, W - M, y, { size: 9, bold: true, color: badgeColor, align: 'right' });
    y += 6;
    pdf.line(M, y, W - M, y);
    y += 16;
  };

  /** Wiersz etykieta → wartość (wartość łamana). */
  const row = (label, value, opts = {}) => {
    const labelW = 150;
    const val = value == null || value === '' ? '–' : String(value);
    const lines = pdf.wrap(val, 9.5, contentW - labelW - 10);
    breakIfNeeded(lines.length * 13 + 4);
    pdf.text(label, M, y, { size: 9, color: MUTED });
    pdf.text(val, M + labelW, y, { size: 9.5, color: opts.color || INK, maxWidth: contentW - labelW - 10, lineHeight: 1.35 });
    y += Math.max(1, lines.length) * 13 + 4;
  };

  const para = (txt, opts = {}) => {
    const size = opts.size || 9;
    const lines = pdf.wrap(txt, size, contentW);
    breakIfNeeded(lines.length * (size * 1.35) + 4);
    pdf.text(txt, M, y, { size, color: opts.color || MUTED, maxWidth: contentW });
    y += lines.length * size * 1.35 + 4;
  };

  /* ---------------- strona 1: nagłówek karty ---------------- */

  header();
  footer(); // stopka pierwszej strony – kolejne rysuje breakIfNeeded

  pdf.text(point.name || 'Punkt bez nazwy', M, y, { size: 15, bold: true, maxWidth: contentW - 120 });
  pdf.text(status.label, W - M, y, {
    size: 10,
    bold: true,
    align: 'right',
    color: VERDICT_COLOR[status.variant] || MUTED,
  });
  y += 18;
  pdf.text(
    `${point.id} · ${isProposed ? 'specyfikacja wdrożeniowa (punkt proponowany)' : 'specyfikacja punktu istniejącego'} · ${districtName(point.districtId)} · preset ${preset ? preset.id : '–'}`,
    M,
    y,
    { size: 9, color: MUTED }
  );
  y += 10;

  /* ---------------- sekcje ---------------- */

  section(1, 'Identyfikacja');
  row('Adres', point.address);
  row('Dzielnica', districtName(point.districtId));
  row('Współrzędne (WGS 84)', `${fmtNum(point.lat, 6)}, ${fmtNum(point.lon, 6)}`);
  row('Umiejscowienie', point.placement);
  row(
    'Dokumentacja foto',
    photos.length ? `${fmtNum(photos.length)} zdj. (${photos.map((ph) => photoRoleLabel(ph.role)).join(', ')})` : 'brak zdjęć'
  );

  // Miniatury zdjęć: dwie kolumny, podpis (rola · opis) pod każdą.
  if (jpegs.length) {
    const cols = 2;
    const gap = 12;
    const cellW = (contentW - gap * (cols - 1)) / cols;
    for (let i = 0; i < jpegs.length; i += cols) {
      const rowImgs = jpegs.slice(i, i + cols);
      const heights = rowImgs.map((im) => Math.min(150, (cellW * im.h) / im.w));
      const rowH = Math.max(...heights);
      breakIfNeeded(rowH + 26);
      rowImgs.forEach((im, c) => {
        const name = pdf.addImage(im.bytes, im.w, im.h);
        const drawH = heights[c];
        const drawW = Math.min(cellW, (drawH * im.w) / im.h);
        const x = M + c * (cellW + gap);
        pdf.drawImage(name, x, y, drawW, drawH);
        pdf.rect(x, y, drawW, drawH, { stroke: LINE, lineWidth: 0.8 });
        const caption = [photoRoleLabel(im.meta.role), im.meta.caption].filter(Boolean).join(' · ');
        pdf.text(caption, x, y + drawH + 11, { size: 7.5, color: MUTED, maxWidth: cellW });
      });
      y += rowH + 26;
    }
  }

  section(2, 'Preset punktu', preset ? fmtCost(preset.cost) : 'BRAK', preset ? INK : CRIT);
  row('Preset', preset ? `${preset.id} – ${preset.name}` : 'nie przypisano');
  if (preset) row('Koszt jednostkowy', fmtCost(preset.cost));

  if (!isProposed) {
    section(3, 'Dostępność');
    row('Dostęp całodobowy (24/7)', tri(point.access?.always), {
      color: point.access?.always === false ? CRIT : INK,
    });
    row('Godziny dostępu', point.access?.hours);
    row('Weekend', point.access?.weekend);
    row('Bariery dostępu', point.access?.barriers);

    section(4, 'Opiekun punktu');
    row('Organizacja', point.keeper?.org, { color: point.keeper?.org ? INK : CRIT });
    row('Osoba', point.keeper?.person);
    row('Kontakt', point.keeper?.contact);

    section(5, 'Oznakowanie');
    row('Znak ILCOR przy urządzeniu', tri(point.signage?.atDevice), {
      color: point.signage?.atDevice === false ? CRIT : INK,
    });
    row('Oznakowanie dojścia od ulicy', tri(point.signage?.route), {
      color: point.signage?.route === false ? CRIT : INK,
    });

    section(6, 'Urządzenie (AED)');
    row('Model', point.device?.model);
    row('Termin przeglądu', point.device?.inspectionDue);
    row('Termin elektrod', point.device?.padsDue);

    section(7, 'Rejestracja w systemie CPR 112/999');
    row('AED zgłoszone dyspozytorowi', tri(point.dispatcherRegistered), {
      color: point.dispatcherRegistered === false ? CRIT : INK,
    });
  } else {
    section(3, `Wytyczne montażu – preset ${preset ? preset.id : '–'}`);
    if (preset && (preset.checklist || []).length) {
      for (const item of preset.checklist) para(`• ${item}`, { color: INK, size: 9.5 });
    } else {
      para('Preset nie zawiera listy wytycznych montażowych.');
    }
    if (Number.isFinite(Number(point.gainPct))) {
      row('Zysk pokrycia po montażu', `+${fmtPct(point.gainPct, 1)}`);
    }
  }

  const compColor = comp.pct >= 100 ? OK : comp.pct >= 60 ? WARN : CRIT;
  section(8, 'Kompletność karty', fmtPct(comp.pct, 0), compColor);
  row('Pola obowiązkowe', `${fmtNum(comp.filled)} / ${fmtNum(comp.required)}`);
  if (comp.missingFields.length || comp.missingPhotos.length) {
    row(
      'Braki',
      [...comp.missingFields, ...comp.missingPhotos.map((role) => `zdjęcie: ${photoRoleLabel(role)}`)].join('; ')
    );
  }

  section(9, 'Checklist zgodności i rekomendacje', recs.length ? `${fmtNum(recs.length)} poz.` : 'brak', INK);
  if (!recs.length) {
    para('Brak rekomendacji – punkt spełnia wszystkie reguły automatyczne.');
  } else {
    for (const rec of recs) {
      const meta = [
        PRIORITY_LABEL[rec.priority] || rec.priority,
        fmtCost(rec.cost || 0),
        `odp.: ${rec.owner || '–'}`,
        rec.phase && PHASE_META[rec.phase] ? PHASE_META[rec.phase].label : 'poza roadmapą',
      ].join(' · ');
      const box = rec.done ? '[x]' : '[  ]';
      const lines = pdf.wrap(`${box} ${rec.text}`, 9.5, contentW - 12);
      breakIfNeeded(lines.length * 13 + 15);
      pdf.text(`${box} ${rec.text}`, M, y, { size: 9.5, color: INK, maxWidth: contentW - 12 });
      y += lines.length * 13;
      pdf.text(meta, M + 22, y, { size: 8, color: MUTED });
      y += 15;
    }
  }

  section(
    10,
    'Ocena ekspercka lokalizacji',
    score ? `${fmtNum(score.value, 1)} / 10 – ${score.verdict.label}` : 'NIEOCENIONA',
    score ? VERDICT_COLOR[score.verdict.variant] : WARN
  );
  para(EXPERT_FORMULA, { size: 8.5 });
  if (score) {
    for (const c of EXPERT_CRITERIA) {
      row(`[${c.key}] ${c.label} (${fmtNum(c.weight * 100, 0)}%)`, `${fmtNum(point.expert[c.key], 0)} / 10`);
    }
    row('Wynik końcowy', `${fmtNum(score.value, 1)} / 10 – ${score.verdict.label}`, {
      color: VERDICT_COLOR[score.verdict.variant],
    });
  } else {
    para('Lokalizacja nie została jeszcze oceniona przez audytora.');
  }
  if (point.expert?.note) row('Notatka eksperta', point.expert.note);

  return pdf.output();
}
