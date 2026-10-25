import { expect, it } from 'vitest';
import { countryCode, parseCsv, parseCsvLines, parseDate, suggestMapping, uniqueHeaders } from './import.ts';

it('parses semicolon CSV with quotes, BOM and CRLF', () => {
  expect(parseCsv('﻿Vorname;Nachname;Notiz\r\nEva;"Muster; Frau";"sagt ""hallo"""\r\n\r\n')).toEqual([['Vorname', 'Nachname', 'Notiz'], ['Eva', 'Muster; Frau', 'sagt "hallo"']]);
  expect(parseCsv('a,b\n1,"x\ny"')).toEqual([['a', 'b'], ['1', 'x\ny']]);
});

it('reports real line numbers and unclosed quotes', () => {
  expect(parseCsvLines('a;b\n\n1;"x\ny"\n2;z').map((r) => r.line)).toEqual([1, 3, 5]);
  expect(() => parseCsvLines('a;b\n1;"offen')).toThrow(/Zeile 2/);
  expect(parseCsv('"a;b",c;d\n1;2;3')[0]).toEqual(['a;b,c', 'd']);
});

it('prefers clear headers over ambiguous ones', () => {
  expect(suggestMapping(['Name', 'Nachname'])).toEqual({ Name: null, Nachname: 'lastName' });
  expect(uniqueHeaders(['Telefon', 'Telefon', ''])).toEqual(['Telefon', 'Telefon (2)', 'Spalte']);
  expect(countryCode('Österreich')).toBe('AT');
});

it('suggests targets from German and API headers', () => {
  expect(suggestMapping(['Mitgliedsnummer', 'Vorname', 'Name', 'Straße', 'PLZ', 'E-Mail (privat)', 'Eintrittsdatum', 'Lieblingsfarbe'])).toEqual({
    Mitgliedsnummer: 'membershipNumber', Vorname: 'firstName', Name: 'lastName', 'Straße': 'street', PLZ: 'postalCode', 'E-Mail (privat)': 'email', Eintrittsdatum: 'joinDate', Lieblingsfarbe: null,
  });
});

it('parses German and ISO dates and rejects impossible ones', () => {
  expect(parseDate('3.2.1990')).toBe('1990-02-03');
  expect(parseDate('1990-02-03')).toBe('1990-02-03');
  expect(parseDate('30.02.1990')).toBeNull();
  expect(parseDate('heute')).toBeNull();
});
