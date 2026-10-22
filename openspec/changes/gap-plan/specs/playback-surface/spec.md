# Playback-surface reliability

## ADDED Requirements

### Requirement: Default list loads when a library view opens

The player SHALL fetch and render a default track list when the user opens
the My Music or Radio view, instead of showing an empty view.

#### Scenario: My Music opens with tracks

- **WHEN** the user opens the My Music view
- **THEN** the view issues exactly one default list request and renders tracks,
  or an explicit empty state when the library is empty.

#### Scenario: Radio opens with a stream list

- **WHEN** the user opens the Radio view
- **THEN** the view issues exactly one default list request and renders the
  stream options, or an explicit empty state.

### Requirement: Player and queue errors are visible in the active view

The player SHALL surface playback and queue errors in the currently visible
view instead of writing them only to the downloads tab note.

#### Scenario: Unplayable tracks produce a visible message

- **WHEN** playback of selected tracks fails
- **THEN** the active view shows which tracks were skipped and why.

### Requirement: Queue panel actions address queue items

The queue panel SHALL send queue indexes (`data-qi`) for jump and remove
actions, and the panel SHALL update on player events rather than on a timer
that steals focus.

#### Scenario: Click and remove under shuffle hit the right track

- **WHEN** shuffle is on and the user clicks or removes a queue row
- **THEN** the track under the cursor plays or is removed, and the play
  cursor does not jump.

### Requirement: Like state follows the track

The player SHALL reflect and toggle the like state of the current track
through the platform provider, and the like/dislike indicators SHALL stay in
sync when the track changes.

#### Scenario: Toggling like twice restores the state

- **WHEN** the user presses like on a liked track
- **THEN** the like is removed and the indicator updates.
- **WHEN** the track changes
- **THEN** both indicators reflect the new track.
