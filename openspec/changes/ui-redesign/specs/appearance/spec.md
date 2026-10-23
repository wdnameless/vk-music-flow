# Appearance deltas

## ADDED Requirements

### Requirement: Light and dark themes

The interface SHALL support dark and light themes with auto mode following
the OS color scheme plus a manual override persisted in settings.

#### Scenario: Auto follows OS

- **WHEN** theme is auto and the OS uses a light scheme
- **THEN** the light palette applies.

### Requirement: Grouped settings

Settings SHALL be organized into collapsible groups (Sound, Downloads,
Network, Last.fm, Appearance) preserving every existing control.

#### Scenario: Groups render

- **WHEN** the settings view opens
- **THEN** five group headers are visible and expandable.
