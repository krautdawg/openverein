# Handbuch für die Kasse

Dieses Handbuch ist für Kassenwart:innen und alle, die im Verein mit Geld zu tun haben. Es führt durch ein Vereinsjahr in OpenVerein, von den Beiträgen bis zur Übergabe an die Steuerberatung. Die Begriffe in „Anführungszeichen“ sind die Beschriftungen in der App.

Für Finanzdaten brauchst Du die Anmeldung mit zweitem Faktor (App wie Aegis, 2FAS oder Google Authenticator). Richte sie unter Einstellungen → Sicherheit ein, bevor Du loslegst. Bei heiklen Schritten (zum Beispiel Lastschriften freigeben oder den Gesamtexport laden) fragt OpenVerein den Code noch einmal ab.

## 1. Einmal einrichten

1. **Briefkopf und Bankverbindung** (Einstellungen → Verein): Anschrift, E-Mail, IBAN, BIC und Bank. Diese Angaben stehen auf jeder Rechnung; mit IBAN druckt OpenVerein einen GiroCode zum Scannen.
2. **Gläubiger-ID** (ebenda): nur für Lastschriften. Die Bundesbank vergibt sie.
3. **Steuer und E-Rechnung** (ebenda): Steuernummer oder USt-IdNr., Vereinsregister, Ansprechperson für E-Rechnungen, Kleinunternehmerregelung. Nur nötig, wenn Ihr Rechnungen an Firmen oder Behörden schreibt.
4. **Buchhaltung → Konten**: OpenVerein bringt einen schlanken Kontenplan für Vereine mit. Trag in der Spalte DATEV die Kontonummern aus dem Kontenrahmen Deiner Steuerberatung ein (zum Beispiel SKR 42 oder SKR 49); ohne sie geht kein DATEV-Export. Unter Buchhaltung → Einstellungen stehen Kassenkonto und Beraternummer.
5. **Bank → „Bankkonto anlegen“**: jedes Vereinskonto mit Anfangssaldo zum Stichtag, ab dem Ihr in OpenVerein bucht.
6. **Rechnungstexte** (Einstellungen → Verein → Rechnungen → Standardtexte): ein Text über und einer unter den Positionen, mit Platzhaltern wie {{vorname}} oder {{faellig}}. Sie gelten für jede Rechnung ohne eigenen Text, auch im Beitragslauf.
7. **Verwendungszweck der Lastschrift** (Einstellungen → Verein): zum Beispiel „Beitrag {{mitgliedsnummer}} {{zeitraum}}“, damit Mitglieder die Abbuchung auf dem Kontoauszug erkennen.

## 2. Beiträge

**Beitragsarten** (Beiträge → „Beitragsart anlegen“): Name, „Betrag je Zeitraum“, Zeitraum (einmalig oder 1 bis 60 Monate) und „Gültig ab“. Ändert sich ein Beitrag, legst Du einen neuen Preis mit neuem „Gültig ab“ an; alte Zeiträume werden weiter mit dem alten Preis abgerechnet. Bei anteiliger Berechnung gilt ein neuer Preis ab dem Monat, in dem er beginnt.

**Altersstufen** (in der Beitragsart, optional): zum Beispiel „bis 17 Jahre 60 €“. Es zählt das Alter zu Beginn jedes Zeitraums; wer älter ist, zahlt den normalen Betrag. So braucht Ihr keine eigene Beitragsart für Kinder und Jugendliche, und niemand muss am 18. Geburtstag umgestellt werden.

**Zuordnen**: Im Mitglied (Mitglieder → Name → „Beitrag zuordnen“) wählst Du Beitragsart und Beginn. Dort stellst Du auch die Zahlungsart ein: Überweisung, Lastschrift (braucht ein gültiges Mandat) oder bar.

**Haushalte** (Mitglieder → Haushalte): Familien mit einer zahlenden Person und Familienrabatt. Die Rechnung geht dann an die zahlende Person.

**Beitragslauf** (Beiträge → Läufe):

1. „Abrechnen bis (Stichtag)“, „Rechnungsdatum“ und „Fällig am“ wählen.
2. „Vorschau erstellen“. Die Vorschau zeigt jede Rechnung mit allen Zeiträumen, auch nachgeholte. Nichts ist gebucht.
3. Prüfen, dann „Rechnungen buchen“ und „Ja, buchen“. Ein Zeitraum wird nie zweimal abgerechnet, auch wenn Du den Lauf wiederholst.
4. „Per E-Mail verschicken“: Mitglieder mit E-Mail bekommen die Rechnung als PDF. Wer Briefe bevorzugt oder keine E-Mail hat, steht in der Liste „Als Brief drucken“; „Alle … Briefe als ein PDF“ erzeugt eine Druckdatei nach Postleitzahl, fertig für beidseitigen Druck.

**Automatische Vorschau** (Beiträge → Läufe → „Automatische Vorschau“): An einem Tag im Monat erstellt OpenVerein die Vorschau für alle Zeiträume, die in den nächsten Tagen beginnen, und schickt Dir den Link. Gebucht wird erst, wenn Du bestätigst. Die Vorschau läuft mit Deinen Rechten; hast Du sie nicht mehr, entfällt sie, und das Protokoll vermerkt es.

## 3. Rechnungen, Zahlungen, Mahnungen

- **Einzelne Rechnung** (Rechnungen → „Rechnung schreiben“): Positionen eintragen, Preise inkl. oder zzgl. USt, „Ausstellen“. Ausgestellte Rechnungen ändern sich nicht mehr. Fehler korrigierst Du mit „Stornieren“, das erzeugt eine Stornorechnung. Gutschriften werden nicht storniert; stell stattdessen eine Rechnung aus.
- **Angebote** (Rechnungen → Angebote): zum Beispiel für die Vermietung des Vereinsheims. Ein Angebot bekommt eine eigene Nummer, gilt standardmäßig 30 Tage und wird nicht gebucht. Sagt jemand zu, macht „In Rechnung umwandeln“ daraus einen Rechnungsentwurf.
- **E-Rechnung**: Steht beim Empfänger „E-Rechnung: XRechnung“ (Mitglied → E-Rechnung) mit Leitweg-ID oder E-Rechnungsadresse, erzeugt OpenVerein beim Ausstellen zusätzlich die XRechnung und schickt sie mit. Fehlen Angaben, sagt OpenVerein vor dem Ausstellen, welche.
- **Zahlung von Hand**: In der Rechnung „Zahlung erfassen“. Barzahlungen gehen dabei ins Kassenbuch.
- **Mahnwesen** (Rechnungen → Mahnwesen): Der „Mahnvorschlag“ listet überfällige Rechnungen mit Mahnstufe. „Mahnpause“ hält einzelne Rechnungen bis zu einem Datum zurück. „Mahnung per E-Mail“ verschickt die Erinnerung; wer Briefe bevorzugt oder keine E-Mail hat, bekommt ein Mahnschreiben mit offenem Betrag, Mahngebühr und Zahlungsfrist (14 Tage), alle zusammen als ein PDF nach Postleitzahl.
- **Ausbuchen**: Ist eine Forderung nicht mehr einzutreiben, „Ausbuchen“ mit Grund. Das bleibt im Protokoll sichtbar.

## 4. Lastschriften (SEPA)

1. **Mandat** im Mitglied anlegen: Kontoinhaber:in, IBAN, Datum der Unterschrift. Solange die Unterschrift nicht vorliegt, steht das Mandat auf „Unterschrift fehlt“ und wird nicht eingezogen.
2. **Einzug** (Bank → Einzüge → „Einzug erstellen“): Einzugsdatum wählen. OpenVerein nimmt alle offenen Lastschrift-Rechnungen, prüft Mandate und Vorlauffristen und erstellt die Datei (pain.008).
3. **„Freigeben“** und die Datei im Online-Banking hochladen. Eine Rechnung wird nie zweimal eingezogen.
4. **Rücklastschriften** erkennt OpenVerein im Kontoauszug; die Rechnung ist dann wieder offen.

Erstattungen aus Gutschriften gehen über „Gutschriften überweisen“ als Überweisungsdatei (pain.001).

## 5. Kontoauszüge und Abgleich

1. Bank → Kontobewegungen → „Kontoauszug auswählen“: CAMT.053 (empfohlen) oder CSV aus dem Online-Banking.
2. „Automatisch abgleichen“ ordnet Zahlungen über Rechnungsnummer, Betrag, IBAN und Mitgliedsnummer zu.
3. Was offen bleibt, ordnest Du in Bank → Abgleich von Hand zu. Bewegungen ohne Rechnung (Kontoführungsgebühren, Zuschüsse, Porto) wählst Du per Häkchen aus und buchst sie gemeinsam auf ein Konto, mit Sphäre; sie stehen dann unter „Gebucht“. „Stornieren“ nimmt so eine Buchung mit einer Gegenbuchung zurück.

## 6. Buchhaltung (Einnahmen-Überschuss-Rechnung)

- **Zahlungen auf Rechnungen buchen sich selbst**, mit Umsatzsteuer, wenn die Rechnung welche enthält.
- **Alles andere** (Spenden ohne Rechnung, Zuschüsse, Ausgaben) buchst Du unter Buchhaltung mit „Einnahme“ oder „Ausgabe“: Datum, Buchungstext, Konto, Betrag, Sphäre (ideell, Vermögensverwaltung, Zweckbetrieb, wirtschaftlicher Geschäftsbetrieb) und Steuersatz. Geld zwischen eigenen Konten ist eine Umbuchung über Geldtransit, keine Einnahme.
- **Belege** (Buchhaltung → Belege → „Beleg erfassen“): Rechnung des Lieferanten als Datei, Positionen, Fälligkeit. Ist er bezahlt, wird gebucht. Fehlt ein Beleg, erstellst Du einen „Eigenbeleg“ mit Begründung und Unterschrift.
- **Kassenbuch** (Buchhaltung → Kassenbuch): Bargeld. OpenVerein lässt die Kasse nie ins Minus laufen.
- **Korrekturen**: Gebuchtes wird nicht geändert oder gelöscht, sondern storniert (Gegenbuchung). So verlangen es die GoBD.
- **Abschließen**: Unter Buchhaltung → Einstellungen setzt Du das Sperrdatum (zum Beispiel nach dem Monats- oder Jahresabschluss). Danach ist in diesem Zeitraum nichts mehr zu buchen.
- **Steuersätze** (Buchhaltung → Konten → Steuersätze): 0, 7 und 19 % sind angelegt, auch die Sätze aus der zweiten Jahreshälfte 2020. Einen eigenen Satz legst Du mit Gültigkeit und Steuerkonto an; endet er, setzt Du sein Ende. Der Satz selbst ändert sich nie.

## 7. Spenden

1. Einmalig: Spenden → Einstellungen → „Freistellungsbescheid“ mit Finanzamt, Datum und Zwecken. Ohne gültigen Bescheid stellt OpenVerein keine Zuwendungsbestätigung aus.
2. Spende erfassen (Spenden → „Erfassen“): von Mitgliedern oder anderen Personen, als Geld-, Sach- oder Aufwandsspende.
3. Zuwendungsbestätigung (Spenden → Bestätigungen): einzeln oder als Sammelbestätigung für ein Jahr, nach amtlichem Muster. Eine Spende steht nie auf zwei gültigen Bestätigungen. „Bestätigungen verschicken“ schickt sie per E-Mail mit PDF; die übrigen gibt es als ein Brief-PDF.

## 8. Jahresabschluss und Steuerberatung

1. Alle Kontoauszüge des Jahres importiert und abgeglichen? Kasse gezählt und mit dem Kassenbuch verglichen?
2. Buchhaltung → EÜR: Ergebnis nach Konten und nach Sphären, mit Hinweisen auf Lücken (zum Beispiel Buchungen ohne Beleg).
3. Sperrdatum auf den 31.12. setzen.
4. Buchhaltung → Export: DATEV-Buchungsstapel für die Steuerberatung, oder das Paket für die Betriebsprüfung (Datenträgerüberlassung nach GoBD).
5. Buchhaltung → EÜR → „Kassenbericht“: der Bericht für die Mitgliederversammlung als PDF (Bestände, Einnahmen und Ausgaben nach Sphären).
6. Für Kassenprüfung und Steuerberatung legst Du unter Einstellungen → Zugänge eigene Zugänge an, mit den Rollen „Kassenprüfung“ oder „Steuerberatung“. Beide sehen nur, was sie brauchen, und können nichts ändern.

## Wo steht, wer was gemacht hat?

Einstellungen → Protokoll zeigt jede Änderung mit Person und Zeitpunkt, auch Anmeldungen und Exporte.
