# image-size-tools

Read the pixel width and height of an image from its header bytes, without decoding the pixels.

```js
import { imageSize } from 'image-size-tools';

const bytes = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x03,
]);

const { width, height, type } = imageSize(bytes);

console.log(`${type} ${width}x${height}`); // png 2x3
```

`imageSize` accepts a `Uint8Array` (a Node `Buffer` counts) or an `ArrayBuffer`. It returns `{ width, height, type }` where `type` is one of `'png'`, `'gif'`, `'jpeg'` or `'bmp'`.

The format-specific parsers are exported too, if you already know what you have and want to skip detection:

```js
import { parsePngSize } from 'image-size-tools';

const pngBytes = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x03,
]);

const { width, height } = parsePngSize(pngBytes);
```

## Why this exists

Most image libraries decode the whole file into a raster just to answer "how big is it?", which for a large photo means allocating tens of megabytes to read four bytes of header. Every format supported here stores its dimensions near the start of the file, so this library reads a small prefix and stops. The trade-off is format coverage: only PNG, GIF, JPEG and BMP are recognised. Anything else throws, rather than guessing from the file extension or attempting a partial decode. That keeps the code small enough to audit and means a wrong answer is never returned silently.

## The edge you will hit

JPEG has no fixed header. The dimensions live in a Start Of Frame segment that appears after an arbitrary number of other segments, so the parser walks the marker chain. That works on real files, but it means a JPEG whose SOF segment sits past the bytes you handed in will throw `RangeError` even though the file is perfectly valid. If you are streaming, read enough of the file first to cover the frame header. The other three formats are fixed-offset and have no such caveat.

Truncated headers throw `RangeError`, and passing something that is not a byte container throws `TypeError`. The library never returns a partially filled result.

## API

- `imageSize(input)` — detect the format from the magic bytes and return `{ width, height, type }`.
- `parsePngSize(bytes)` — parse an IHDR chunk.
- `parseGifSize(bytes)` — parse a logical screen descriptor.
- `parseJpegSize(bytes)` — walk markers to the first frame header.
- `parseBmpSize(bytes)` — parse a `BITMAPINFOHEADER`-style header; a negative stored height (top-down bitmap) is reported as a positive number.
