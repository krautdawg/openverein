---
version: 1
slug: "src-web-app-tsx"
primary_target: "src/web/App.tsx"
related_targets: []
---

# Surface: admin app shell (src/web)

Mode: Operate. Audience: volunteer treasurers, board members and division leads of a German e.V., evenings at a laptop, sometimes a phone. Task: find a member, change data inline, run club money work safely. Constraints: German "Du" copy, WCAG 2.2 AA, keyboard-first, every action also over the REST API, no external fonts or trackers.

Decision round: no answer mechanism in this unattended team run; assigned direction built, verdicts recorded below.

## Direction contract

THESIS: The club's sports hall floor: a calm pale ground where every group owns one court-line colour, and lines, not boxes, carry structure. Refuses the category default of a coloured header bar over grey cards and modal stacks.

OWN-WORLD: Pale birch ground (cool off-white, not cream), a deep "Hallenblau" side rail, ink near-black blue. One action colour (signal orange-red from the hall's handball line) used only for primary actions and focus. Group colours are court-line colours (blue, green, red, yellow, white-on-dark) drawn as 2px lines. 1px hairline rules, 4px radius maximum, no card shadows. Barlow Semi Condensed (DIN 1451 hall-signage voice) for headings and numbers in headers; Source Sans 3 for text and tables, tabular figures on.

STORY: The volunteer opens the app, sees what needs attention today, finds any member in two keystrokes (Cmd/Ctrl+K), edits in a side sheet without losing the list, and trusts that money actions always preview first.

FIRST VIEWPORT: Left rail (240px, Hallenblau) with club name, nav (Übersicht, Mitglieder, Gruppen, Finanzen, Termine, Kommunikation, Dokumente, Einstellungen) and the command-palette hint. Main area: page title set large in Barlow Semi Condensed at the top left, a one-line summary, then the dense member table directly under it; the side sheet slides in from the right over 480px for detail. Primary action top right in the action colour.

FORM: Turnhalle floor markings, position 6 of 7 on the grounded list; seed:fc47b4aebe625193. Signature move: group membership drawn as court lines: a member's dated group memberships render as horizontal coloured lines across a time axis on the profile, and group badges are short line segments in the group colour.
Raises: from the orienteering map, the accent is reserved strictly for the active action/selection; from the centre-rail edition, every rule is a 1px hairline and radius stays at 4px or less; from the j-card, money columns are right-aligned tabular figures with running totals; from the datamatics field, tabular numerals everywhere numbers appear; from the streaming wall, row actions appear on hover or focus only while the rest of the row stays quiet.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
