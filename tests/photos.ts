import { readFileSync } from 'node:fs';

/** Photos made by real encoders (tests/fixtures/photos/generate.py); the *_GPS ones carry a home location. */
const photo = (name: string) => readFileSync(new URL(`./fixtures/photos/${name}`, import.meta.url));
export const HOME = 'GPS 52.3833N 12.9333E';
export const JPEG = photo('plain.jpg');
export const PNG = photo('plain.png');
export const WEBP = photo('plain.webp');
export const JPEG_GPS = photo('gps.jpg');
/** Progressive, with an EXIF segment and a comment between its scans and the location after the end of the image. */
export const JPEG_PROGRESSIVE_GPS = photo('progressive-gps.jpg');
/** Text, eXIf, iCCP and a private chunk. */
export const PNG_GPS = photo('gps.png');
/** EXIF and an ICC profile. */
export const WEBP_GPS = photo('gps.webp');
export const WEBP_ANIMATED = photo('animated.webp');
