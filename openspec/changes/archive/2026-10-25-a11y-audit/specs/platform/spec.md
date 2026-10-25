## ADDED Requirements

### Requirement: Accessibility is checked in CI
The system SHALL fail CI when axe-core reports a serious or critical WCAG 2.2 A/AA finding on any admin route, the sign-in pages or an open side sheet.

#### Scenario: Regression caught
- **WHEN** a change introduces text below 4.5:1 contrast on an admin route
- **THEN** the accessibility e2e spec fails and names the route and element
