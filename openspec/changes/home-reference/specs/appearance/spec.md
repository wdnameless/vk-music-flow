# Appearance capability deltas

## ADDED Requirements

### Requirement: Sidebar carries theme toggle and profile

The sidebar SHALL keep existing navigation and add a theme toggle plus a
profile footer showing the VK account. Friends' music and Upload stay out.

#### Scenario: Toggle and profile present

- **WHEN** the sidebar renders
- **THEN** a theme toggle and the account footer are visible and functional.

### Requirement: Adaptive tile grids

Tile grids SHALL adapt column count to viewport width instead of a fixed
four columns, preserving tile metadata at every width.

#### Scenario: Grids adapt

- **WHEN** the viewport narrows below desktop width
- **THEN** columns reduce without clipping tile content.
