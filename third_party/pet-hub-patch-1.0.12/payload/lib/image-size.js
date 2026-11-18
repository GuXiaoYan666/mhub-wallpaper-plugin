'use strict';

// Read supported raster headers without depending on nativeImage's PNG/JPEG-only
// buffer decoder. Codex pet packs normally ship WebP atlases.
function imageSize(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12) return null;
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.length >= 33 && bytes.toString('ascii', 12, 16) === 'IHDR') {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.toString('ascii', 0, 3) === 'GIF') return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    if (bytes.readUInt32LE(4) + 8 > bytes.length) return null;
    for (let at = 12; at + 8 <= bytes.length;) {
      const type = bytes.toString('ascii', at, at + 4), size = bytes.readUInt32LE(at + 4), data = at + 8;
      if (data + size > bytes.length) return null;
      if (type === 'VP8X' && size >= 10) return { width: bytes.readUIntLE(data + 4, 3) + 1, height: bytes.readUIntLE(data + 7, 3) + 1 };
      if (type === 'VP8L' && size >= 5 && bytes[data] === 47) {
        const packed = bytes.readUInt32LE(data + 1);
        return { width: (packed & 16383) + 1, height: ((packed >>> 14) & 16383) + 1 };
      }
      if (type === 'VP8 ' && size >= 10 && bytes[data + 3] === 157 && bytes[data + 4] === 1 && bytes[data + 5] === 42) {
        return { width: bytes.readUInt16LE(data + 6) & 16383, height: bytes.readUInt16LE(data + 8) & 16383 };
      }
      at = data + size + (size % 2);
    }
  }
  if (bytes[0] === 255 && bytes[1] === 216) {
    for (let at = 2; at + 4 < bytes.length;) {
      if (bytes[at] !== 255) return null;
      const marker = bytes[at + 1];
      if (marker === 255) { at++; continue; }
      if (marker === 217 || marker === 218) break;
      const size = bytes.readUInt16BE(at + 2);
      if (size < 2 || at + 2 + size > bytes.length) return null;
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker) && size >= 7) {
        return { width: bytes.readUInt16BE(at + 7), height: bytes.readUInt16BE(at + 5) };
      }
      at += 2 + size;
    }
  }
  return null;
}
function validateImage(bytes, hero) {
  const size = imageSize(bytes);
  return !!size && (hero ? size.width > 0 && size.height > 0 && size.width <= 8192 && size.height <= 8192 : [1, 2, 4].some(scale => size.width === 1536 * scale && size.height === 1872 * scale));
}
module.exports = { imageSize, validateImage };
