## ADDED Requirements

### Requirement: Command palette
The system SHALL open a command palette with Ctrl+K (Cmd+K on macOS) from every admin page that lists every navigation target and global action, filters as the user types, and runs the highlighted entry with Enter; modules SHALL be able to add search results (for example members) to it.

#### Scenario: Jump by keyboard
- **WHEN** a signed-in user presses Ctrl+K, types "einst" and presses Enter
- **THEN** the settings page opens without using the mouse

### Requirement: Side sheets and inline editing instead of modal stacks
The system SHALL edit single values in place (click or Enter to edit, Enter to save, Escape to cancel) and open record details in a side sheet over the current list; it SHALL NOT open a modal from within another modal.

#### Scenario: Inline rename
- **WHEN** an admin clicks the club name in the settings, types a new name and presses Enter
- **THEN** the name is saved through the API, the side rail shows the new name and the change is audited
