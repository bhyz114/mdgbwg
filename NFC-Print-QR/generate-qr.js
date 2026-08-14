'use strict';

// Offline QR encoder for the six fixed exhibition claim URLs.
// Emits QR Code Model 2, Version 8, error-correction level Q, in SVG form.

const fs = require('node:fs');
const path = require('node:path');

const OUTPUT_DIR = __dirname;
const BASE_URL = 'https://rainbow-bienenstitch-b7627f.netlify.app/nfc/#claim=';
const QR_VERSION = 8;
const ERROR_CORRECTION_Q = 3;
const MODULE_COUNT = 17 + QR_VERSION * 4;
const QUIET_ZONE = 4;

const exhibits = [
  { code: 'M-01', file: 'M-01-museum-mark.svg', label: 'Museum Mark', claimKey: 'ctyh_museum_nfc_01' },
  { code: 'A-01', file: 'A-01-bone-awl.svg', label: 'Bone Awl', claimKey: 'ctyh_bone_awl_01' },
  { code: 'A-02', file: 'A-02-stone-axe.svg', label: 'Stone Axe', claimKey: 'ctyh_stone_axe_01' },
  { code: 'A-03', file: 'A-03-bone-flute.svg', label: 'Bone Flute', claimKey: 'ctyh_bone_flute_01' },
  { code: 'A-04', file: 'A-04-tortoise-shell.svg', label: 'Tortoise Shell', claimKey: 'ctyh_tortoise_shell_01' },
  { code: 'A-05', file: 'A-05-bone-knife.svg', label: 'Bone Knife', claimKey: 'ctyh_bone_knife_01' },
];

// QR Version 8 / error correction Q: 4 blocks of (40 total, 18 data),
// followed by 2 blocks of (41 total, 19 data). It holds 110 data codewords.
const RS_BLOCKS = [
  ...Array.from({ length: 4 }, () => ({ totalCount: 40, dataCount: 18 })),
  ...Array.from({ length: 2 }, () => ({ totalCount: 41, dataCount: 19 })),
];

const EXP_TABLE = new Array(256).fill(0);
const LOG_TABLE = new Array(256).fill(0);
for (let i = 0; i < 8; i += 1) EXP_TABLE[i] = 1 << i;
for (let i = 8; i < 256; i += 1) {
  EXP_TABLE[i] = EXP_TABLE[i - 4] ^ EXP_TABLE[i - 5] ^ EXP_TABLE[i - 6] ^ EXP_TABLE[i - 8];
}
for (let i = 0; i < 255; i += 1) LOG_TABLE[EXP_TABLE[i]] = i;

function gexp(value) {
  let n = value;
  while (n < 0) n += 255;
  while (n >= 255) n -= 255;
  return EXP_TABLE[n];
}

function glog(value) {
  if (value < 1) throw new Error('glog(0) is undefined');
  return LOG_TABLE[value];
}

class Polynomial {
  constructor(values, shift) {
    let offset = 0;
    while (offset < values.length && values[offset] === 0) offset += 1;
    this.values = new Array(values.length - offset + shift).fill(0);
    for (let i = offset; i < values.length; i += 1) this.values[i - offset] = values[i];
  }

  get length() {
    return this.values.length;
  }

  get(index) {
    return this.values[index];
  }

  multiply(other) {
    const product = new Array(this.length + other.length - 1).fill(0);
    for (let i = 0; i < this.length; i += 1) {
      const a = this.get(i);
      if (a === 0) continue;
      for (let j = 0; j < other.length; j += 1) {
        const b = other.get(j);
        if (b === 0) continue;
        product[i + j] ^= gexp(glog(a) + glog(b));
      }
    }
    return new Polynomial(product, 0);
  }

  mod(other) {
    let remainder = this;
    while (remainder.length >= other.length) {
      const ratio = glog(remainder.get(0)) - glog(other.get(0));
      const next = remainder.values.slice();
      for (let i = 0; i < other.length; i += 1) {
        const coefficient = other.get(i);
        if (coefficient !== 0) next[i] ^= gexp(glog(coefficient) + ratio);
      }
      remainder = new Polynomial(next, 0);
    }
    return remainder;
  }
}

function errorCorrectPolynomial(length) {
  let polynomial = new Polynomial([1], 0);
  for (let i = 0; i < length; i += 1) {
    polynomial = polynomial.multiply(new Polynomial([1, gexp(i)], 0));
  }
  return polynomial;
}

class BitBuffer {
  constructor() {
    this.bits = [];
  }

  get length() {
    return this.bits.length;
  }

  put(value, count) {
    for (let i = count - 1; i >= 0; i -= 1) this.putBit(((value >>> i) & 1) === 1);
  }

  putBit(bit) {
    this.bits.push(Boolean(bit));
  }

  toBytes() {
    const bytes = new Array(this.bits.length / 8).fill(0);
    for (let i = 0; i < this.bits.length; i += 1) {
      if (this.bits[i]) bytes[Math.floor(i / 8)] |= 0x80 >>> (i % 8);
    }
    return bytes;
  }
}

function utf8AsciiBytes(text) {
  const bytes = [];
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code > 0x7f) throw new Error('This fixed QR encoder accepts ASCII claim URLs only.');
    bytes.push(code);
  }
  return bytes;
}

function createDataCodewords(text) {
  const bytes = utf8AsciiBytes(text);
  const capacity = RS_BLOCKS.reduce((sum, block) => sum + block.dataCount, 0) * 8;
  const buffer = new BitBuffer();
  buffer.put(0b0100, 4); // Byte mode.
  buffer.put(bytes.length, 8); // Version 8 uses an 8-bit byte-mode length field.
  for (const byte of bytes) buffer.put(byte, 8);
  if (buffer.length > capacity) throw new Error(`URL is too long for Version ${QR_VERSION}-Q.`);
  if (buffer.length + 4 <= capacity) buffer.put(0, 4);
  while (buffer.length % 8 !== 0) buffer.putBit(false);
  let padIndex = 0;
  const pads = [0xec, 0x11];
  while (buffer.length < capacity) {
    buffer.put(pads[padIndex % 2], 8);
    padIndex += 1;
  }
  return buffer.toBytes();
}

function createInterleavedCodewords(dataCodewords) {
  const dataBlocks = [];
  const errorBlocks = [];
  let offset = 0;
  let maxDataLength = 0;
  let maxErrorLength = 0;

  for (const block of RS_BLOCKS) {
    const errorLength = block.totalCount - block.dataCount;
    const blockData = dataCodewords.slice(offset, offset + block.dataCount);
    offset += block.dataCount;
    const generator = errorCorrectPolynomial(errorLength);
    const remainder = new Polynomial(blockData, generator.length - 1).mod(generator);
    const blockError = new Array(errorLength).fill(0);
    for (let i = 0; i < errorLength; i += 1) {
      const sourceIndex = i + remainder.length - errorLength;
      if (sourceIndex >= 0) blockError[i] = remainder.get(sourceIndex);
    }
    dataBlocks.push(blockData);
    errorBlocks.push(blockError);
    maxDataLength = Math.max(maxDataLength, blockData.length);
    maxErrorLength = Math.max(maxErrorLength, blockError.length);
  }

  if (offset !== dataCodewords.length) throw new Error('QR data block allocation failed.');
  const result = [];
  for (let i = 0; i < maxDataLength; i += 1) {
    for (const block of dataBlocks) if (i < block.length) result.push(block[i]);
  }
  for (let i = 0; i < maxErrorLength; i += 1) {
    for (const block of errorBlocks) if (i < block.length) result.push(block[i]);
  }
  const expected = RS_BLOCKS.reduce((sum, block) => sum + block.totalCount, 0);
  if (result.length !== expected) throw new Error('QR interleaving failed.');
  return result;
}

function bchDigit(value) {
  let digit = 0;
  let data = value;
  while (data !== 0) {
    digit += 1;
    data >>>= 1;
  }
  return digit;
}

function bchTypeInfo(data) {
  let value = data << 10;
  while (bchDigit(value) - bchDigit(0x537) >= 0) {
    value ^= 0x537 << (bchDigit(value) - bchDigit(0x537));
  }
  return ((data << 10) | value) ^ 0x5412;
}

function bchTypeNumber(data) {
  let value = data << 12;
  while (bchDigit(value) - bchDigit(0x1f25) >= 0) {
    value ^= 0x1f25 << (bchDigit(value) - bchDigit(0x1f25));
  }
  return (data << 12) | value;
}

function createEmptyMatrix() {
  return Array.from({ length: MODULE_COUNT }, () => new Array(MODULE_COUNT).fill(null));
}

function setupProbe(matrix, row, column) {
  for (let r = -1; r <= 7; r += 1) {
    for (let c = -1; c <= 7; c += 1) {
      const y = row + r;
      const x = column + c;
      if (y < 0 || y >= MODULE_COUNT || x < 0 || x >= MODULE_COUNT) continue;
      matrix[y][x] = (r >= 0 && r <= 6 && (c === 0 || c === 6))
        || (c >= 0 && c <= 6 && (r === 0 || r === 6))
        || (r >= 2 && r <= 4 && c >= 2 && c <= 4);
    }
  }
}

function setupAlignment(matrix) {
  const positions = [6, 24, 42];
  for (const row of positions) {
    for (const column of positions) {
      if (matrix[row][column] !== null) continue;
      for (let r = -2; r <= 2; r += 1) {
        for (let c = -2; c <= 2; c += 1) {
          matrix[row + r][column + c] = r === -2 || r === 2 || c === -2 || c === 2 || (r === 0 && c === 0);
        }
      }
    }
  }
}

function setupTiming(matrix) {
  for (let i = 8; i < MODULE_COUNT - 8; i += 1) {
    if (matrix[i][6] === null) matrix[i][6] = i % 2 === 0;
    if (matrix[6][i] === null) matrix[6][i] = i % 2 === 0;
  }
}

function setupFormatInfo(matrix, maskPattern) {
  const bits = bchTypeInfo((ERROR_CORRECTION_Q << 3) | maskPattern);
  for (let i = 0; i < 15; i += 1) {
    const dark = ((bits >>> i) & 1) === 1;
    if (i < 6) matrix[i][8] = dark;
    else if (i < 8) matrix[i + 1][8] = dark;
    else matrix[MODULE_COUNT - 15 + i][8] = dark;

    if (i < 8) matrix[8][MODULE_COUNT - i - 1] = dark;
    else if (i < 9) matrix[8][15 - i] = dark;
    else matrix[8][14 - i] = dark;
  }
  matrix[MODULE_COUNT - 8][8] = true;
}

function setupVersionInfo(matrix) {
  const bits = bchTypeNumber(QR_VERSION);
  for (let i = 0; i < 18; i += 1) {
    const dark = ((bits >>> i) & 1) === 1;
    matrix[Math.floor(i / 3)][(i % 3) + MODULE_COUNT - 11] = dark;
    matrix[(i % 3) + MODULE_COUNT - 11][Math.floor(i / 3)] = dark;
  }
}

function mask0(row, column) {
  return (row + column) % 2 === 0;
}

function mapCodewords(matrix, codewords) {
  let row = MODULE_COUNT - 1;
  let direction = -1;
  let byteIndex = 0;
  let bitIndex = 7;

  for (let column = MODULE_COUNT - 1; column > 0; column -= 2) {
    if (column === 6) column -= 1;
    while (true) {
      for (let c = 0; c < 2; c += 1) {
        const x = column - c;
        if (matrix[row][x] !== null) continue;
        let dark = false;
        if (byteIndex < codewords.length) dark = ((codewords[byteIndex] >>> bitIndex) & 1) === 1;
        if (mask0(row, x)) dark = !dark;
        matrix[row][x] = dark;
        bitIndex -= 1;
        if (bitIndex < 0) {
          byteIndex += 1;
          bitIndex = 7;
        }
      }
      row += direction;
      if (row < 0 || row >= MODULE_COUNT) {
        row -= direction;
        direction = -direction;
        break;
      }
    }
  }
}

function buildMatrix(text) {
  const data = createDataCodewords(text);
  const codewords = createInterleavedCodewords(data);
  const matrix = createEmptyMatrix();
  setupProbe(matrix, 0, 0);
  setupProbe(matrix, MODULE_COUNT - 7, 0);
  setupProbe(matrix, 0, MODULE_COUNT - 7);
  setupAlignment(matrix);
  setupTiming(matrix);
  setupFormatInfo(matrix, 0);
  setupVersionInfo(matrix);
  mapCodewords(matrix, codewords);

  for (const row of matrix) {
    if (row.some((module) => module === null)) throw new Error('QR matrix contains unassigned modules.');
  }
  return matrix;
}

function escapeXml(value) {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[character]));
}

function matrixToSvg(matrix, title) {
  const size = MODULE_COUNT + QUIET_ZONE * 2;
  let rects = '';
  for (let y = 0; y < MODULE_COUNT; y += 1) {
    for (let x = 0; x < MODULE_COUNT; x += 1) {
      if (matrix[y][x]) rects += `<rect x="${x + QUIET_ZONE}" y="${y + QUIET_ZONE}" width="1" height="1"/>`;
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" role="img" aria-labelledby="title" shape-rendering="crispEdges"><title id="title">${escapeXml(title)}</title><rect width="${size}" height="${size}" fill="#ffffff"/><g fill="#000000">${rects}</g></svg>\n`;
}

function buildPrintSheet(entries) {
  const cards = entries.map((entry) => `
    <section class="card">
      <img src="${entry.file}" alt="${entry.code} QR code" />
      <div class="meta"><strong>${entry.code}</strong><span>${entry.label}</span><code>${entry.url}</code></div>
    </section>`).join('');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Painted Pottery Imprints NFC QR Print Sheet</title>
  <style>
    @page { size: A4 portrait; margin: 10mm; }
    * { box-sizing: border-box; }
    body { margin: 0; color: #15110d; font-family: Arial, sans-serif; }
    h1 { margin: 0 0 4mm; font-size: 18pt; }
    p { margin: 0 0 7mm; font-size: 9pt; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 5mm; }
    .card { min-height: 83mm; border: 0.3mm solid #222; display: grid; grid-template-columns: 56mm 1fr; gap: 4mm; padding: 4mm; align-items: center; break-inside: avoid; }
    img { display: block; width: 56mm; height: 56mm; image-rendering: pixelated; }
    .meta { min-width: 0; display: grid; gap: 2mm; align-content: center; }
    strong { font-size: 18pt; }
    span { font-size: 11pt; font-weight: 700; }
    code { overflow-wrap: anywhere; font-size: 6.6pt; line-height: 1.35; }
    @media screen { body { max-width: 210mm; margin: 8mm auto; padding: 0 8mm; } }
  </style>
</head>
<body>
  <h1>Painted Pottery Imprints - NFC / QR labels</h1>
  <p>Write or print the exact URL shown on each label. Do not lock a tag until a phone opens the correct claim page.</p>
  <main class="grid">${cards}
  </main>
</body>
</html>
`;
}

function main() {
  const created = [];
  for (const exhibit of exhibits) {
    const url = `${BASE_URL}${exhibit.claimKey}`;
    const svg = matrixToSvg(buildMatrix(url), `${exhibit.code} - ${url}`);
    fs.writeFileSync(path.join(OUTPUT_DIR, exhibit.file), svg, 'utf8');
    created.push({ ...exhibit, url });
  }
  fs.writeFileSync(path.join(OUTPUT_DIR, 'QR-Print-Sheet.html'), buildPrintSheet(created), 'utf8');
  fs.writeFileSync(path.join(OUTPUT_DIR, 'claim-urls.txt'), `${created.map((entry) => `${entry.code}\t${entry.claimKey}\t${entry.url}`).join('\n')}\n`, 'utf8');
  console.log(`Generated ${created.length} SVG QR codes in ${OUTPUT_DIR}`);
  for (const entry of created) console.log(`${entry.code} ${entry.url}`);
}

main();
