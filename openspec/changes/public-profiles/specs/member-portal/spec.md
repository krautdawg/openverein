## ADDED Requirements

### Requirement: Member profile in the portal
The system SHALL let a member keep a profile for each membership under their address in the portal: display name, bio, place, organisation, an optional photo, an ordered list of links, a profile type from the club's list (default `none`) and the contact visibility (board by default, members or public). The member SHALL be able to hide the profile at any time.

#### Scenario: Hide at once
- **WHEN** a member with a public profile hides it
- **THEN** the next request to the public feed no longer lists it

#### Scenario: Change needs approval again
- **WHEN** a member changes the bio of an approved profile
- **THEN** the profile is no longer public until the board approves it again

### Requirement: Profile photo needs consent
The system SHALL serve a profile photo publicly only while the member has an active consent for the purpose `photos`.

#### Scenario: Consent withdrawn
- **WHEN** a member withdraws the `photos` consent
- **THEN** the public feed shows no photo for them and the photo URL answers 404

### Requirement: Board approval and public feed
The system SHALL list a profile publicly only if its type is not `none`, the board approved its current version, it is not hidden and the membership is current. It SHALL offer a read-only feed per club with CORS for any origin, short cache headers and a rate limit, and SHALL include the contact e-mail only when its visibility is public.

#### Scenario: Not approved
- **WHEN** a member sets their type to Profi
- **THEN** the feed does not list them until an admin approves the profile

### Requirement: Import of KI Klub profiles
The system SHALL offer a dry-run-first import of KI Klub profiles, links and photos, matched to members by e-mail, reporting what it would create, update or skip before writing.

#### Scenario: Dry run
- **WHEN** the importer runs without the confirm flag
- **THEN** it reports the planned changes and writes nothing
