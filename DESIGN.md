---
name: OpenVerein
description: Open-source club management for German volunteers, drawn like a sports hall floor.
colors:
  ground: "#f3f4f1"
  surface: "#ffffff"
  surface-sunk: "#eceee9"
  rail: "#12355b"
  rail-raised: "#1b4471"
  rail-ink: "#e9eff6"
  rail-ink-muted: "#a9bdd2"
  ink: "#14202e"
  ink-2: "#47525f"
  ink-3: "#5f6874"
  line: "#d8dbd4"
  line-strong: "#858b83"
  accent: "#bf3a13"
  accent-hover: "#a5310f"
  accent-ink: "#ffffff"
  accent-soft: "#fbe9e3"
  ok: "#2b7a4b"
  ok-soft: "#e3f1e8"
  warn: "#8f5a00"
  warn-soft: "#fbf0d9"
  danger: "#b42318"
  danger-soft: "#fbe7e5"
  demo: "#f2c230"
  court-blau: "#1f5fa8"
  court-gruen: "#2b7a4b"
  court-rot: "#c43b3b"
  court-gelb: "#c99a06"
  court-orange: "#d9661a"
  court-tuerkis: "#13867f"
  court-grau: "#6b7480"
  court-schwarz: "#1d232b"
typography:
  display:
    fontFamily: "'Barlow Semi Condensed', 'Source Sans 3 Variable', sans-serif"
    fontSize: "2rem"
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: "-0.01em"
  headline:
    fontFamily: "'Barlow Semi Condensed', 'Source Sans 3 Variable', sans-serif"
    fontSize: "1.375rem"
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: "-0.01em"
  title:
    fontFamily: "'Barlow Semi Condensed', 'Source Sans 3 Variable', sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: "-0.01em"
  body:
    fontFamily: "'Source Sans 3 Variable', 'Source Sans 3', system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.55
  body-dense:
    fontFamily: "'Source Sans 3 Variable', 'Source Sans 3', system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "'Source Sans 3 Variable', 'Source Sans 3', system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 600
    lineHeight: 1.55
  figure:
    fontFamily: "'Barlow Semi Condensed', 'Source Sans 3 Variable', sans-serif"
    fontSize: "2rem"
    fontWeight: 600
    lineHeight: 1
    fontFeature: "'tnum' 1"
rounded:
  sm: "2px"
  md: "4px"
spacing:
  s-1: "4px"
  s-2: "8px"
  s-3: "12px"
  s-4: "16px"
  s-5: "24px"
  s-6: "32px"
  s-7: "48px"
  s-8: "64px"
components:
  button:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body-dense}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "36px"
  button-hover:
    backgroundColor: "{colors.surface-sunk}"
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
    typography: "{typography.body-dense}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "36px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    height: "36px"
  button-ghost-hover:
    backgroundColor: "{colors.surface-sunk}"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "36px"
  segmented-pressed:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.surface}"
    rounded: "3px"
  rail:
    backgroundColor: "{colors.rail}"
    textColor: "{colors.rail-ink}"
    width: "232px"
  rail-link-current:
    backgroundColor: "{colors.rail-raised}"
    textColor: "{colors.surface}"
    rounded: "{rounded.md}"
    height: "36px"
  table-wrap:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.md}"
  table-row:
    typography: "{typography.body-dense}"
    height: "44px"
    padding: "0 12px"
  table-row-selected:
    backgroundColor: "{colors.accent-soft}"
  sheet:
    backgroundColor: "{colors.surface}"
    width: "min(520px, 100vw)"
    padding: "24px"
  bulkbar:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.surface}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
  demo-banner:
    backgroundColor: "{colors.demo}"
    textColor: "#2a2100"
    padding: "8px 48px"
  portal-tabs:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink-2}"
    height: "56px"
---

# Design System: OpenVerein

## Overview

**Creative North Star: "The Sports Hall Floor"**

The admin app is a calm pale floor (birch ground) with a deep Hallenblau rail along the left. Structure comes from lines: 1px hairlines separate rows, sections and sheet parts, and each group owns one court-line colour that appears as a short 2px stroke, never as a filled box. One signal orange-red, taken from the handball line, marks primary actions, focus and the current selection. Nothing else on the screen is that colour.

The density is set for the work: tables with 44px rows at 14px, the page title large at top left with a one-line summary under it, and the table directly beneath. Detail opens in a side sheet from the right, so the list stays put. Editing happens in place. Cmd/Ctrl+K opens a command palette from anywhere. Copy is German and uses "Du".

Rejected: a coloured header bar over grey cards and modal stacks (the easyVerein anti-reference), plus the banned generic tells listed under Don'ts.

**Key Characteristics:**
- Pale ground, white surfaces only where data lives (tables, sheets, inputs, portal cards).
- Lines carry structure; there are no card shadows.
- Group colour always appears as a short court line next to its name.
- One accent, used only for action, focus and current position.
- Display face for headings and headline figures, text face for everything else.
- Keyboard-first: palette, inline edit, row actions on hover and focus.

## Colors

The palette is a cool, near-neutral floor with a deep blue rail, one hot accent and a fixed set of court-line hues.

### Primary
- **Handball-Line Orange-Red** (accent): primary buttons, the focus ring (`--focus` is the same value), the 24px court line under the current rail link, the current settings tab underline, the current portal tab bar, today's date in the month grid, the selected palette row's left edge, checkbox fill. Hover deepens to accent-hover. **Accent Wash** (accent-soft) is the selected table row and text selection.

### Neutral
- **Pale Birch Floor** (ground): page background for the app, portal and application form.
- **Sheet White** (surface): tables, sheets, inputs, buttons, portal cards, the palette.
- **Worn Floor** (surface-sunk): row hover, ghost-button hover, inline-form wells, out-of-month calendar days.
- **Hallenblau** (rail): side rail, mobile top bar, auth side panel, portal top bar. **Rail Lift** (rail-raised) is the current rail link. **Rail Chalk** (rail-ink) and **Rail Haze** (rail-ink-muted) are text on the rail.
- **Hall Ink** (ink): body text, headings, the pressed segment, the bulk-action bar.
- **Ink 2** (ink-2, 7.2:1 on ground): intros, table headers, labels in fact lists.
- **Ink 3** (ink-3, 5.3:1 on surface): placeholders, meta, dates, axis labels.
- **Hairline** (line): every 1px rule and table border.
- **Control Edge** (line-strong, 3.5:1 on surface): borders of buttons, inputs, selects, the segmented control.

### State
- **ok / warn / danger** with their `-soft` washes: alerts (soft background, strong text), status dots, the warnings list in the member sheet, field errors (danger, 600 weight).
- **Hall Yellow** (demo): the demo banner only, text #2a2100.

### Court lines (group and calendar colours)
blau, gruen, rot, gelb, orange, tuerkis, grau, schwarz. A group or calendar stores the key; components set `--court: var(--court-<key>)` and draw with `var(--court, var(--court-grau))`.

### Named Rules
**The One Signal Rule.** The accent marks action, focus and "you are here". If it is not clickable, focused, selected or current, it is not accent.

**The Line-Not-Fill Rule.** Court colours are drawn as lines (2-3px strokes, a 2px inset underline, a 2px left bar), always next to a text label. Never a filled chip or tinted card.

## Typography

**Display Font:** Barlow Semi Condensed 600 (fallback Source Sans 3 Variable, sans-serif), self-hosted via @fontsource
**Body Font:** Source Sans 3 Variable (fallback Source Sans 3, system-ui, sans-serif), self-hosted via @fontsource

**Character:** Condensed hall-signage headings over a warm, highly legible humanist text face. Only weight 600 of the display face ships.

### Hierarchy
- **Display** (600, 32px, 1.1, -0.01em): page h1, portal and application-form h1 (portal/form tighten to 1.05 / -0.02em).
- **Headline** (600, 22px): section h2, sheet titles, portal card titles.
- **Title** (600, 18px): h3, sheet section heads, rail club name, form legends.
- **Body** (400, 15px, 1.55): default text, inputs. Intros cap at 70ch, previews at 62ch.
- **Body dense** (14px): tables, buttons (600), field labels (600), alerts, toolbars.
- **Label / meta** (13px): table headers (600, ink-2), hints, meta, calendar entries, portal tab labels.
- **Figure** (display 600, 32px, line-height 1, tabular): overview counts, label below in 14px ink-2.

### Named Rules
**The Tabular Column Rule.** Body text keeps proportional figures (`'tnum' 0` on body). Numbers that align or compare (money and number columns, dates in timelines and court-line labels, headline figures) switch on tabular numerals and money columns align right.

**The No-Caps Rule.** No uppercase labels and no tracked-out small caps anywhere; hierarchy comes from size, weight and colour.

## Layout

- **Shell:** two-column grid, rail 232px plus main. Page padding 48px sides and top, 64px bottom, max width 1440px.
- **Page head:** h1 and one-line intro at top left, actions top right (flex-end aligned, wraps), 32px gap to content.
- **Rhythm:** 8px grid with a 4px half step (s-1 to s-8). Sections sit 48px apart; section h2 has 16px below.
- **Control height:** 36px, rising to 44px on coarse pointers.
- **Breakpoints:** 860px (rail becomes an off-canvas drawer with a 56px Hallenblau top bar and a scrim; auth stacks), 760px (`hide-sm` columns drop, status shows its dot only, calendar events become 4px bars), 560px (form rows stack, agenda rows stack), 900px (composer stacks over preview), 720px (portal tabs move from the bottom to a top row).
- **Forms:** column with 16px gaps; two-up rows that collapse below 560px.
- **Portal and application form:** one centred column, max 600px, padding 24px/16px.

## Elevation & Depth

Flat by default. Depth comes from the ground/surface step and from hairlines. Only things that float above the page cast a shadow.

### Shadow Vocabulary
- **Sheet edge** (`box-shadow: -12px 0 32px rgb(20 32 46 / 0.12)`): the right side sheet only.
- **Pop** (`box-shadow: 0 12px 32px rgb(20 32 46 / 0.18)`): the command palette and the open mobile rail drawer.
- Backdrops: dialog `rgb(20 32 46 / 0.35)`, mobile scrim `rgb(20 32 46 / 0.4)`.

### Named Rules
**The Floor-Is-Flat Rule.** Tables, cards, banners and buttons never carry a shadow. If it sits on the floor, it is outlined with a 1px hairline.

## Shapes

Square, workmanlike corners: 4px on every control, table wrapper, alert, card and segment container, 3px on the pressed segment and kbd, 2px on calendar entries and court-line strokes. Circles appear only as status dots (7px), checklist ticks (18px) and the open-ended arrow on a court line (a small triangle). Borders are 1px; the only 2px strokes are court lines, focus outlines and current-tab underlines.

## Components

### Buttons
- **Shape:** 4px radius, 36px tall (44px coarse), 16px side padding, 14px/600 text, optional 16-18px Lucide icon with 8px gap.
- **Default:** white with a Control Edge border; hover Worn Floor.
- **Primary:** accent fill and border, white text; hover accent-hover. One per view region (page head, sheet foot, inline form).
- **Ghost:** no fill, no border; hover Worn Floor. Used for Cancel and low-stakes row actions.
- **Danger:** default or ghost with danger text; never a red fill.
- **Disabled / busy:** opacity 0.55, `not-allowed` cursor; busy uses `aria-busy`.
- **Icon button:** square at control height, transparent, ink-2, hover 12% grey wash. Always has an `aria-label`.
- **Link-like:** text button, ink-2 underlined, for quiet actions inside dense lists.

### Inputs / Fields
- **Style:** white, 1px Control Edge, 4px radius, 36px, 12px padding, 15px text. Selects use a drawn chevron; textareas start at 96px.
- **Hover:** border to ink-3. **Focus:** 2px accent outline at 0 offset plus accent border.
- **Error:** `aria-invalid` danger border; message in 13px/600 danger below.
- **Label:** 14px/600 ink above; hint 13px ink-3.
- **Search:** leading icon at 10px, trailing kbd hint (`/`), max 420px.

### Segmented control
White pill-less group in a 1px Control Edge frame with 2px inner padding; pressed segment is Hall Ink with white text; hover Worn Floor. Used for list views (Aktuell, Aktiv, Anträge, …).

### Tables
- White wrapper, 1px hairline, 4px radius, horizontal scroll inside.
- Headers 13px/600 ink-2, sticky. Rows 44px, 14px, hairline between rows, none after the last.
- Row hover Worn Floor; selected row Accent Wash; keyboard focus 2px inset accent outline; clickable rows take a pointer.
- Name cell 600 ink. Number and money cells right-aligned, tabular.
- **Row actions** are hidden until the row is hovered or has focus inside.
- **Bulk bar:** when rows are checked, a Hall Ink bar with white text and 32px controls appears above the table.
- Table foot: 14px ink-3 count line.

### Side sheet
Native `<dialog>` from the right, `min(520px, 100vw)`, full height, Sheet edge shadow, enters with a 24px slide and fade (220ms). Head: title (h2, focused on open so no ring flashes) and close icon button, hairline below. Body scrolls, 24px padding, sections divided by hairlines with 18px heads and a 9.5rem label column for facts. Optional foot right-aligns actions. Escape and backdrop click close it. Sheets replace modals; they do not stack.

### Inline edit
The value is a button with a dotted Control Edge underline and a text cursor; hover Worn Floor; empty values read "hinzufügen" in ink-3. Click or Enter turns it into an input with Speichern (primary) and Abbrechen (ghost). Enter saves (Cmd/Ctrl+Enter in textareas), Escape cancels, server validation errors show inline with `role="alert"`. No modal.

### Command palette
Native dialog, max 640px, 12vh from the top, 6px radius, Pop shadow. 56px borderless input at 18px with a hairline below; result rows 4px radius, selected row Worn Floor with a 2px accent inset on the left; meta right-aligned; footer with kbd hints in 13px ink-3.

### Navigation
- **Rail:** Hallenblau, club name in the display face with a 13px muted subline, a "Suchen" palette trigger with kbd hint (outlined in 22% Rail Chalk), then links at control height with 18px Lucide icons. Hover: Rail Chalk text on a 6% white wash. Current: Rail Lift fill, white text and a 24px accent court line under the label. Logout sits in the foot under a hairline.
- **Sub-navigation:** 14px/600 ink-2 tabs on a hairline; current tab ink with a 2px accent underline.
- **Mobile:** 56px Hallenblau top bar with menu icon button; rail slides in as a drawer.

### Court lines (signature)
- **Group badge:** a 14×2px stroke in the group colour, 6px gap, then the group name at 14px. Used in tables, sheets and the portal.
- **Membership history:** each membership is a 3px line on a dashed hairline track across one shared time axis, from start to end date; open memberships end in a small arrowhead. Group name left, tabular dates right, end action revealed on hover/focus. An axis below shows the first date and "heute".
- **Calendar:** month-grid events carry a 2px inset underline in their calendar colour (4px solid bars below 760px); agenda items carry a 2px left bar. Today's date is an accent tile.
- **Auth panel:** faint court markings drawn in SVG across the Hallenblau side panel (decorative, `aria-hidden`).

### Status
A 7px dot in the state colour plus the label in the same colour at 14px: aktiv ok, künftig court-blau, Antrag/gekündigt warn, ehemalig ink-3, abgelehnt danger.

### Alerts and checklist
Alerts: 4px radius, soft wash, strong text, 14px, no icon box. Overview checklist: hairline-ruled rows with an 18px circle tick; done rows fill the tick ok-green and strike the label through in ink-2.

### Member portal
Phone first. Hallenblau top bar with the club name and a 44px logout. One column up to 600px. Bottom tab bar (3 tabs, 56px, white, hairline top, safe-area aware); the current tab is ink/600 with a 3px accent bar on its top edge. From 720px the tabs move to a centred top row with the bar under the current tab. Content uses white cards (1px hairline, 4px radius, 16px padding) and hairline lists with 56px tappable rows; a due payment shows as a row led by a short accent line.

## Do's and Don'ts

### Do:
- **Do** take every colour, size, space and duration from `tokens.css`; new group colours get a `--court-*` token.
- **Do** keep the accent for primary action, focus, selection and current position.
- **Do** draw group and calendar colour as a short line next to its name.
- **Do** open detail and edit flows in the right side sheet or inline; keep the list visible.
- **Do** right-align money and number columns with tabular numerals.
- **Do** show row actions on hover and focus-within, never hide them from keyboard users.
- **Do** keep text at 15px for body and 13px as the floor for meta; keep the 2px accent focus outline on every interactive element.
- **Do** give controls 44px on coarse pointers and in the portal.
- **Do** write German UI copy with "Du"; label demo data with the yellow demo banner.
- **Do** zero all motion under `prefers-reduced-motion` (already global).

### Don't:
- **Don't** add a coloured header bar over grey cards, or stack modals (the easyVerein anti-reference).
- **Don't** use a centred hero with a gradient blob, three identical cards, glassmorphism, purple gradients, or rounded-2xl with shadow-lg.
- **Don't** put shadows on tables, cards, buttons or banners.
- **Don't** exceed 4px radius on controls and containers.
- **Don't** fill chips or cards with a group colour.
- **Don't** use uppercase eyebrow or kicker labels above headings.
- **Don't** use emoji or text glyphs as icons; icons are Lucide SVGs at 14-18px.
- **Don't** load third-party fonts, trackers or CDNs; fonts ship through @fontsource.
- **Don't** invent stats or testimonials; overview figures are live counts.
- **Don't** let colour carry meaning alone; pair every status and court colour with text.
