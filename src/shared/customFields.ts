import { z } from 'zod';

export const CUSTOM_FIELD_TYPES = ['text', 'multiline', 'number', 'date', 'checkbox', 'select', 'multiselect'] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];
export const CUSTOM_FIELD_TYPE_LABEL: Record<CustomFieldType, string> = { text: 'Text', multiline: 'Mehrzeiliger Text', number: 'Zahl', date: 'Datum', checkbox: 'Ja/Nein', select: 'Auswahl', multiselect: 'Mehrfachauswahl' };

export const customField = z.object({
  id: z.uuid(),
  key: z.string(),
  label: z.string(),
  type: z.enum(CUSTOM_FIELD_TYPES),
  options: z.array(z.string()),
  required: z.boolean(),
  position: z.number(),
  visibleToMember: z.boolean(),
  editableByMember: z.boolean(),
  sensitive: z.boolean(),
  archived: z.boolean(),
  valueCount: z.number(),
});
export type CustomField = z.infer<typeof customField>;

export const customFieldInput = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/, 'Nur Kleinbuchstaben, Ziffern und _, beginnend mit einem Buchstaben (2 bis 40 Zeichen).'),
  label: z.string().trim().min(1).max(100),
  type: z.enum(CUSTOM_FIELD_TYPES),
  options: z.array(z.string().trim().min(1).max(100)).max(100).default([]),
  required: z.boolean().default(false),
  position: z.number().int().min(0).max(1000).default(0),
  visibleToMember: z.boolean().default(false),
  editableByMember: z.boolean().default(false),
  sensitive: z.boolean().default(false),
});
export const customFieldPatch = customFieldInput.omit({ key: true }).partial().extend({ archived: z.boolean().optional() });

export type CustomValue = string | number | boolean | string[] | null;

const isRealDate = (v: string) => {
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v);
};

/** Checks and normalises one value for its field; returns the value to store or an error message. */
export function checkCustomValue(f: { type: CustomFieldType; options: string[]; required: boolean; label: string }, v: unknown): { ok: true; value: CustomValue } | { ok: false; message: string } {
  const empty = v === null || v === undefined || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);
  if (empty) return f.required && f.type !== 'checkbox' ? { ok: false, message: `${f.label} ist ein Pflichtfeld.` } : { ok: true, value: null };
  switch (f.type) {
    case 'text':
    case 'multiline':
      return typeof v === 'string' && v.length <= (f.type === 'text' ? 300 : 5000) ? { ok: true, value: v.trim() } : { ok: false, message: `${f.label}: Text zu lang.` };
    case 'number':
      return typeof v === 'number' && Number.isFinite(v) ? { ok: true, value: v } : { ok: false, message: `${f.label}: bitte eine Zahl.` };
    case 'date':
      return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && isRealDate(v) ? { ok: true, value: v } : { ok: false, message: `${f.label}: bitte ein Datum.` };
    case 'checkbox':
      return typeof v === 'boolean' ? { ok: true, value: v } : { ok: false, message: `${f.label}: ja oder nein.` };
    case 'select':
      return typeof v === 'string' && f.options.includes(v) ? { ok: true, value: v } : { ok: false, message: `${f.label}: bitte eine der Auswahlmöglichkeiten.` };
    case 'multiselect':
      return Array.isArray(v) && v.every((x) => typeof x === 'string' && f.options.includes(x)) ? { ok: true, value: [...new Set(v as string[])] } : { ok: false, message: `${f.label}: bitte nur Auswahlmöglichkeiten.` };
  }
}

/** A value as text, for lists, exports and mail placeholders. */
export function customText(type: CustomFieldType, v: unknown) {
  if (v === null || v === undefined) return '';
  if (type === 'checkbox') return v ? 'Ja' : 'Nein';
  if (type === 'date' && typeof v === 'string') return v.split('-').reverse().join('.');
  if (type === 'number' && typeof v === 'number') return v.toLocaleString('de-DE');
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
}
