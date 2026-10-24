import { expect, it } from 'vitest';
import { fill, textToHtml } from './mail.ts';

it('fills placeholders and escapes HTML', () => {
  expect(fill('Hallo {{ vorname }}, {{unbekannt}}', { vorname: 'Eva' })).toBe('Hallo Eva, {{unbekannt}}');
  expect(textToHtml('Hallo <b>Eva</b>\nZeile 2\n\nhttps://example.org')).toBe('<p>Hallo &lt;b&gt;Eva&lt;/b&gt;<br>Zeile 2</p>\n<p><a href="https://example.org">https://example.org</a></p>');
});
