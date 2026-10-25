# Vertrag zur Auftragsverarbeitung (Vorlage)

Vorlage nach Art. 28 DSGVO für Betreiber, die OpenVerein für Vereine hosten (`MULTI_TENANT=true`, siehe `operations.md`). Der Verein ist Verantwortlicher, der Betreiber Auftragsverarbeiter. Ersetze alles in [eckigen Klammern] und streiche, was nicht zutrifft.

Diese Vorlage ist keine Rechtsberatung. Lasst sie vor dem ersten Einsatz von einer Anwältin, einem Anwalt oder Eurer Datenschutzberatung prüfen.

| | |
|---|---|
| Verantwortlicher | [Name e.V.], [Anschrift], vertreten durch [Vorstand nach § 26 BGB] |
| Auftragsverarbeiter | [Betreiber], [Anschrift], vertreten durch [ … ] |
| Datenschutzbeauftragte:r des Auftragsverarbeiters | [Name, Kontakt / „nicht benannt, weil nicht verpflichtet“] |
| Hauptvertrag | Hosting von OpenVerein vom [TT.MM.JJJJ] |

## 1. Gegenstand und Dauer

1.1 Der Auftragsverarbeiter betreibt für den Verantwortlichen eine Instanz der Vereinsverwaltung OpenVerein unter der Adresse [verein.example-hosting.de] und verarbeitet dabei personenbezogene Daten im Auftrag.

1.2 Der Vertrag gilt so lange wie der Hauptvertrag. Er endet nicht, solange der Auftragsverarbeiter noch Daten des Verantwortlichen verarbeitet, auch nicht in Sicherungen.

## 2. Art, Zweck und Umfang

2.1 **Zweck:** Bereitstellung, Betrieb, Sicherung und Wartung der Vereinsverwaltung. Fachliche Entscheidungen über die Daten (Aufnahme, Beiträge, Rechnungen, Mitteilungen) trifft nur der Verantwortliche, über seine Zugänge in OpenVerein.

2.2 **Arten von Daten:**
- Stammdaten (Name, Anschrift, Geburtsdatum, Geschlecht, Kontaktdaten)
- Mitgliedschaftsdaten (Eintritt, Austritt, Gruppen, Ehrungen, Kontaktverlauf)
- Bank- und Zahlungsdaten (IBAN, BIC, SEPA-Mandate, Rechnungen, Zahlungen, Kontoauszüge)
- Spendendaten
- Teilnahme an Terminen und Versammlungen
- E-Mail-Verkehr des Vereins
- Dateien, die der Verein hochlädt
- Protokolldaten (wer hat wann was geändert)
- Zugangsdaten der Vereinszugänge (Passwort-Hashes, zweiter Faktor)

[Gesundheitsdaten oder andere besondere Kategorien nach Art. 9 DSGVO nur, wenn der Verein sie in eigenen Feldern erfasst: dann hier nennen.]

2.3 **Betroffene:** Mitglieder, ehemalige Mitglieder, Antragstellende, Erziehungsberechtigte, Spender:innen, Ansprechpersonen von Firmen und Behörden, Zugänge des Vereins.

2.4 **Ort:** Die Verarbeitung findet ausschließlich in [Deutschland / einem Mitgliedstaat der EU] statt, im Rechenzentrum [Anbieter, Standort]. Eine Verarbeitung in einem Drittland bedarf der vorherigen schriftlichen Zustimmung des Verantwortlichen und der Voraussetzungen der Art. 44 ff. DSGVO.

## 3. Pflichten des Auftragsverarbeiters

3.1 Er verarbeitet die Daten nur auf dokumentierte Weisung des Verantwortlichen. Weisungen sind die Nutzung der Software durch die Zugänge des Vereins sowie Weisungen in Textform. Hält er eine Weisung für rechtswidrig, sagt er das unverzüglich.

3.2 Er verpflichtet alle Personen mit Zugang zu den Daten auf Vertraulichkeit.

3.3 Er trifft die technischen und organisatorischen Maßnahmen nach Anlage 1 und hält sie auf dem Stand der Technik. Änderungen dürfen das Schutzniveau nicht senken.

3.4 Er unterstützt den Verantwortlichen bei Anträgen Betroffener, zum Beispiel auf Auskunft, Berichtigung oder Löschung. OpenVerein bietet dafür die Auskunft nach Art. 15 als Datei, die Anonymisierung und den Gesamtexport.

3.5 Er unterstützt den Verantwortlichen bei der Sicherheit der Verarbeitung, bei Meldungen von Datenschutzverletzungen und bei Datenschutz-Folgenabschätzungen.

3.6 Er meldet eine Verletzung des Schutzes personenbezogener Daten unverzüglich, spätestens innerhalb von [24] Stunden nach Kenntnis, an [Kontakt des Vereins]. Die Meldung enthält, soweit bekannt, die Angaben nach Art. 33 Abs. 3 DSGVO.

3.7 Er greift auf Inhalte des Vereins nur zu, soweit es für Betrieb, Fehlerbehebung oder Sicherung nötig ist, und dokumentiert solche Zugriffe.

## 4. Unterauftragsverarbeiter

4.1 Der Verantwortliche stimmt den Unterauftragsverarbeitern in Anlage 2 zu.

4.2 Neue oder geänderte Unterauftragsverarbeiter kündigt der Auftragsverarbeiter mindestens [30] Tage vorher in Textform an. Der Verantwortliche kann aus wichtigem datenschutzrechtlichem Grund widersprechen. Ist keine Einigung möglich, kann er den Hauptvertrag zum Zeitpunkt der Änderung kündigen.

4.3 Der Auftragsverarbeiter verpflichtet Unterauftragsverarbeiter vertraglich mindestens auf die Pflichten dieses Vertrags.

## 5. Rechte des Verantwortlichen

5.1 Der Verantwortliche kann sich von der Einhaltung dieses Vertrags überzeugen: durch Auskünfte, aktuelle Nachweise (zum Beispiel Zertifikate oder Prüfberichte) oder nach Anmeldung durch eine Prüfung vor Ort zu den üblichen Geschäftszeiten.

5.2 Für Prüfungen, die über Auskünfte und vorhandene Nachweise hinausgehen, kann der Auftragsverarbeiter eine angemessene Vergütung verlangen, wenn dies im Hauptvertrag vereinbart ist.

## 6. Ende des Auftrags

6.1 Nach Ende des Auftrags stellt der Auftragsverarbeiter dem Verantwortlichen auf Wunsch den Gesamtexport (alle Daten als JSON und CSV mit allen Dateien, beschrieben in `export-schema.md`) bereit. Danach löscht er alle Daten des Verantwortlichen innerhalb von [30] Tagen und bestätigt die Löschung in Textform.

6.2 Daten in Sicherungen werden mit dem Ablauf der Sicherungen gelöscht, spätestens nach [14] Tagen. Bis dahin werden sie nicht wiederhergestellt, außer auf Weisung des Verantwortlichen.

6.3 Gesetzliche Aufbewahrungspflichten des Verantwortlichen (zum Beispiel § 147 AO) erfüllt der Verantwortliche selbst mit dem Gesamtexport. Der Auftragsverarbeiter bewahrt nichts für ihn auf.

## 7. Schlussbestimmungen

Änderungen bedürfen der Textform. Bei Widersprüchen geht dieser Vertrag dem Hauptvertrag vor, soweit es um den Schutz personenbezogener Daten geht.

[Ort, Datum, Unterschriften]

---

## Anlage 1: Technische und organisatorische Maßnahmen (Art. 32 DSGVO)

Die Maßnahmen in der Software gelten für jede OpenVerein-Instanz. Die Maßnahmen des Betriebs füllt der Betreiber aus.

### In OpenVerein

| Bereich | Maßnahme |
|---|---|
| Zugang | Persönliche Zugänge mit Passwort. Bei Finanzrechten ist ein zweiter Faktor (TOTP) Pflicht, und heikle Schritte verlangen ihn erneut. Fehlversuche führen zu einer zunehmenden Sperre. |
| Berechtigungen | Rollen mit Rechten je Bereich, optional begrenzt auf Abteilungen. Felder wie IBAN, Notiz oder Geburtsdatum lassen sich je Rolle sperren. Kassenprüfung und Steuerberatung bekommen nur Lesezugänge. |
| Trennung | Jeder Verein ist ein eigener Mandant. Jede Abfrage ist auf den Verein des Zugangs beschränkt, und automatische Tests prüfen das für jede Route. Jeder Verein hat eine eigene Adresse, über die sich seine Zugänge und Mitglieder anmelden. |
| Verschlüsselung | IBANs, Bankdateien, Kontoauszüge und Geheimnisse des zweiten Faktors sind in der Datenbank mit einem eigenen Schlüssel (DATA_KEY) verschlüsselt, der getrennt von den Sicherungen verwahrt wird. Die Übertragung läuft nur über HTTPS. |
| Integrität | Ausgestellte Rechnungen, Buchungen und Zuwendungsbestätigungen lassen sich nicht ändern; das sichern Datenbank-Trigger ab. Dateien werden über ihre SHA-256-Prüfsumme gespeichert. |
| Nachvollziehbarkeit | Jede Änderung, Anmeldung und jeder Export wird mit Person und Zeitpunkt protokolliert, in derselben Transaktion wie die Änderung. |
| Datensparsamkeit | Abgelehnte Anträge werden nach sechs Monaten gelöscht. Vorübergehende Dateien laufen nach sieben Tagen ab. Ausgetretene Mitglieder lassen sich anonymisieren, Belege bleiben dabei unverändert. Es gibt eine Auskunft nach Art. 15 als Datei. |
| Missbrauchsschutz | Begrenzte Anfragen je Adresse. Anmeldecodes für das Portal sind begrenzt und verraten nicht, ob eine Adresse Mitglied ist. Webhooks gehen nicht an interne Adressen. |

### Im Betrieb (vom Betreiber auszufüllen)

| Bereich | Maßnahme |
|---|---|
| Rechenzentrum | [Anbieter, Zertifizierung (zum Beispiel ISO 27001), Zutrittskontrolle] |
| Server | [Betriebssystem-Updates, Firewall, SSH nur mit Schlüssel, wer hat Zugang] |
| Sicherung | [täglich mit `ovctl backup`, verschlüsselt kopiert nach …, Aufbewahrung [14] Tage, Wiederherstellung geprüft am …] |
| Schlüssel | [Verwahrung von DATA_KEY und OPERATOR_TOKEN: getrennt von Sicherungen, wer hat Zugriff] |
| Überwachung | [Erreichbarkeit, Speicherplatz, Fehlerprotokolle; Protokolle ohne Inhaltsdaten, Aufbewahrung …] |
| Personal | [Verpflichtung auf Vertraulichkeit, Schulung, Zugriffe nur bei Bedarf und dokumentiert] |
| Vorfälle | [Ablauf und Kontakt für Datenschutzverletzungen, Meldung an den Verein innerhalb von [24] Stunden] |

## Anlage 2: Unterauftragsverarbeiter

| Name, Anschrift | Leistung | Ort der Verarbeitung |
|---|---|---|
| [Hoster] | Server und Speicher | [Deutschland] |
| [Mailversand, zum Beispiel ein SMTP-Relay] | Versand der E-Mails des Vereins | [ … ] |
| [Speicher für Sicherungen] | Sicherungskopien (verschlüsselt) | [ … ] |
