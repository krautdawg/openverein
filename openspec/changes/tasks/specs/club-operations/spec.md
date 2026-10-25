## ADDED Requirements

### Requirement: Tasks
The system SHALL let every user create tasks with an assignee and a due date, SHALL let only the creator, the assignee or an administrator change a task, and SHALL name a linked member only to users who may read that member.

#### Scenario: Member outside the viewer's scope
- **WHEN** a trainer of the tennis division views a task linked to a football member
- **THEN** the task is shown without the member
