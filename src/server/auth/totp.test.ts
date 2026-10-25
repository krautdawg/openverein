import { expect, it } from 'vitest';
import { codeAt, verifyCode } from './totp.ts';

it('matches the RFC 6238 SHA-1 test vectors', () => {
  // Secret "12345678901234567890" in base32.
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  expect(codeAt(secret, Math.floor(59 / 30))).toBe('287082');
  expect(codeAt(secret, Math.floor(1111111109 / 30))).toBe('081804');
  expect(codeAt(secret, Math.floor(2000000000 / 30))).toBe('279037');
  expect(verifyCode(secret, '287082', 59_000)).toBe(1);
  expect(verifyCode(secret, '287082', 200_000)).toBeNull();
});
