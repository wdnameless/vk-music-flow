# Границы и контракты gap-plan (Austerhout: узкий интерфейс, глубокая реализация)

Швы живут на стороне потребителя. Один владелец на файл. Зоны срезов не
пересекаются: S1/S2 — `src/popup/**`; S3 — `src/lib/{vk-api,proxy,integrations,lastfm}.ts` + `src/lib/dnr.ts`;
S4 — `src/background/sw.ts` + `src/offscreen/**` + `src/lib/{m3u8,id3}.ts` + `src/storage/**` по чтению;
S5 — `src/content/**` + `docs/**` + `README.md` + `.github/**` + `package.json` + `.gitignore`.

## S1/S2: popup (владелец — designer)

```ts
// src/popup/popup.ts — точку входа вида дополняет загрузчик по умолчанию:
openView(name: 'home' | 'explore' | 'my' | 'radio' | 'search' | 'downloads' | 'settings'): Promise<void>;
// контракт: после showView вид 'my'/'radio' инициирует ровно один запрос
// дефолтного списка; повторный вход не дублирует слушатели (#homeHero
// вешается через { once:true } или выносится из loadHome).

// Ошибки плеера/очереди: заменить прямые записи в #dlNote на
showNotice(view: string, text: string): void;
// контракт: сообщение видно в активном виде; #dlNote остаётся только для
// вкладки загрузок (там её читает render()).

// Очередь: клик шлёт СЛОТ порядка (прыжок адресует позицию в order —
// контракт player.jump, offscreen/player.ts:663-668); удалить-кнопка шлёт
// индекс очереди data-qi (контракт player.remove, offscreen/player.ts:629).
//   PLAY_JUMP { index: Number(row.dataset.slot) }     // позиция в order
//   PLAY_REMOVE { index: Number(rm.dataset.remove) }  // индекс в queue (qi)
// DnD — слоты (контракт moveInOrder, queue-order.ts:56-71).
// Проверяемый остаток: подсветка cur при шафле + else-ветка remove()
// при удалении НЕтекущего трека перед текущим (player.ts:643-646).
// Рендер панели — по событиям (PLAYER_STATE/очередь), интервал 800мс
// (popup.ts:1462) больше не перетирает qList/fList/plList.

// Водопад: drawWaterfall сдвигает каждую строку влево на один пиксель,
// правый столбец пишет новый кадр. Сигнатура drawWaterfall(canvas) не меняется.
```

## S3: сеть (владелец — fixer)

```ts
// src/lib/vk-api.ts — vkCall(method, params, opts): контракт токена:
type VkRecoverable = 5 | 14 | 17;
// 5 → перевыпуск токена на ЛЮБОЙ попытке (счётчик перевыпусков = 1 на вызов),
// затем повтор; 14 → Ok с needsCaptcha (без немого провала);
// 17 → Ok с needsValidation. Расширение ответа — только добавление полей,
// старые потребители не ломаются.

// src/lib/proxy.ts — installProxyAuth(getSettings):
// сверка челленджа: (details.challenger?.host ?? details.host,
// details.challenger?.port ?? details.port); счётчик 407-подряд
// (порог в константе, по умолчанию 3): превышение → cb() + пометка записи
// lastCheckOk=false, дальше без шторма.
// checkProxy(): 407/502 прокси → { ok:false }, а не ok:true.

// src/lib/integrations.ts — isArtistBlocked(artist, rules):
// совпадение по целым токенам normalizeName (равенство токена или
// token-boundary), не a.includes(n).

// src/lib/lastfm.ts — scrobbleBatch возвращает принятое/остаток:
// { ok, accepted, ignored, rest: ScrobbleQueueItem[] } (rest — необработанный
// хвост); flushScrobbles складывает rest обратно в очередь.
// isSessionInvalid: только 9 (11 — офлайн сервиса, 16 — временная).
```

## S4: плеер и загрузки (владелец — fixer)

```ts
// src/background/sw.ts:
// PLAY_LIST/PLAY_NEXT/PLAY_JUMP → persistPlayerQueue() после rememberPlayerState.
// nowPlaying переживает рестарт: сохранять { track, startedAt, scrobbled }
// в S.settings (рядом с playerQueue) и восстанавливать в boot(); timeupdate
// со stale startedAt не даёт дубля.
// ENQUEUE/VK_ENQUEUE: journal.ensure — один вызов на пакет (пакетный метод
// Journal.ensureAll или локальная сборка + одна save).
// assembleHls: посегментный retry (по умолчанию 2, экспоненциальная пауза)
// через существующий computeBackoff/backoff.ts; 5000-сегментный кап остаётся.
// saveBlob: запись без base64-удвоения в памяти воркера (поток/chunked или
// прямая передача байтов в downloads API); контракт saveBlob(bytes, fname)
// снаружи не меняется.

// src/offscreen/player.ts:
// setOutputDevice: setSinkId на AudioContext (setSinkId(ctx, id)), фолбэк —
// оба <audio>; destroy(): чистить gaplessTimer + crossfadeTimer;
// измерение громкости: единый сброс (ключ, meter, флаг) только в playCurrent;
// advance/gapless/crossfade: publishMediaSession(next) + syncMediaSessionState.

// src/lib/m3u8.ts — parseIv: вернуть null при длине != 16, вызыватель —
/// понятную ошибку вместо TypeError из SubtleCrypto.
// src/lib/id3.ts — apicPayload: WebP-сигнатура RIFF....WEBP → 'image/webp'.
```

## S5: сбор и гигиена (владелец — fixer; UI-строки — designer)

```ts
// src/content/collector.ts — domRows: title/artist по именованным селекторам
// строки, не по позициям children; бейджи игнорируются.
// src/content/hook-main.ts — extractEmbedded: парсинг вперёд по длине/балансу
// скобок вместо обратного скана; harvest сохраняет access_key/restricted;
// перехват fetch: клонировать в текст только при текстовом content-type
// (или размере < порога), иначе пропускать.
// docs/plan.md + README.md: состояние v0.16.0, честное дерево, без «закрыт»
// про audio.*; .github/workflows/ci.yml: + prettier --check и тест-шаг имен;
// package.json: + "format:check"; .gitignore: .workflow/ backups/ data/;
// VK-Music-Flow-v0.2.2.zip — удалить; Spotify/YouTube — явная маркировка
// «позже», без host-прав и без рабочих кнопок.
```

## Что НЕ меняем (заморозка)

- Контракт `MusicProvider` (platforms/provider.ts) — только использование.
- Формат журнала (`journal.ts` STATUSES/сериализация) — только вызовы.
- DNR-правила Origin-спуфинга (ids 1-3,8) — не трогать.
- PAC-маршрутизация и `applyProxy` — не трогать.
