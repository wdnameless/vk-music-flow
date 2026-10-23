# Player surface deltas

## ADDED Requirements

### Requirement: Icon sprite renders whole glyphs

The icon sprite SHALL define each glyph as a 24px symbol so every
`<use>` reference renders the complete icon.

#### Scenario: Sidebar icons render whole

- **WHEN** the popup opens on any host
- **THEN** every navigation icon shows its complete glyph without clipping.

### Requirement: Player bar position setting

The player bar SHALL be placeable at the top or bottom via a setting,
centered with a symmetric layout.

#### Scenario: Bar on top

- **WHEN** the user selects top position in settings
- **THEN** the player bar renders above the content, transport centered.

### Requirement: Row click plays

Clicking anywhere on a track row except controls SHALL start playback.

#### Scenario: Click row body

- **WHEN** the user clicks the title area of a row
- **THEN** the track starts playing.
