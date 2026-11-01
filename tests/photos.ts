/** Small but well-formed photos for the profile tests; the *_GPS ones carry camera metadata with a home location. */
const seg = (marker: number, payload: Buffer) => {
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
};
export const HOME = 'GPS 52.3833N 12.9333E';
const jfif = seg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1'));
const scan = Buffer.concat([seg(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])), Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56]), Buffer.from([0xff, 0xd9])]);
export const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8]), jfif, scan]);
// Little-endian EXIF: orientation 6 and a GPS pointer, the location text right after; then XMP and a comment.
const tiff = Buffer.alloc(38 + HOME.length);
tiff.write('II', 0, 'latin1');
tiff.writeUInt16LE(42, 2);
tiff.writeUInt32LE(8, 4);
tiff.writeUInt16LE(2, 8);
for (const [v, o, w] of [[0x0112, 10, 2], [3, 12, 2], [1, 14, 4], [6, 18, 2], [0x8825, 22, 2], [4, 24, 2], [1, 26, 4], [38, 30, 4]]) {
  if (w === 2) tiff.writeUInt16LE(v!, o!);
  else tiff.writeUInt32LE(v!, o!);
}
tiff.write(HOME, 38, 'latin1');
export const JPEG_GPS = Buffer.concat([
  Buffer.from([0xff, 0xd8]), jfif,
  seg(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff])),
  seg(0xe1, Buffer.from(`http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>${HOME}</x:xmpmeta>`, 'latin1')),
  seg(0xfe, Buffer.from(HOME, 'latin1')),
  scan,
]);

const chunk = (kind: string, data: Buffer) => {
  const c = Buffer.alloc(12 + data.length);
  c.writeUInt32BE(data.length, 0);
  c.write(kind, 4, 'latin1');
  data.copy(c, 8);
  return c; // the CRC isn't checked by the stripper
};
export const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', Buffer.alloc(13, 1)),
  chunk('IDAT', Buffer.alloc(10, 2)),
  chunk('IEND', Buffer.alloc(0)),
]);
export const PNG_GPS = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', Buffer.alloc(13, 1)),
  chunk('eXIf', Buffer.from(HOME, 'latin1')),
  chunk('tEXt', Buffer.from(`Location\0${HOME}`, 'latin1')),
  chunk('IDAT', Buffer.alloc(10, 2)),
  chunk('IEND', Buffer.alloc(0)),
]);

const riff = (...chunks: [string, Buffer][]) => {
  const body = Buffer.concat(chunks.map(([k, d]) => {
    const h = Buffer.alloc(8);
    h.write(k, 0, 'latin1');
    h.writeUInt32LE(d.length, 4);
    return Buffer.concat([h, d, Buffer.alloc(d.length % 2)]);
  }));
  const head = Buffer.from('RIFF\0\0\0\0WEBP', 'latin1');
  head.writeUInt32LE(body.length + 4, 4);
  return Buffer.concat([head, body]);
};
export const WEBP = riff(['VP8 ', Buffer.alloc(32, 7)]);
export const WEBP_GPS = riff(['VP8X', Buffer.from([0x0c, 0, 0, 0, 0, 0, 0, 0, 0, 0])], ['VP8 ', Buffer.alloc(32, 7)], ['EXIF', Buffer.from(HOME, 'latin1')], ['XMP ', Buffer.from(`<x>${HOME}</x>`, 'latin1')]);
