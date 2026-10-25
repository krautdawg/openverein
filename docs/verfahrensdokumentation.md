# Verfahrensdokumentation (Vorlage)

Vorlage für die Verfahrensdokumentation nach den GoBD (BMF-Schreiben vom 28.11.2019, Rz. 151 ff.) für Vereine, die ihre Buchführung mit OpenVerein erledigen. Ersetze alles in [eckigen Klammern], streiche, was bei Euch nicht zutrifft, und lege das Dokument mit Datum und Versionsnummer zu den Unterlagen des Vereins. Bei jeder wesentlichen Änderung (neue Version von OpenVerein mit neuen Funktionen, neue Zuständigkeiten, neue Bank) schreibst Du eine neue Version; alte Versionen bleiben 10 Jahre aufbewahrt.

Diese Vorlage ist keine Rechts- oder Steuerberatung. Lass sie von Eurer Steuerberatung durchsehen.

| | |
|---|---|
| Verein | [Name e.V.], [Anschrift] |
| Vereinsregister | [VR …, Amtsgericht …] |
| Steuernummer | [ … ] |
| Version / Stand | [1.0] / [TT.MM.JJJJ] |
| Verantwortlich | [Name, Funktion im Vorstand] |

## 1. Allgemeine Beschreibung

**1.1 Verein und Tätigkeit.** [Zweck laut Satzung, ungefähre Mitgliederzahl, Abteilungen.] Der Verein ist [gemeinnützig nach Freistellungsbescheid vom … / nicht gemeinnützig]. Er hat [keinen / folgenden] wirtschaftlichen Geschäftsbetrieb: [z. B. Vereinsheim, Sponsoring].

**1.2 Art der Buchführung.** Einnahmen-Überschuss-Rechnung (§ 4 Abs. 3 EStG) nach Sphären (ideeller Bereich, Vermögensverwaltung, Zweckbetrieb, wirtschaftlicher Geschäftsbetrieb). [Umsatzsteuer: Kleinunternehmerregelung / Regelbesteuerung.]

**1.3 Eingesetzte Software.** OpenVerein, Version [x.y], Open Source (AGPL-3.0), betrieben [auf eigenem Server bei … / bei …]. Der Quellcode jeder Version ist öffentlich einsehbar. Daneben: [Online-Banking der … Bank, DATEV über die Steuerberatung].

**1.4 Zuständigkeiten.**

| Aufgabe | Person / Funktion |
|---|---|
| Buchungen, Belege, Abgleich | [Kassenwart:in] |
| Freigabe von Lastschriften und Überweisungen | [Kassenwart:in, Vertretung …] |
| Kassenführung Bargeld | [ … ] |
| Kassenprüfung | [Kassenprüfer:innen, gewählt am …] |
| Steuerberatung | [Kanzlei …] |
| Betrieb des Servers, Sicherungen | [ … ] |

## 2. Anwenderdokumentation: Abläufe

**2.1 Belegeingang.** Eingangsrechnungen kommen [per E-Mail / Post]. Sie werden in OpenVerein unter Buchhaltung → Belege mit der Originaldatei erfasst; Papierbelege werden [gescannt und im Original aufbewahrt / nach dem Scannen nach dem Verfahren in 2.7 vernichtet]. Fehlt ein Beleg, wird ein Eigenbeleg mit Begründung und Unterschrift erstellt.

**2.2 Ausgangsrechnungen und Beiträge.** Beiträge entstehen aus Beitragsarten mit zeitlich gültigen Preisen über einen Beitragslauf mit Pflicht-Vorschau. Rechnungen erhalten fortlaufende Nummern; ausgestellte Rechnungen sind unveränderlich, das PDF wird beim Ausstellen gespeichert (bei E-Rechnungen zusätzlich die XRechnung-Datei mit SHA-256-Prüfsumme). Korrekturen erfolgen nur durch Stornorechnung.

**2.3 Zahlungsverkehr.** Lastschriften werden aus offenen Rechnungen mit gültigem SEPA-Mandat als Datei (pain.008) erzeugt, von [ … ] freigegeben und im Online-Banking eingereicht. Kontoauszüge werden [täglich / wöchentlich / monatlich] als CAMT.053 importiert und abgeglichen.

**2.4 Barkasse.** Bargeld wird im Kassenbuch in OpenVerein geführt; ein negativer Kassenbestand wird von der Software abgewiesen. Die Kasse wird [monatlich] gezählt; das Zählprotokoll wird [ … ] aufbewahrt.

**2.5 Buchungen.** Zahlungen auf Rechnungen werden automatisch gebucht; übrige Einnahmen und Ausgaben werden mit Datum, Buchungstext, Konto, Sphäre und Steuersatz erfasst. Jede Buchung ist ausgeglichen (Soll = Haben).

**2.6 Korrekturen und Periodenabschluss.** Gebuchte Buchungen werden nicht geändert oder gelöscht; Korrekturen erfolgen durch Stornobuchung mit Verweis auf die ursprüngliche Buchung. Nach [jedem Monats- / dem Jahresabschluss] setzt [ … ] ein Sperrdatum; Buchungen mit Datum bis zum Sperrdatum sind danach nicht mehr möglich.

**2.7 Ersetzendes Scannen** (falls genutzt). [Wer scannt wann, Prüfung auf Lesbarkeit und Vollständigkeit vor der Vernichtung des Originals, welche Belege im Original bleiben müssen.]

**2.8 Spenden.** Zuwendungsbestätigungen werden nach amtlichem Muster nur bei gültigem Freistellungsbescheid ausgestellt. Eine Spende kann nur auf einer gültigen Bestätigung stehen; ausgestellte Bestätigungen werden nicht geändert, nur storniert.

## 3. Technische Systemdokumentation

**3.1 Datenhaltung.** PostgreSQL-Datenbank; Dateien (Belege, Rechnungs-PDFs, Kontoauszüge) in einem Dateispeicher, abgelegt unter ihrer SHA-256-Prüfsumme. Eine geänderte Datei ist dadurch als Änderung erkennbar.

**3.2 Unveränderbarkeit.** Gebuchte Journalzeilen, ausgestellte Rechnungen, E-Rechnungen und Zuwendungsbestätigungen sind in der Datenbank durch Trigger gegen Änderung und Löschung geschützt; das gilt auch für direkte Zugriffe an der Software vorbei. Das Sperrdatum wird ebenfalls in der Datenbank geprüft.

**3.3 Protokollierung.** Jede Änderung an Stammdaten und Bewegungsdaten, jede Anmeldung und jeder Export wird mit Person, Zeitpunkt und Änderung im Protokoll gespeichert (Einstellungen → Protokoll), in derselben Transaktion wie die Änderung selbst.

**3.4 Zugriffsschutz.** Persönliche Zugänge mit Rollen (Rechte je Bereich: keine / lesen / schreiben, optional begrenzt auf Abteilungen). Für Finanzbereiche ist der zweite Faktor (TOTP) Pflicht. Kassenprüfung und Steuerberatung erhalten eigene, nur lesende Zugänge.

**3.5 Schnittstellen.** DATEV-Buchungsstapel (EXTF), Datenträgerüberlassung für die Betriebsprüfung, Gesamtexport aller Daten (JSON-Lines und CSV mit Prüfsummen, beschrieben in `docs/export-schema.md`), REST-API mit dokumentierter OpenAPI-Beschreibung.

## 4. Betriebsdokumentation

**4.1 Sicherung.** Täglich um [03:15] mit `ovctl backup` (Datenbank und Dateien, mit Prüfsummen), aufbewahrt [14] Tage auf dem Server und kopiert nach [Ziel außerhalb des Servers]. Der Datenschlüssel (DATA_KEY) wird getrennt von den Sicherungen bei [ … ] verwahrt.

**4.2 Wiederherstellung.** Mit `ovctl restore`; Probe-Wiederherstellung [halbjährlich] durch [ … ], Ergebnis wird [ … ] notiert.

**4.3 Updates.** Mit `ovctl update` (sichert vorher automatisch). Version und Datum jedes Updates werden in dieser Dokumentation unter 6. eingetragen.

**4.4 Aufbewahrung.** Bücher und Jahresabschlüsse 10 Jahre, Buchungsbelege 8 Jahre, Handels- und Geschäftsbriefe 6 Jahre (§ 147 AO). Personenbezogene Daten ausgetretener Mitglieder werden auf Antrag oder nach Ablauf der Fristen anonymisiert; Buchungsbelege behalten die Angaben, mit denen sie ausgestellt wurden, bis ihre Aufbewahrungsfrist endet.

## 5. Internes Kontrollsystem

- Vier-Augen-Prinzip bei [Lastschrift-Freigaben über … € / Auszahlungen über … €]: [ … ].
- Abgleich aller Bankkonten mit den Kontoauszügen [monatlich].
- Kassenzählung [monatlich], Abgleich mit dem Kassenbuch.
- Kassenprüfung jährlich vor der Mitgliederversammlung mit eigenem Lesezugang.
- Regelmäßige Durchsicht des Protokolls durch [ … ].

## 6. Änderungshistorie

| Version | Datum | Änderung | Von |
|---|---|---|---|
| 1.0 | [TT.MM.JJJJ] | Erstfassung, OpenVerein [x.y] | [ … ] |
