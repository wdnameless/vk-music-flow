# CONTEXT.md — Ubiquitous Language (VK MUSIC FLOW)

Canonical vocabulary. Oracle rejects synonyms or undocumented public symbols.

- **Track**: one playable audio item (`Track`: key/nativeId/artist/title/album/duration/cover).
- **Playlist / PlaylistRef**: named collection; `PlaylistRef` is the openable handle.
- **Shelf**: titled horizontal row of playlists on Home (from catalog blocks).
- **Tile grid**: multi-column track cards (cover + title + artist + duration).
- **Genre chip**: fixed-taxonomy button running Search for that genre.
- **Similar**: seed-track recommendations via `target_audio`, fallback to mix.
- **Queue / Order**: `queue` = user list, `order` = play order, `pos` = cursor.
- **Stream**: fresh playable URL (`StreamRef`), resolved at play/download time.
- **Catalog section/block**: VK `catalog.getAudio/getSection` navigation units.
