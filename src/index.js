// Public entry point for image-size-tools.
//
// Everything a consumer needs is re-exported here so that a single import
// path (`image-size-tools`) is enough. Keeping the barrel file tiny also means
// the public surface is obvious at a glance.
export { imageSize, parsePngSize, parseGifSize, parseJpegSize, parseBmpSize } from './core.js';
