# Interfaces: ui-redesign

## Границы

- popup.html/css/ts — единственный изменяемый слой (плюс Settings-тип).
- SW читает `playerBarPosition`/`theme` только через GET_STATE (без новых команд,
  кроме существующих SETTINGS-patch).

## Контракты

- `Settings.playerBarPosition: 'top' | 'bottom'` (default 'bottom').
- `Settings.theme: 'auto' | 'dark' | 'light'` (default 'auto').
- `body[data-player-bar]`, `body[data-theme]` — CSS-якоря, ставит popup.ts при
  init + на каждое изменение настроек.
- `wireTrackList`: клик → play, если `closest('input,button,a,[data-tick],[data-next],[data-enqueue]')` пуст.
- Sprite: `<symbol id="i-x" viewBox="0 0 24 24">`, use-ссылки без изменений.

## Владельцы

- Все слайсы: orchestrator (малые правки, зоны пересекаются в popup.*).
