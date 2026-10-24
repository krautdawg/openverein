import { hash, verify, type Algorithm } from '@node-rs/argon2';

const ARGON2ID = 2 as Algorithm; // const enum Algorithm.Argon2id (not importable under verbatimModuleSyntax)

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

// Argon2id, OWASP minimum parameters, pinned so a library update cannot weaken them.
export const hashPassword = (password: string) => hash(password, { algorithm: ARGON2ID, memoryCost: 19456, timeCost: 2, parallelism: 1 });

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
