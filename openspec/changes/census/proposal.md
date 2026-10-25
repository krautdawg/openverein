## Why

Every sports club reports its members to the Landessportbund (and through it to the DOSB) once a year: members on 1 January by age bracket and gender, per sport. Roadmap P2.5 lists these exports. Clubs currently count by hand in spreadsheets.

## What Changes

- Optional `gender` on persons (weiblich / männlich / divers / keine Angabe), editable in the member sheet, cleared on anonymisation.
- `GET /reports/census?year=` and `/reports/census.csv`: members on 1 January (by join and exit dates) by the census age brackets (bis 6, 7–14, 15–18, 19–26, 27–40, 41–60, über 60; age = census year minus birth year) and gender, for the whole club and per division. Members without a birth date are counted separately. Club-wide readers only.
- Page Mitglieder → Bestandserhebung with year choice and CSV download.
- Demo members get genders.

## Capabilities

### Modified Capabilities

- `members`: census report. State-specific upload formats (LSB `.xml`, DOSB `.dat`) follow once a pilot club names its federation.

## Impact

Migration `0027_census.sql`.
