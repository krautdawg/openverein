## ADDED Requirements

### Requirement: Profile photos without camera metadata
The system SHALL store and publish profile photos without camera metadata. EXIF (except the orientation), GPS, XMP, comments, colour profiles, text and private chunks SHALL NOT be stored or published. A photo whose structure cannot be read, or an animated image, SHALL be refused.

#### Scenario: A phone photo with a location
- **WHEN** a member uploads a JPEG, PNG or WebP that carries a GPS location
- **THEN** neither the stored copy nor the public photo contains the location
- **AND** a JPEG keeps its orientation, so it is shown upright

#### Scenario: A photo stored before the change
- **WHEN** the public feed serves a photo stored with metadata
- **THEN** the served bytes are cleaned, under an ETag that differs from the stored hash
