/**
 * photos.js — the photo pipeline (ITERACJA2_SPEC.md §7).
 *
 * Photos in this tool are *audit evidence bound to criteria*, not a gallery:
 * a preset declares which role slots are required, a missing one lowers card
 * completeness (model.js `completeness`) and raises an auto-recommendation.
 *
 * Everything happens in the browser, in this exact order (spec §10 — "nie
 * usuwaj EXIF przed odczytaniem GPS"):
 *
 *   1. read EXIF from the original bytes  (GPS, DateTimeOriginal, orientation)
 *   2. only then strip EXIF by redrawing through <canvas>, max 1600 px edge
 *   3. export to WebP q0.8 (JPEG when the browser cannot write WebP)
 *   4. render a 300 px thumbnail
 *   5. SHA-256 the full blob and refuse a duplicate on the same point
 *   6. blobs -> savePhotoBlob(), metadata -> state.photos, then save()
 *
 * The bytes are reached through exactly two state.js functions
 * (`savePhotoBlob` / `getPhotoUrl`), so iteration 3 only swaps their bodies
 * for disk access and this module stays as it is.
 *
 * Public API (used by js/views/card.js):
 *   attachPhoto(file, {pointId, role}) -> Promise<photoMeta|null>
 *   removePhoto(photoId)               -> Promise<void>
 *   renderPhotoSlots(container, point, preset, {onChange}) -> void
 */

import {
  state,
  save,
  getPoint,
  savePhotoBlob,
  getPhotoUrl,
  deletePhotoBlob,
} from './state.js';

import {
  h,
  el,
  mount,
  toast,
  modal,
  pickFile,
  PHOTO_ROLES,
  photoRoleLabel,
} from './ui.js';

import { completeness, fmtNum } from './model.js';

import { PHOTO_MAX_EDGE, PHOTO_THUMB_EDGE, PHOTO_QUALITY } from '../config.js';

/* ================================================================== *
 * 1. Minimal EXIF reader
 *
 * Hand-written on purpose: zero dependencies (spec §2). It understands just
 * enough of JPEG/TIFF to answer three questions — where was this taken, when
 * was it taken, which way is up. Anything it cannot parse yields empty
 * metadata; it never throws, because a photo without EXIF is still evidence.
 * ================================================================== */

/** EXIF lives in the first APP1 segment; 1 MB of head is far more than enough. */
const EXIF_SCAN_BYTES = 1024 * 1024;

const TAG_ORIENTATION = 0x0112;
const TAG_DATETIME = 0x0132;
const TAG_EXIF_IFD = 0x8769;
const TAG_GPS_IFD = 0x8825;
const TAG_DATETIME_ORIGINAL = 0x9003;
const TAG_DATETIME_DIGITIZED = 0x9004;
const TAG_GPS_LAT_REF = 0x0001;
const TAG_GPS_LAT = 0x0002;
const TAG_GPS_LON_REF = 0x0003;
const TAG_GPS_LON = 0x0004;

/** TIFF field type -> bytes per component. */
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

const EMPTY_EXIF = Object.freeze({ gps: null, takenAt: null, orientation: 1 });

/** Byte offset of the TIFF header inside an 'Exif\0\0' APP1 segment, or -1. */
function findExifTiffStart(view) {
  if (view.byteLength < 4) return -1;
  if (view.getUint16(0, false) !== 0xffd8) return -1; // not a JPEG (SOI)

  let offset = 2;
  while (offset + 4 <= view.byteLength) {
    if (view.getUint8(offset) !== 0xff) {
      offset += 1; // resync on padding / corrupt byte
      continue;
    }
    const marker = view.getUint8(offset + 1);

    if (marker === 0xff) {
      offset += 1; // fill byte
      continue;
    }
    // standalone markers carry no payload
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    // start of scan / end of image — image data begins, no more metadata
    if (marker === 0xda || marker === 0xd9) return -1;

    const size = view.getUint16(offset + 2, false);
    if (size < 2) return -1;

    if (marker === 0xe1 && offset + 10 <= view.byteLength) {
      let sig = '';
      for (let i = 0; i < 4; i++) sig += String.fromCharCode(view.getUint8(offset + 4 + i));
      if (sig === 'Exif' && view.getUint8(offset + 8) === 0 && view.getUint8(offset + 9) === 0) {
        return offset + 10;
      }
    }
    offset += 2 + size;
  }
  return -1;
}

function readTagValue(view, tiffStart, entryValueAt, type, count, little) {
  const size = TYPE_SIZE[type];
  if (!size || count <= 0 || count > 4096) return undefined;

  const total = size * count;
  let at = entryValueAt;
  if (total > 4) {
    if (entryValueAt + 4 > view.byteLength) return undefined;
    at = tiffStart + view.getUint32(entryValueAt, little);
  }
  if (at < 0 || at + total > view.byteLength) return undefined;

  if (type === 2) {
    let text = '';
    for (let i = 0; i < count; i++) {
      const code = view.getUint8(at + i);
      if (code === 0) break;
      text += String.fromCharCode(code);
    }
    return text;
  }

  const values = [];
  for (let i = 0; i < count; i++) {
    const o = at + i * size;
    switch (type) {
      case 1:
      case 7:
        values.push(view.getUint8(o));
        break;
      case 3:
        values.push(view.getUint16(o, little));
        break;
      case 4:
        values.push(view.getUint32(o, little));
        break;
      case 5: {
        const num = view.getUint32(o, little);
        const den = view.getUint32(o + 4, little);
        values.push(den ? num / den : 0);
        break;
      }
      case 6:
        values.push(view.getInt8(o));
        break;
      case 8:
        values.push(view.getInt16(o, little));
        break;
      case 9:
        values.push(view.getInt32(o, little));
        break;
      case 10: {
        const num = view.getInt32(o, little);
        const den = view.getInt32(o + 4, little);
        values.push(den ? num / den : 0);
        break;
      }
      case 11:
        values.push(view.getFloat32(o, little));
        break;
      case 12:
        values.push(view.getFloat64(o, little));
        break;
      default:
        return undefined;
    }
  }
  return count === 1 ? values[0] : values;
}

/** Read one IFD into a {tag: value} object. */
function readIfd(view, tiffStart, ifdOffset, little) {
  const out = {};
  const base = tiffStart + ifdOffset;
  if (ifdOffset <= 0 || base + 2 > view.byteLength) return out;

  const entries = view.getUint16(base, little);
  if (entries > 512) return out; // implausible — treat as corrupt

  for (let i = 0; i < entries; i++) {
    const p = base + 2 + i * 12;
    if (p + 12 > view.byteLength) break;
    const tag = view.getUint16(p, little);
    const type = view.getUint16(p + 2, little);
    const count = view.getUint32(p + 4, little);
    const value = readTagValue(view, tiffStart, p + 8, type, count, little);
    if (value !== undefined) out[tag] = value;
  }
  return out;
}

/** GPS degrees/minutes/seconds triple + N/S/E/W reference -> signed decimal. */
function dmsToDecimal(parts, ref) {
  const list = Array.isArray(parts) ? parts : [parts];
  if (!list.length) return null;
  const deg = Number(list[0]) || 0;
  const min = Number(list[1]) || 0;
  const sec = Number(list[2]) || 0;
  let value = Math.abs(deg) + Math.abs(min) / 60 + Math.abs(sec) / 3600;
  if (!Number.isFinite(value)) return null;
  const hemisphere = String(ref || '').trim().toUpperCase().charAt(0);
  if (hemisphere === 'S' || hemisphere === 'W') value = -value;
  return value;
}

/** 'YYYY:MM:DD HH:MM:SS' -> 'YYYY-MM-DDTHH:MM' (the shape used in spec §4). */
function exifDateToIso(raw) {
  const match = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2})/.exec(String(raw || '').trim());
  if (!match) return null;
  const [, y, mo, d, hh, mm] = match;
  if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31) return null;
  return `${y}-${mo}-${d}T${hh}:${mm}`;
}

/**
 * STEP 1 — read GPS, capture date and orientation from the ORIGINAL file,
 * before any canvas pass destroys them.
 *
 * @returns {Promise<{gps:{lat:number,lon:number}|null, takenAt:string|null, orientation:number}>}
 */
async function readExifMeta(file) {
  try {
    const head = file.slice(0, Math.min(file.size, EXIF_SCAN_BYTES));
    const buffer = await head.arrayBuffer();
    const view = new DataView(buffer);

    const tiffStart = findExifTiffStart(view);
    if (tiffStart < 0 || tiffStart + 8 > view.byteLength) return { ...EMPTY_EXIF };

    const order = view.getUint16(tiffStart, false);
    if (order !== 0x4949 && order !== 0x4d4d) return { ...EMPTY_EXIF };
    const little = order === 0x4949;
    if (view.getUint16(tiffStart + 2, little) !== 42) return { ...EMPTY_EXIF };

    const ifd0 = readIfd(view, tiffStart, view.getUint32(tiffStart + 4, little), little);

    let orientation = Number(ifd0[TAG_ORIENTATION]) || 1;
    if (!(orientation >= 1 && orientation <= 8)) orientation = 1;

    const exifIfd = ifd0[TAG_EXIF_IFD]
      ? readIfd(view, tiffStart, Number(ifd0[TAG_EXIF_IFD]), little)
      : {};
    const gpsIfd = ifd0[TAG_GPS_IFD]
      ? readIfd(view, tiffStart, Number(ifd0[TAG_GPS_IFD]), little)
      : {};

    const takenAt =
      exifDateToIso(exifIfd[TAG_DATETIME_ORIGINAL]) ||
      exifDateToIso(exifIfd[TAG_DATETIME_DIGITIZED]) ||
      exifDateToIso(ifd0[TAG_DATETIME]);

    let gps = null;
    if (gpsIfd[TAG_GPS_LAT] !== undefined && gpsIfd[TAG_GPS_LON] !== undefined) {
      const lat = dmsToDecimal(gpsIfd[TAG_GPS_LAT], gpsIfd[TAG_GPS_LAT_REF]);
      const lon = dmsToDecimal(gpsIfd[TAG_GPS_LON], gpsIfd[TAG_GPS_LON_REF]);
      const usable =
        lat !== null &&
        lon !== null &&
        Math.abs(lat) <= 90 &&
        Math.abs(lon) <= 180 &&
        !(lat === 0 && lon === 0);
      if (usable) gps = { lat, lon };
    }

    return { gps, takenAt, orientation };
  } catch (err) {
    // A photo we cannot parse is still a valid photo — never block the upload.
    console.warn('EXIF: nie udało się odczytać metadanych', err);
    return { ...EMPTY_EXIF };
  }
}

/* ================================================================== *
 * 2-4. Canvas pass: strip EXIF, rescale, export, thumbnail
 * ================================================================== */

/**
 * Decode WITHOUT the browser auto-applying EXIF orientation, so step 2 can
 * apply it deliberately (and exactly once).
 */
async function loadRawBitmap(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'none' });
      return { source: bitmap, release: () => bitmap.close && bitmap.close() };
    } catch (err) {
      // older engines: fall through to the <img> path
    }
  }

  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise((resolve, reject) => {
      const node = new Image();
      node.onload = () => resolve(node);
      node.onerror = () => reject(new Error('Nie udało się zdekodować obrazu.'));
      try {
        node.style.imageOrientation = 'none';
      } catch (err) {
        /* property unsupported — orientation may already be baked in */
      }
      node.src = url;
    });
    return { source: image, release: () => URL.revokeObjectURL(url) };
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
}

/** Canvas transform for EXIF orientation tag 0x0112 (values 1-8). */
function applyOrientation(ctx, orientation, w, h) {
  switch (orientation) {
    case 2: ctx.transform(-1, 0, 0, 1, w, 0); break;   // mirror horizontally
    case 3: ctx.transform(-1, 0, 0, -1, w, h); break;  // 180°
    case 4: ctx.transform(1, 0, 0, -1, 0, h); break;   // mirror vertically
    case 5: ctx.transform(0, 1, 1, 0, 0, 0); break;    // transpose
    case 6: ctx.transform(0, 1, -1, 0, h, 0); break;   // 90° CW
    case 7: ctx.transform(0, -1, -1, 0, h, w); break;  // transverse
    case 8: ctx.transform(0, -1, 1, 0, 0, w); break;   // 90° CCW
    default: break;                                    // 1 — already upright
  }
}

/**
 * STEP 2 — redraw through a canvas. This is what actually removes EXIF: the
 * canvas holds pixels only, so nothing but the image survives the copy.
 */
function drawUpright(source, rawW, rawH, maxEdge, orientation) {
  const swap = orientation >= 5 && orientation <= 8;
  const shownW = swap ? rawH : rawW;
  const shownH = swap ? rawW : rawH;
  const longest = Math.max(shownW, shownH) || 1;
  const scale = Math.min(1, maxEdge / longest);

  const w = Math.max(1, Math.round(rawW * scale));
  const h = Math.max(1, Math.round(rawH * scale));

  const canvas = document.createElement('canvas');
  canvas.width = swap ? h : w;
  canvas.height = swap ? w : h;

  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; // flatten transparency for WebP/JPEG
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  applyOrientation(ctx, orientation, w, h);
  ctx.drawImage(source, 0, 0, w, h);
  return canvas;
}

/** STEP 4 — thumbnail, taken from the already-upright canvas. */
function scaleCanvas(src, maxEdge) {
  const scale = Math.min(1, maxEdge / (Math.max(src.width, src.height) || 1));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(src.width * scale));
  canvas.height = Math.max(1, Math.round(src.height * scale));
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  return canvas;
}

let webpSupport = null;

function supportsWebp() {
  if (webpSupport !== null) return webpSupport;
  try {
    const probe = document.createElement('canvas');
    probe.width = 1;
    probe.height = 1;
    webpSupport = probe.toDataURL('image/webp').indexOf('data:image/webp') === 0;
  } catch (err) {
    webpSupport = false;
  }
  return webpSupport;
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => {
    if (typeof canvas.toBlob === 'function') {
      canvas.toBlob((blob) => resolve(blob), type, quality);
      return;
    }
    resolve(null);
  });
}

/** STEP 3 — WebP q0.8, with a JPEG fallback for engines that cannot write it. */
async function exportCanvas(canvas) {
  const preferred = supportsWebp() ? 'image/webp' : 'image/jpeg';
  let blob = await canvasToBlob(canvas, preferred, PHOTO_QUALITY);
  if (!blob || (preferred === 'image/webp' && blob.type !== 'image/webp')) {
    blob = await canvasToBlob(canvas, 'image/jpeg', PHOTO_QUALITY);
  }
  if (!blob) throw new Error('Przeglądarka nie potrafi zapisać przetworzonego zdjęcia.');
  return blob;
}

/* ================================================================== *
 * 5. Content hash
 * ================================================================== */

/**
 * SHA-256 of the exported blob. crypto.subtle needs a secure context; when it
 * is missing (plain http:// on a LAN) we fall back to a cheap FNV-1a digest so
 * duplicate detection still works inside one session.
 */
async function hashBlob(blob) {
  const buffer = await blob.arrayBuffer();
  if (globalThis.crypto && globalThis.crypto.subtle && globalThis.crypto.subtle.digest) {
    try {
      const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer);
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch (err) {
      console.warn('crypto.subtle niedostępne — używam zapasowego skrótu', err);
    }
  }
  const bytes = new Uint8Array(buffer);
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a-${bytes.length.toString(16)}-${hash.toString(16).padStart(8, '0')}`;
}

/* ================================================================== *
 * 6. Metadata + persistence
 * ================================================================== */

/** 'ph-' + next free number, matching the ids seeded in state.js. */
function nextPhotoId() {
  const used = state.photos
    .map((p) => p.id)
    .filter((id) => typeof id === 'string' && /^ph-\d+$/.test(id))
    .map((id) => parseInt(id.slice(3), 10))
    .filter((n) => !Number.isNaN(n));
  const next = (used.length ? Math.max(...used) : 0) + 1;
  return `ph-${String(next).padStart(3, '0')}`;
}

function isImageFile(file) {
  if (!file) return false;
  if (file.type) return file.type.startsWith('image/');
  return /\.(jpe?g|png|webp|gif|bmp|heic|heif)$/i.test(file.name || '');
}

/**
 * Run the whole pipeline for one file and register the result.
 *
 * @param {File|Blob} file
 * @param {{pointId:string, role:string}} target
 * @returns {Promise<object|null>} photoMeta (spec §4) or null when refused
 */
export async function attachPhoto(file, { pointId, role } = {}) {
  const point = getPoint(pointId);
  if (!point) {
    toast('Nie znaleziono punktu, do którego miało trafić zdjęcie.');
    return null;
  }
  if (!PHOTO_ROLES.some((r) => r.id === role)) {
    toast('Nieznany slot zdjęcia.');
    return null;
  }
  if (!isImageFile(file)) {
    toast('To nie jest plik graficzny — wybierz JPEG, PNG lub WebP.');
    return null;
  }

  let bitmap = null;
  try {
    // 1. EXIF FIRST — the canvas pass below destroys it irreversibly.
    const exif = await readExifMeta(file);

    // 2. rescale + strip EXIF + straighten
    bitmap = await loadRawBitmap(file);
    const rawW = bitmap.source.width || bitmap.source.naturalWidth || 0;
    const rawH = bitmap.source.height || bitmap.source.naturalHeight || 0;
    if (!rawW || !rawH) throw new Error('Obraz ma zerowe wymiary.');

    const full = drawUpright(bitmap.source, rawW, rawH, PHOTO_MAX_EDGE, exif.orientation);

    // 3. export
    const blob = await exportCanvas(full);

    // 4. thumbnail
    const thumbBlob = await exportCanvas(scaleCanvas(full, PHOTO_THUMB_EDGE));

    // 5. deduplicate within the point
    const hash = await hashBlob(blob);
    const twin = state.photos.find((ph) => ph.pointId === pointId && ph.hash === hash);
    if (twin) {
      toast('To zdjęcie jest już dodane do tego punktu.');
      return twin;
    }

    // 6. persist bytes, then metadata
    const id = nextPhotoId();
    const blobKey = id;
    const thumbKey = `${id}-t`;
    await savePhotoBlob(blobKey, blob);
    await savePhotoBlob(thumbKey, thumbBlob);

    const meta = {
      id,
      pointId,
      role,
      caption: '',
      takenAt: exif.takenAt,
      gps: exif.gps,
      width: full.width,
      height: full.height,
      bytes: blob.size,
      blobKey,
      thumbKey,
      hash,
    };

    state.photos.push(meta);
    if (!Array.isArray(point.photos)) point.photos = [];
    if (!point.photos.includes(id)) point.photos.push(id);

    await save();
    return meta;
  } catch (err) {
    console.warn('attachPhoto() nie powiodło się', err);
    toast('Nie udało się przetworzyć zdjęcia. Spróbuj z innym plikiem.');
    return null;
  } finally {
    if (bitmap && bitmap.release) {
      try {
        bitmap.release();
      } catch (err) {
        /* ignore */
      }
    }
  }
}

/**
 * Drop a photo: blobs from IndexedDB, metadata from state, id from every
 * point that references it.
 */
export async function removePhoto(photoId) {
  const meta = state.photos.find((ph) => ph.id === photoId);
  if (!meta) return;

  await deletePhotoBlob(meta.blobKey);
  if (meta.thumbKey && meta.thumbKey !== meta.blobKey) await deletePhotoBlob(meta.thumbKey);

  state.photos = state.photos.filter((ph) => ph.id !== photoId);
  for (const point of state.points) {
    if (Array.isArray(point.photos) && point.photos.includes(photoId)) {
      point.photos = point.photos.filter((id) => id !== photoId);
    }
  }

  await save();
}

/* ================================================================== *
 * UI — the slot row (spec §7)
 * ================================================================== */

function cameraIcon() {
  return el(
    `<span class="photo-slot__icon" aria-hidden="true">` +
      `<svg width="20" height="16" viewBox="0 0 20 16" fill="none" stroke="currentColor" ` +
      `stroke-width="1.3" stroke-linejoin="round">` +
      `<rect x="0.8" y="3.3" width="18.4" height="12" rx="1.5"/>` +
      `<path d="M6.3 3.3 7.7 0.8h4.6l1.4 2.5"/>` +
      `<circle cx="10" cy="9.4" r="3.3"/>` +
      `</svg></span>`
  );
}

/** 'YYYY-MM-DDTHH:MM' -> '12.07.2026, 10:22'. */
function formatTakenAt(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(String(value || ''));
  if (!match) return null;
  const [, y, mo, d, hh, mm] = match;
  return hh ? `${d}.${mo}.${y}, ${hh}:${mm}` : `${d}.${mo}.${y}`;
}

function formatBytes(bytes) {
  const kb = (Number(bytes) || 0) / 1024;
  if (kb >= 1024) return `${fmtNum(kb / 1024, 1)} MB`;
  return `${fmtNum(kb)} kB`;
}

function highlightSlot(slot, on) {
  slot.style.borderColor = on ? 'var(--bar)' : '';
  slot.style.borderWidth = on ? '2px' : '';
}

function setSlotBusy(slot, roleLabel) {
  slot.style.pointerEvents = 'none';
  slot.style.opacity = '0.65';
  slot.setAttribute('aria-busy', 'true');
  mount(
    slot,
    h(
      'div',
      { class: 'photo-slot__label' },
      h('strong', { text: 'przetwarzanie…' }),
      h('div', { text: roleLabel })
    )
  );
}

/**
 * Preview modal: full photo, editable caption, EXIF read-out, delete/replace.
 * `modal()` only offers confirm/cancel, so the secondary actions record an
 * intent and then close the dialog through its own cancel button — that keeps
 * the promise and the Escape listener in ui.js properly cleaned up.
 */
async function openPhotoModal(meta, { onChange } = {}) {
  let intent = null;

  const preview = h('img', {
    alt: `Zdjęcie: ${photoRoleLabel(meta.role)}`,
    style: {
      display: 'block',
      width: '100%',
      maxHeight: '300px',
      objectFit: 'contain',
      background: 'var(--section)',
      border: '1px solid var(--line)',
      borderRadius: '2px',
    },
  });

  const captionInput = h('input', {
    class: 'input',
    type: 'text',
    value: meta.caption || '',
    placeholder: 'np. AED przy portierni, widok od wejścia',
    maxlength: '120',
  });

  const gpsLine = meta.gps
    ? `GPS z EXIF: ${fmtNum(meta.gps.lat, 5)}, ${fmtNum(meta.gps.lon, 5)}`
    : 'GPS: brak współrzędnych w pliku';
  const dateLine = meta.takenAt
    ? `Data wykonania: ${formatTakenAt(meta.takenAt)}`
    : 'Data wykonania: brak w metadanych pliku';

  const closeDialog = (value) => {
    intent = value;
    const box = body.closest('.modal');
    const cancel = box && box.querySelector('.modal__foot .btn:not(.btn--primary)');
    if (cancel) cancel.click();
    else {
      const backdrop = body.closest('.modal-backdrop');
      if (backdrop) backdrop.remove();
    }
  };

  const body = h(
    'div',
    { class: 'stack' },
    preview,
    h(
      'label',
      { class: 'field' },
      h('span', { class: 'field__label', text: 'Podpis zdjęcia' }),
      captionInput
    ),
    h(
      'div',
      { class: 'note' },
      h('div', { text: `Slot: ${photoRoleLabel(meta.role)}` }),
      h('div', { text: dateLine }),
      h('div', { text: gpsLine }),
      h('div', {
        text:
          `Plik: ${fmtNum(meta.width)} × ${fmtNum(meta.height)} px · ${formatBytes(meta.bytes)}`,
      }),
      h('div', {
        text:
          'EXIF został usunięty z zapisanego pliku (RODO); GPS i datę odczytano ' +
          'z oryginału przed przetworzeniem.',
      })
    ),
    h(
      'div',
      { class: 'row' },
      h('button', {
        class: 'btn btn--sm',
        type: 'button',
        text: 'Podmień zdjęcie',
        onclick: () => closeDialog('replace'),
      }),
      h('span', { class: 'spacer' }),
      h('button', {
        class: 'btn btn--sm btn--danger',
        type: 'button',
        text: 'Usuń zdjęcie',
        onclick: () => closeDialog('delete'),
      })
    )
  );

  // The object URL resolves after the dialog is already on screen.
  getPhotoUrl(meta.blobKey)
    .then((url) => {
      if (url) preview.src = url;
    })
    .catch(() => {});

  const confirmed = await modal({
    title: `Zdjęcie — ${photoRoleLabel(meta.role)}`,
    body,
    confirmLabel: 'Zapisz podpis',
    cancelLabel: 'Zamknij',
  });

  if (intent === 'delete') {
    const sure = await modal({
      title: 'Usunąć zdjęcie?',
      body: h('div', {
        class: 'note',
        text: 'Zdjęcie zniknie z karty punktu i z raportu. Tej operacji nie można cofnąć.',
      }),
      confirmLabel: 'Usuń',
      cancelLabel: 'Zostaw',
    });
    if (!sure) return;
    await removePhoto(meta.id);
    toast('Zdjęcie usunięte.');
    if (onChange) await onChange();
    return;
  }

  if (intent === 'replace') {
    const file = await pickFile('image/*');
    if (!file) return;
    const fresh = await attachPhoto(file, { pointId: meta.pointId, role: meta.role });
    if (fresh && fresh.id !== meta.id) {
      await removePhoto(meta.id);
      toast('Zdjęcie podmienione.');
    }
    if (onChange) await onChange();
    return;
  }

  if (confirmed) {
    const value = captionInput.value.trim();
    if (value !== (meta.caption || '')) {
      meta.caption = value;
      await save();
    }
    if (onChange) await onChange();
  }
}

/**
 * Render one 106×106 slot per role from PHOTO_ROLES.
 *
 * Synchronous by contract — card.js calls it inside its render pass — while
 * thumbnails and uploads resolve afterwards.
 *
 * @param {HTMLElement} container
 * @param {object} point
 * @param {object|null} preset
 * @param {{onChange?:Function}} handlers
 */
export function renderPhotoSlots(container, point, preset, { onChange } = {}) {
  if (!container || !point) return;

  const requiredRoles = new Set((preset && preset.requiredPhotos) || []);
  const pointPhotos = state.photos.filter((ph) => ph.pointId === point.id);

  const byRole = new Map();
  for (const photo of pointPhotos) {
    if (!byRole.has(photo.role)) byRole.set(photo.role, []);
    byRole.get(photo.role).push(photo);
  }

  const notify = async () => {
    if (onChange) await onChange();
  };

  const upload = async (slot, role, file) => {
    if (!file) return;
    if (!isImageFile(file)) {
      toast('To nie jest plik graficzny — wybierz JPEG, PNG lub WebP.');
      return;
    }
    setSlotBusy(slot, photoRoleLabel(role));
    const meta = await attachPhoto(file, { pointId: point.id, role });
    if (meta) await notify();
    // save() inside attachPhoto repaints the card; if it did not (refusal or
    // error) restore the slot so it stays clickable.
    if (slot.isConnected) {
      slot.style.pointerEvents = '';
      slot.style.opacity = '';
      slot.removeAttribute('aria-busy');
      if (!meta) mount(slot, ...emptySlotChildren(role, requiredRoles.has(role)));
    }
  };

  const row = h('div', { class: 'photo-slots' });

  for (const role of PHOTO_ROLES) {
    const photos = byRole.get(role.id) || [];
    const photo = photos[0] || null;
    const isRequired = requiredRoles.has(role.id);
    const missingRequired = isRequired && !photo;

    const slot = h('div', {
      class: `photo-slot${missingRequired ? ' is-required-missing' : ''}`,
      role: 'button',
      tabindex: '0',
      'aria-label': photo
        ? `Zdjęcie: ${role.label} — otwórz podgląd`
        : `Dodaj zdjęcie: ${role.label}${isRequired ? ' (wymagane przez preset)' : ''}`,
      'data-tip': photo
        ? `${role.label} — kliknij, aby otworzyć podgląd`
        : `${role.label} — kliknij lub przeciągnij plik${isRequired ? ' · wymagane przez preset' : ''}`,
    });

    if (photo) {
      const img = h('img', { alt: photo.caption || role.label });
      getPhotoUrl(photo.thumbKey || photo.blobKey)
        .then((url) => {
          if (url) img.src = url;
        })
        .catch(() => {});
      const extra = photos.length > 1 ? ` (+${fmtNum(photos.length - 1)})` : '';
      slot.appendChild(img);
      slot.appendChild(
        h('span', {
          class: 'photo-slot__badge',
          text: `${photo.caption || role.label}${extra}`,
        })
      );
    } else {
      for (const child of emptySlotChildren(role.id, isRequired)) slot.appendChild(child);
    }

    const activate = async () => {
      if (photo) {
        await openPhotoModal(photo, { onChange });
        return;
      }
      const file = await pickFile('image/*');
      await upload(slot, role.id, file);
    };

    slot.addEventListener('click', activate);
    slot.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        activate();
      }
    });

    // drag & drop straight onto the slot
    slot.addEventListener('dragenter', (event) => {
      event.preventDefault();
      highlightSlot(slot, true);
    });
    slot.addEventListener('dragover', (event) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      highlightSlot(slot, true);
    });
    slot.addEventListener('dragleave', () => highlightSlot(slot, false));
    slot.addEventListener('drop', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      highlightSlot(slot, false);
      const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      if (!file) return;
      if (photo) {
        // dropping onto a taken slot replaces its content
        const fresh = await attachPhoto(file, { pointId: point.id, role: role.id });
        if (fresh && fresh.id !== photo.id) await removePhoto(photo.id);
        if (fresh) await notify();
        return;
      }
      await upload(slot, role.id, file);
    });

    row.appendChild(slot);
  }

  /* Summary line — every number comes from model.js `completeness`. */
  const comp = completeness(point, preset, state.photos);
  const requiredCount = requiredRoles.size;
  const missingLabels = comp.missingPhotos.map(photoRoleLabel);

  const summary = h(
    'div',
    { class: 'note' },
    h('div', {
      text: requiredCount
        ? `Wymagane przez preset ${preset ? preset.id : '—'}: ` +
          `${fmtNum(requiredCount - comp.missingPhotos.length)} z ${fmtNum(requiredCount)} slotów. ` +
          `Wgranych zdjęć przy punkcie: ${fmtNum(pointPhotos.length)}.`
        : `Ten preset nie wymaga zdjęć. Wgranych przy punkcie: ${fmtNum(pointPhotos.length)}.`,
    }),
    missingLabels.length
      ? h('div', { text: `Brakuje: ${missingLabels.join(', ')} — obniża kompletność karty.` })
      : null,
    h('div', {
      text:
        `Po wgraniu: EXIF (GPS, data) trafia do metadanych, plik jest przeskalowany ` +
        `do ${fmtNum(PHOTO_MAX_EDGE)} px i zapisany bez EXIF. Miniatura ${fmtNum(PHOTO_THUMB_EDGE)} px.`,
    })
  );

  mount(container, row, summary);
}

/** Children of an empty slot: camera icon + role label (+ required marker). */
function emptySlotChildren(roleId, isRequired) {
  const label = h(
    'div',
    { class: 'photo-slot__label' },
    cameraIcon(),
    h('span', { text: photoRoleLabel(roleId) })
  );
  const children = [label];
  if (isRequired) children.push(h('span', { class: 'photo-slot__req', text: 'WYM.' }));
  return children;
}
