## Why

P3.6: boards ask members small questions (festival date, kit colour, training times) by mail and count replies by hand.

## What Changes

- Polls with a question, 2–20 answers, single or multiple choice, an end date and an audience (all current members or one group).
- Members answer in the portal, one answer per membership (household proxy included), changeable until the end; they see results only after the end.
- The board sees counts and participation (answered of eligible), never who answered what; it can end a poll early.
- Kommunikation gets a tab bar: E-Mails, Umfragen. Votes go into the full export through their poll.
- Fixes a class name clash: the agenda editor (assemblies, polls) no longer inherits the event list's `.agenda` layout.

## Capabilities

### Modified Capabilities

- `member-portal`: polls.

## Impact

Migration `0040_polls.sql`.
