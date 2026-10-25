import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { config } from './config.ts';

/**
 * Field encryption for bank data (IBANs, stored SEPA files). AES-256-GCM with a key derived from
 * DATA_KEY; a separate derived key makes the HMAC used to find a person by IBAN without decrypting.
 * Losing DATA_KEY makes the encrypted fields unreadable: keep it with the backup password.
 */
function keys() {
  const master = Buffer.from(config.dataKey, 'base64');
  if (master.length < 32) throw new Error('DATA_KEY must be at least 32 bytes, base64 encoded (openssl rand -base64 32)');
  return {
    enc: Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), 'openverein:enc:v1', 32)),
    mac: Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), 'openverein:mac:v1', 32)),
  };
}
let cached: ReturnType<typeof keys> | null = null;

/** Keyed fingerprint of DATA_KEY (not the key): equal only for the same key. */
export const dataKeyCheck = () => createHmac('sha256', k().mac).update('openverein:data-key-check:v1').digest('hex');

/** Called at startup, so a missing or short DATA_KEY stops the server instead of failing on first use. */
export const assertDataKey = () => void k();
const k = () => (cached ??= keys());

/** "v1:" + base64(iv | tag | ciphertext) */
export function encrypt(plain: string) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', k().enc, iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return 'v1:' + Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
}

export function decrypt(stored: string) {
  if (!stored.startsWith('v1:')) throw new Error('unknown ciphertext version');
  const raw = Buffer.from(stored.slice(3), 'base64');
  const d = createDecipheriv('aes-256-gcm', k().enc, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}

/** Deterministic keyed hash for equality lookups (IBAN matching). */
/** Bytes at rest (full exports): iv | tag | ciphertext, same key as the field encryption. */
export function encryptBytes(plain: Buffer) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', k().enc, iv);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
}
export function decryptBytes(stored: Buffer) {
  const d = createDecipheriv('aes-256-gcm', k().enc, stored.subarray(0, 12));
  d.setAuthTag(stored.subarray(12, 28));
  return Buffer.concat([d.update(stored.subarray(28)), d.final()]);
}

export const blindIndex = (value: string) => createHmac('sha256', k().mac).update(value).digest('hex');

export const maskIban = (iban: string) => `${iban.slice(0, 2)}•• •••• •••• •••• ••${iban.slice(-4, -2)} ${iban.slice(-2)}`;
