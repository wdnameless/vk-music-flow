# Home capability deltas

## ADDED Requirements

### Requirement: Home sections mirror reference structure

The Home view SHALL render titled sections (track tiles, playlist shelves,
genres, similar) matching the reference layout order.

#### Scenario: Sections render in order

- **WHEN** Home loads with catalog data available
- **THEN** tile grid, shelves, genre chips, and similar sections appear with
  headers, each with a non-empty or honest empty state.

### Requirement: Monochrome chrome with color artwork

Chrome, text, and surfaces SHALL use Noir tokens only; artwork images stay
in color.

#### Scenario: No color in chrome

- **WHEN** Home renders in either theme
- **THEN** no accent color appears outside `img` artwork and the single
  "unavailable" state.

### Requirement: Top player bar layout

The player bar SHALL span full content width with meta left, transport plus
progress centered, and utility icons plus volume right.

#### Scenario: Bar symmetric at top

- **WHEN** the bar docks on top
- **THEN** transport sits centered with equal wings on both sides.

### Requirement: Track tile grid with metadata

Track tiles SHALL show cover, title, artist, duration, and a mono quality
badge in a responsive multi-column grid with a "Show all" link to the full view.

#### Scenario: Tiles carry metadata

- **WHEN** a tile grid renders
- **THEN** every tile shows cover, title, artist, duration, and quality badge.

### Requirement: Playlist shelves scroll horizontally

Playlist shelves SHALL scroll horizontally as large cards with a category
header and a "Customize recommendations" link to settings.

#### Scenario: Shelves scroll and link out

- **WHEN** a shelf overflows
- **THEN** it scrolls horizontally and its link opens settings.

### Requirement: Genre chips search and play

Genre chips SHALL run the existing search flow for a fixed taxonomy and
immediately play the top result.

#### Scenario: Genre click searches and plays

- **WHEN** the user clicks a genre chip
- **THEN** search results load for that genre and the top track plays.

### Requirement: Similar tracks from seed with fallback

The Similar section SHALL query recommendations with `target_audio` and
fall back to the plain mix when empty; its header names the seed track.

#### Scenario: Similar resolves or empties honestly

- **WHEN** a seed track is playing
- **THEN** Similar shows tracks or an honest empty state, never an error.

### Requirement: Section "Show all" links route to full views

Section links SHALL navigate to the corresponding full view.

#### Scenario: Show all navigates

- **WHEN** the user clicks "Show all" on a section
- **THEN** the matching full view opens.
