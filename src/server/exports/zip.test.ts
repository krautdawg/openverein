import { inflateRawSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { cp1252, zip } from './zip.ts';

it('writes a ZIP whose entries inflate back to the input', () => {
  const z = zip([{ name: 'a.txt', data: Buffer.from('Hallo Verein') }, { name: 'ü/b.csv', data: Buffer.from('x;y\r\n1;2') }]);
  expect(z.readUInt32LE(0)).toBe(0x04034b50);
  expect(z.readUInt32LE(z.length - 22)).toBe(0x06054b50);
  const size = z.readUInt32LE(18);
  const nameLen = z.readUInt16LE(26);
  expect(inflateRawSync(z.subarray(30 + nameLen, 30 + nameLen + size)).toString()).toBe('Hallo Verein');
});

it('encodes umlauts and the euro sign for DATEV', () => {
  expect([...cp1252('Grün 5 € – ok ✓')]).toEqual([0x47, 0x72, 0xfc, 0x6e, 0x20, 0x35, 0x20, 0x80, 0x20, 0x96, 0x20, 0x6f, 0x6b, 0x20, 0x3f]);
});
