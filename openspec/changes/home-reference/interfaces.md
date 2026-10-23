# Interfaces: home-reference

## Границы

- Зона дизайнера: `src/popup/popup.html`, `src/popup/popup.css`,
  рендер-функции в `src/popup/popup.ts` (без смены message-контрактов).
- Зона фиксера: `src/platforms/vk.ts` (`recommendations(targetAudio?)`),
  `src/lib/vk-api.ts` (параметр `target_audio`), `src/types.ts`
  (поле жанра при необходимости).
- Одна зона — один владелец за раз; пересечение только через этот файл.

## Контракты (потребительская сторона)

- `HomeSection = { id: string; title: string; action?: { label: string; view: string } }`
  рендерится `renderHomeSection(host, section)`; треки — `renderTileGrid`,
  плейлисты — `renderShelf`, жанры — `renderGenreChips`.
- `MusicProvider.recommendations(limit?, targetAudio?)`: пустой ответ —
  валиден (UI показывает пустой стейт, не ошибку).
- `Settings.theme` / `Settings.playerBarPosition` читаются как раньше через
  `GET_STATE`; дефолт позиции — `'top'` при отсутствии значения.
- Существующие селекторы `#homeTracks`, `.track`, `[data-play]` сохраняются
  (тесты и wireTrackList не ломаются); тайлы добавляют классы, не заменяют.

## Удаление

- Старый плоский `loadHome` удаляется только после зелёного oracle по S1.
