import { expect, it } from 'vitest';
import { fill, textToHtml } from './mail.ts';

it('fills placeholders and escapes HTML', () => {
  expect(fill('Hallo {{ vorname }}, {{unbekannt}}', { vorname: 'Eva' })).toBe('Hallo Eva, {{unbekannt}}');
  expect(textToHtml('Hallo <b>Eva</b>\nZeile 2\n\nhttps://example.org')).toBe('<p>Hallo &lt;b&gt;Eva&lt;/b&gt;<br>Zeile 2</p>\n<p><a href="https://example.org">https://example.org</a></p>');
  expect(textToHtml('Siehe https://example.org/a. Oder <https://x.de>')).toBe('<p>Siehe <a href="https://example.org/a">https://example.org/a</a>. Oder &lt;<a href="https://x.de">https://x.de</a>&gt;</p>');
});
