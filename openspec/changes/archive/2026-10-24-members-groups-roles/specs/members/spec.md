## ADDED Requirements

### Requirement: Member search tolerates typos and umlauts
The system SHALL find members by any part of first or last name, company, member number, town or (when visible to the user) e-mail, ignoring case and accents (`muller` finds `Müller`, `yilmaz` finds `Yılmaz`), tolerate small typos in names (`schmitt` finds `Schmidt`), and treat `%` and `_` in the query as literal characters.

#### Scenario: Umlaut-free search
- **WHEN** an admin searches for `muller`
- **THEN** the member `Müller, Jörg` is listed

#### Scenario: Wildcards are literal
- **WHEN** an admin searches for `%`
- **THEN** no member is listed unless a name contains a percent sign

### Requirement: Keyboard-first member list
The system SHALL let users work the member list without a mouse: `/` focuses search, `n` opens the create form, arrow keys (or `j`/`k`) move between rows, Enter opens the record in a side sheet, Space selects a row for bulk actions, and the command palette finds members by name.

#### Scenario: Open a member by keyboard
- **WHEN** a user presses `/`, types a name, tabs into the list and presses Enter on a row
- **THEN** the member opens in a side sheet over the list
