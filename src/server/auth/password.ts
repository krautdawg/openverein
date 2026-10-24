import { hash, verify } from '@node-rs/argon2';

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

// Argon2id with the library's defaults (m=19456 KiB, t=2, p=1; OWASP minimum).
export const hashPassword = (password: string) => hash(password);

export async function verifyPassword(stored: string | null, password: string) {
  if (!stored) return false;
  try {
    return await verify(stored, password);
  } catch {
    return false;
  }
}

// shortcut: a small built-in deny list, upgrade to the bundled 100k breached-password list (spec auth) in the hardening slice.
const common = new Set(['passwort1234', 'password1234', '123456789012', 'qwertzuiopü1', 'hallohallo12', 'vereinverein']);

export function passwordProblem(password: string): string | null {
  if (password.length < PASSWORD_MIN) return `Mindestens ${PASSWORD_MIN} Zeichen.`;
  if (password.length > PASSWORD_MAX) return `Höchstens ${PASSWORD_MAX} Zeichen.`;
  if (common.has(password.toLowerCase())) return 'Dieses Passwort ist zu verbreitet.';
  return null;
}
