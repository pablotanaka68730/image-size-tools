// Core image size detection.
//
// The goal is to read only the bytes needed to learn an image's dimensions,
// never the pixel data. For every format supported here the width and height
// live in a fixed-size header near the start of the file, so we can answer
// with a handful of bytes instead of allocating a full raster.
//
// Format support is deliberately narrow: PNG, GIF, JPEG and BMP. Those cover
// the overwhelming majority of files encountered in practice, and each has a
// header layout stable enough to parse without a decoder. Anything else is
// reported as unsupported rather than guessed at.

/**
 * @typedef {Object} ImageSize
 * @property {number} width  Width in pixels.
 * @property {number} height Height in pixels.
 * @property {string} type   Lower-case format name: 'png', 'gif', 'jpeg' or 'bmp'.
 */

/**
 * Read a big-endian unsigned 16-bit integer.
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @returns {number}
 */
function readU16BE(bytes, offset) {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

/**
 * Read a big-endian unsigned 32-bit integer.
 *
 * `>>> 0` is required: bitwise operators in JavaScript coerce to signed 32-bit
 * integers, so without it dimensions above 2^31 would come back negative. Real
 * images never approach that size, but a malformed header could, and we would
 * rather return a nonsense number than a negative one.
 *
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @returns {number}
 */
function readU32BE(bytes, offset) {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

/**
 * Read a little-endian unsigned 32-bit integer.
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @returns {number}
 */
function readU32LE(bytes, offset) {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  );
}

/**
 * Read a little-endian signed 16-bit integer.
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @returns {number}
 */
function readI16LE(bytes, offset) {
  const value = bytes[offset] | (bytes[offset + 1] << 8);
  return value & 0x8000 ? value - 0x10000 : value;
}

/**
 * Coerce arbitrary input into a Uint8Array without copying when possible.
 *
 * Accepting both Uint8Array and ArrayBuffer keeps the API convenient for
 * callers who already have a buffer from `fs.readFile` (which yields a Buffer,
 * itself a Uint8Array subclass) or from `fetch` (which yields an ArrayBuffer).
 *
 * @param {Uint8Array|ArrayBuffer|Buffer} input
 * @returns {Uint8Array}
 */
function toBytes(input) {
  if (input instanceof Uint8Array) {
    return input;
  }
  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input);
  }
  throw new TypeError('input must be a Uint8Array or ArrayBuffer');
}

/**
 * Parse a PNG header (IHDR chunk).
 *
 * The PNG signature is followed immediately by the IHDR chunk, whose first
 * two fields are width and height as big-endian 32-bit integers. We do not
 * validate the chunk length or CRC: a corrupt file may still have a readable
 * header, and rejecting it would be less useful than reporting what is there.
 *
 * @param {Uint8Array} bytes
 * @returns {ImageSize}
 */
export function parsePngSize(bytes) {
  if (bytes.length < 24) {
    throw new RangeError('PNG header is truncated');
  }
  return {
    width: readU32BE(bytes, 16),
    height: readU32BE(bytes, 20),
    type: 'png',
  };
}

/**
 * Parse a GIF header (logical screen descriptor).
 *
 * GIF stores dimensions as little-endian 16-bit integers at offsets 6 and 8.
 * The format is limited to 65535x65535, so 16 bits is genuinely sufficient.
 *
 * @param {Uint8Array} bytes
 * @returns {ImageSize}
 */
export function parseGifSize(bytes) {
  if (bytes.length < 10) {
    throw new RangeError('GIF header is truncated');
  }
  return {
    width: bytes[6] | (bytes[7] << 8),
    height: bytes[8] | (bytes[9] << 8),
    type: 'gif',
  };
}

/**
 * Parse a BMP header (BITMAPINFOHEADER or later).
 *
 * BMP dimensions are signed 32-bit little-endian integers. Negative values
 * mean the image is stored top-down; the magnitude is still the true height,
 * so we take the absolute value. We only handle the DIB header variants that
 * carry explicit width/height at offsets 18 and 22, which covers every BMP
 * produced in the last three decades.
 *
 * @param {Uint8Array} bytes
 * @returns {ImageSize}
 */
export function parseBmpSize(bytes) {
  if (bytes.length < 26) {
    throw new RangeError('BMP header is truncated');
  }
  const width = readU32LE(bytes, 18);
  const rawHeight = readU32LE(bytes, 22);
  // Interpret the height as signed so top-down bitmaps report a positive size.
  const height = rawHeight > 0x7fffffff ? 0x100000000 - rawHeight : rawHeight;
  return { width, height, type: 'bmp' };
}

/**
 * Parse a JPEG header by walking its segment markers.
 *
 * JPEG has no single fixed header: the dimensions live in a Start Of Frame
 * (SOF) segment that can appear after any number of other segments. We scan
 * markers until we find an SOF, skipping segment payloads using their declared
 * length. Standalone markers (those without a length field) are skipped
 * individually.
 *
 * The scan is bounded by the buffer length, so a truncated or malformed file
 * throws rather than reading out of bounds.
 *
 * @param {Uint8Array} bytes
 * @returns {ImageSize}
 */
export function parseJpegSize(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new RangeError('not a JPEG (missing SOI marker)');
  }

  let offset = 2;
  while (offset + 1 < bytes.length) {
    // Markers are a 0xFF byte followed by a non-zero, non-0xFF type byte.
    // Padding 0xFF bytes between segments are legal and must be skipped.
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    let marker = bytes[offset + 1];
    while (marker === 0xff) {
      offset += 1;
      if (offset + 1 >= bytes.length) {
        throw new RangeError('JPEG marker is truncated');
      }
      marker = bytes[offset + 1];
    }
    offset += 2;

    // Markers without a payload: RSTn, SOI, EOI, TEM.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      continue;
    }

    if (offset + 1 >= bytes.length) {
      throw new RangeError('JPEG segment length is truncated');
    }
    const segmentLength = readU16BE(bytes, offset);
    if (segmentLength < 2) {
      throw new RangeError('JPEG segment length is invalid');
    }

    // SOF0..SOF15, excluding the DHT (0xC4), JPG (0xC8) and DAC (0xCC)
    // markers which share the 0xC0-0xCF range but are not frame headers.
    const isSof =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;

    if (isSof) {
      // Layout after the length: precision (1), height (2), width (2).
      if (offset + 7 >= bytes.length) {
        throw new RangeError('JPEG frame header is truncated');
      }
      return {
        width: readU16BE(bytes, offset + 5),
        height: readU16BE(bytes, offset + 3),
        type: 'jpeg',
      };
    }

    offset += segmentLength;
  }

  throw new RangeError('JPEG has no frame header');
}

/**
 * Detect an image format from its magic bytes and return its dimensions.
 *
 * Detection is signature-based rather than extension-based, because file
 * extensions lie and the header is already in hand. The order of checks is
 * irrelevant for correctness since the signatures are disjoint, but PNG is
 * checked first because it is the most common input.
 *
 * @param {Uint8Array|ArrayBuffer|Buffer} input
 * @returns {ImageSize}
 * @throws {TypeError} If the input is not a byte container.
 * @throws {RangeError} If the format is unsupported or the header is truncated.
 */
export function imageSize(input) {
  const bytes = toBytes(input);

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return parsePngSize(bytes);
  }

  // GIF: 'GIF87a' or 'GIF89a'
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return parseGifSize(bytes);
  }

  // JPEG: FF D8
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return parseJpegSize(bytes);
  }

  // BMP: 'BM'
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return parseBmpSize(bytes);
  }

  throw new RangeError('unsupported or unrecognised image format');
}
