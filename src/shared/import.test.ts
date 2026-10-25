import { expect, it } from 'vitest';
import { parseCsv, parseDate, suggestMapping } from './import.ts';

it('parses semicolon CSV with quotes, BOM and CRLF', () => {
  expect(parseCsv('﻿Vorname;Nachname;Notiz\r\nEva;"Muster; Frau";"sagt ""hallo"""\r\n\r\n')).toEqual([['Vorname', 'Nachname', 'Notiz'], ['Eva', 'Muster; Frau', 'sagt "hallo"']]);
  expect(parseCsv('a,b\n1,"x\ny"')).toEqual([['a', 'b'], ['1', 'x\ny']]);
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
