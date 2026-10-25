import { expect, it } from 'vitest';
import { checkCustomValue, customText } from './customFields.ts';

it('checks custom values by type', () => {
  const sel = { type: 'select' as const, options: ['S', 'M', 'L'], required: true, label: 'Trikotgröße' };
  expect(checkCustomValue(sel, 'M')).toEqual({ ok: true, value: 'M' });
  expect(checkCustomValue(sel, 'XL').ok).toBe(false);
  expect(checkCustomValue(sel, null)).toEqual({ ok: false, message: 'Trikotgröße ist ein Pflichtfeld.' });
  expect(checkCustomValue({ type: 'multiselect', options: ['a', 'b'], required: false, label: 'x' }, ['a', 'a', 'b'])).toEqual({ ok: true, value: ['a', 'b'] });
  expect(checkCustomValue({ type: 'number', options: [], required: false, label: 'x' }, '3').ok).toBe(false);
  expect(checkCustomValue({ type: 'date', options: [], required: false, label: 'x' }, '2026-02-30').ok).toBe(false);
  expect(checkCustomValue({ type: 'date', options: [], required: false, label: 'x' }, '2026-02-28').ok).toBe(true);
  expect(checkCustomValue({ type: 'date', options: [], required: false, label: 'x' }, '2026-13-01').ok).toBe(false);
  expect(customText('checkbox', false)).toBe('Nein');
  expect(customText('date', '2026-03-05')).toBe('05.03.2026');
});
