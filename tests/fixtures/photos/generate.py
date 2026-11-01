# Regenerate with: python3 tests/fixtures/photos/generate.py tests/fixtures/photos  (Pillow; the location text marks what must be stripped)
import io, struct, sys, zlib
from PIL import Image, PngImagePlugin
out = sys.argv[1]
HOME = b'GPS 52.3833N 12.9333E'
img = Image.new('RGB', (24, 16))
for x in range(24):
    for y in range(16): img.putpixel((x, y), (x * 10, y * 15, 128))
exif = Image.Exif()
exif[0x0112] = 6
exif[0x010e] = HOME.decode()  # ImageDescription
gps = exif.get_ifd(0x8825); gps[1] = 'N'; gps[2] = (52.0, 23.0, 0.0); gps[3] = 'E'; gps[4] = (12.0, 56.0, 0.0)
icc = b'\0' * 128 + HOME  # opaque ICC-shaped payload; carries the marker only to prove it is removed
def save(name, data): open(f'{out}/{name}', 'wb').write(data)
b = io.BytesIO(); img.save(b, 'JPEG', exif=exif.tobytes(), comment=HOME); save('gps.jpg', b.getvalue())
# Progressive, with metadata between scans and bytes after EOI.
b = io.BytesIO(); img.save(b, 'JPEG', exif=exif.tobytes(), progressive=True); p = b.getvalue()
first = p.index(b'\xff\xda'); second = p.index(b'\xff\xda', first + 2)
com = b'\xff\xfe' + struct.pack('>H', len(HOME) + 2) + HOME
app = b'\xff\xe1' + struct.pack('>H', len(HOME) + 8) + b'Exif\0\0' + HOME
save('progressive-gps.jpg', p[:second] + com + app + p[second:] + HOME)
# PNG: text chunks, eXIf, a private ancillary chunk, iCCP.
def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
b = io.BytesIO(); info = PngImagePlugin.PngInfo(); info.add_text('Location', HOME.decode()); img.save(b, 'PNG', pnginfo=info, exif=exif.tobytes()); p = b.getvalue()
iend = p.rindex(b'IEND') - 4
p = p[:33] + chunk(b'iCCP', b'x\0\0' + zlib.compress(icc)) + p[33:iend] + chunk(b'loCa', HOME) + p[iend:]
save('gps.png', p)
b = io.BytesIO(); img.save(b, 'WEBP', exif=exif.tobytes(), icc_profile=icc, quality=80); save('gps.webp', b.getvalue())
b = io.BytesIO(); img.save(b, 'WEBP', save_all=True, append_images=[img.rotate(90)], duration=100); save('animated.webp', b.getvalue())
for fmt, ext in [('JPEG', 'jpg'), ('PNG', 'png'), ('WEBP', 'webp')]:
    b = io.BytesIO(); img.save(b, fmt); save(f'plain.{ext}', b.getvalue())
