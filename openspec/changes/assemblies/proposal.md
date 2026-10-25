## Why

P2.13: every e.V. holds a general assembly at least once a year. The statutes set an invitation period and the board must prove a proper invitation, record attendance, votes and decisions, and keep minutes. Clubs do this with Word templates and paper lists.

## What Changes

- Assemblies with date, time, place, statutory notice period (days) and an agenda (items, some marked as votes). Default agenda: welcome, board report, auditors' report, discharge of the board (vote), any other business.
- Invitation: e-mail with the agenda to all current members through the existing mail queue, refused when the notice period can no longer be kept; members without usable e-mail are listed for a letter. After the invitation, date and agenda are fixed.
- Attendance (present members out of members on the day), results per agenda item (yes / no / abstain and decision text), closing with chair and minute taker. A closed assembly is frozen in the database.
- Minutes as PDF (marked as draft until closed).
- New nav entry "Versammlungen" for club-wide member readers; the board (club-wide member write) runs it.

## Capabilities

### Modified Capabilities

- `communication`: general assemblies. Proxies, voting rights by age, quorum rules and a supplementary invitation come later.

## Impact

Migration `0032_assemblies.sql`. Message recipient resolution and creation are now module functions (`resolveRecipients`, `createMessage`), shared by the composer and the invitation. The full export takes the new child tables through their parent.
