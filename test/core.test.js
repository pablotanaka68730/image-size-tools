import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  imageSize,
  parsePngSize,
  parseGifSize,
  parseJpegSize,
  parseBmpSize,
} from '../src/index.js';

// --- helpers ---------------------------------------------------------------

/** Build a byte array from a mix of numeric bytes and hex strings. */
function bytes(...parts) {
  const out = [];
  for (const part of parts) {
    if (typeof part === 'number') {
      out.push(part);
    } else if (typeof part === 'string') {
      const clean = part.replace(/\s+/g, '');
      if (clean.length % 2 !== 0) {
        throw new Error(`odd-length hex string: ${part}`);
      }
      for (let i = 0; i < clean.length; i += 2) {
        out.push(parseInt(clean.slice(i, i + 2), 16));
      }
    } else {
      throw new Error('unexpected part');
    }
  }
  return new Uint8Array(out);
}

function pngHeader(width, height) {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  // IHDR length and type, then width and height.
  b.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8);
  b[16] = (width >>> 24) & 0xff;
  b[17] = (width >>> 16) & 0xff;
  b[18] = (width >>> 8) & 0xff;
  b[19] = width & 0xff;
  b[20] = (height >>> 24) & 0xff;
  b[21] = (height >>> 16) & 0xff;
  b[22] = (height >>> 8) & 0xff;
  b[23] = height & 0xff;
  return b;
}

function gifHeader(width, height) {
  return bytes(
    '474946383961',
    width & 0xff,
    (width >> 8) & 0xff,
    height & 0xff,
    (height >> 8) & 0xff,
    '00000000'
  );
}

function bmpHeader(width, height) {
  const b = new Uint8Array(26);
  b[0] = 0x42;
  b[1] = 0x4d;
  // DIB header size (40) at offset 14, then width and height.
  b[14] = 40;
  b[18] = width & 0xff;
  b[19] = (width >> 8) & 0xff;
  b[20] = (width >> 16) & 0xff;
  b[21] = (width >> 24) & 0xff;
  b[22] = height & 0xff;
  b[23] = (height >> 8) & 0xff;
  b[24] = (height >> 16) & 0xff;
  b[25] = (height >> 24) & 0xff;
  return b;
}

/** Minimal JPEG with one SOF0 frame header. */
function jpegHeader(width, height) {
  return bytes(
    'ffd8',
    'ffe0',
    '0010', // APP0 segment length 16
    '4a46494600010100000100010000', // JFIF payload
    'ffc0',
    '0011', // SOF0 segment length 17
    '08', // precision
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    '0301011100021100031100'
  );
}

// --- PNG -------------------------------------------------------------------

test('parsePngSize reads width and height from IHDR', () => {
  const size = parsePngSize(pngHeader(640, 480));
  assert.deepEqual(size, { width: 640, height: 480, type: 'png' });
});

test('parsePngSize handles large dimensions without sign issues', () => {
  const size = parsePngSize(pngHeader(70000, 50000));
  assert.equal(size.width, 70000);
  assert.equal(size.height, 50000);
});

test('parsePngSize rejects a truncated header', () => {
  assert.throws(() => parsePngSize(new Uint8Array(10)), RangeError);
});

// --- GIF -------------------------------------------------------------------

test('parseGifSize reads little-endian dimensions', () => {
  const size = parseGifSize(gifHeader(320, 240));
  assert.deepEqual(size, { width: 320, height: 240, type: 'gif' });
});

test('parseGifSize rejects a truncated header', () => {
  assert.throws(() => parseGifSize(new Uint8Array(4)), RangeError);
});

// --- BMP -------------------------------------------------------------------

test('parseBmpSize reads little-endian dimensions', () => {
  const size = parseBmpSize(bmpHeader(128, 64));
  assert.deepEqual(size, { width: 128, height: 64, type: 'bmp' });
});

test('parseBmpSize treats a top-down height as positive', () => {
  // Height stored as -100 in two's complement.
  const b = bmpHeader(50, 0);
  const neg100 = (0x100000000 - 100) >>> 0;
  b[22] = neg100 & 0xff;
  b[23] = (neg100 >> 8) & 0xff;
  b[24] = (neg100 >> 16) & 0xff;
  b[25] = (neg100 >> 24) & 0xff;
  const size = parseBmpSize(b);
  assert.equal(size.width, 50);
  assert.equal(size.height, 100);
});

// --- JPEG ------------------------------------------------------------------

test('parseJpegSize walks markers to the SOF0 frame', () => {
  const size = parseJpegSize(jpegHeader(1024, 768));
  assert.deepEqual(size, { width: 1024, height: 768, type: 'jpeg' });
});

test('parseJpegSize skips padding 0xFF bytes between markers', () => {
  const withPadding = bytes(
    'ffd8',
    'ffffe0', // padding 0xFF before APP0
    '0010',
    '4a46494600010100000100010000',
    'ffc0',
    '0011',
    '08',
    '0003',
    '0002',
    '0301011100021100031100'
  );
  const size = parseJpegSize(withPadding);
  assert.equal(size.width, 2);
  assert.equal(size.height, 3);
});

test('parseJpegSize rejects a non-JPEG input', () => {
  assert.throws(() => parseJpegSize(bytes('89504e47')), RangeError);
});

test('parseJpegSize rejects a file with no frame header', () => {
  const noFrame = bytes('ffd8', 'ffe0', '0010', '4a46494600010100000100010000');
  assert.throws(() => parseJpegSize(noFrame), RangeError);
});

// --- dispatch --------------------------------------------------------------

test('imageSize detects PNG, GIF, JPEG and BMP by signature', () => {
  assert.equal(imageSize(pngHeader(10, 20)).type, 'png');
  assert.equal(imageSize(gifHeader(10, 20)).type, 'gif');
  assert.equal(imageSize(jpegHeader(10, 20)).type, 'jpeg');
  assert.equal(imageSize(bmpHeader(10, 20)).type, 'bmp');
});

test('imageSize accepts an ArrayBuffer', () => {
  const header = pngHeader(11, 22);
  const buffer = header.buffer.slice(
    header.byteOffset,
    header.byteOffset + header.byteLength
  );
  const size = imageSize(buffer);
  assert.deepEqual(size, { width: 11, height: 22, type: 'png' });
});

test('imageSize throws for an unrecognised format', () => {
  assert.throws(() => imageSize(bytes('00010203')), RangeError);
});

test('imageSize throws a TypeError for a non-byte input', () => {
  assert.throws(() => imageSize('not bytes'), TypeError);
});
