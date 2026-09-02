/**
 * zip.js – zapis archiwum ZIP bez kompresji (metoda „store"), zero zależności.
 *
 * Wystarcza do spakowania kilkunastu PDF-ów kart w jeden plik do pobrania.
 * Brak kompresji jest zamierzony: PDF-y i tak się nie kompresują, a implementacja
 * deflate nie jest warta ryzyka. Nazwy plików idą jako UTF-8 (bit 11 flagi).
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data) {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Data w formacie DOS (2 s rozdzielczości); wystarczy dzień z config.TODAY. */
function dosDateTime(isoDate) {
  const [y, m, d] = String(isoDate || '2026-01-01')
    .slice(0, 10)
    .split('-')
    .map(Number);
  const date = (((y || 2026) - 1980) << 9) | ((m || 1) << 5) | (d || 1);
  const time = 12 << 11; // 12:00:00
  return { date, time };
}

/**
 * @param {Array<{name: string, data: Uint8Array}>} files
 * @param {string} stamp – data ISO wpisywana w metadane plików
 * @returns {Uint8Array}
 */
export function zipStore(files, stamp) {
  const encoder = new TextEncoder();
  const { date, time } = dosDateTime(stamp);

  const chunks = [];
  const central = [];
  let offset = 0;

  const u16 = (v) => [v & 0xff, (v >> 8) & 0xff];
  const u32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];

  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = file.data;
    const crc = crc32(data);

    const local = new Uint8Array([
      ...u32(0x04034b50),
      ...u16(20), // version needed
      ...u16(0x0800), // UTF-8 names
      ...u16(0), // store
      ...u16(time),
      ...u16(date),
      ...u32(crc),
      ...u32(data.length),
      ...u32(data.length),
      ...u16(name.length),
      ...u16(0),
      ...name,
    ]);
    chunks.push(local, data);

    central.push(
      new Uint8Array([
        ...u32(0x02014b50),
        ...u16(20),
        ...u16(20),
        ...u16(0x0800),
        ...u16(0),
        ...u16(time),
        ...u16(date),
        ...u32(crc),
        ...u32(data.length),
        ...u32(data.length),
        ...u16(name.length),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u32(0),
        ...u32(offset),
        ...name,
      ])
    );
    offset += local.length + data.length;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const entry of central) {
    chunks.push(entry);
    centralSize += entry.length;
  }

  chunks.push(
    new Uint8Array([
      ...u32(0x06054b50),
      ...u16(0),
      ...u16(0),
      ...u16(files.length),
      ...u16(files.length),
      ...u32(centralSize),
      ...u32(centralStart),
      ...u16(0),
    ])
  );

  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}
