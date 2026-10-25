## MODIFIED Requirements

### Requirement: Raw byte upload
The system SHALL accept uploads as `application/octet-stream` of at most 20 MB on the file routes only, with place and retention class as query parameters and the file name in the `X-File-Name` header (percent-encoded UTF-8), so names never appear in request URLs.

#### Scenario: Upload elsewhere refused
- **WHEN** a client posts `application/octet-stream` to the members route
- **THEN** the request is refused with 415

#### Scenario: Name in a header
- **WHEN** a file "Attest Müller.pdf" is uploaded with its name in `X-File-Name`
- **THEN** it is stored under that name and the URL carries no name
