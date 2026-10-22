# Разведка VK Music Player (vknext) — что берём и как

Источник: CRX `hjilpkmlcpnlaimhaedgnljddlnneipg`, v1.8.6, распакован (139 файлов, 3.4 МБ JS, без source maps).
Все утверждения ниже проверены на живом залогиненном профиле, а не по документации.

## ⚠️ Поправка к первой версии этого отчёта: ссылки через API ЕСТЬ

Первые пробы брали 1–2 первых трека, и они оказались `content_restricted`, поэтому я заключил,
что API ссылок не отдаёт. Замер на 117 треках это опроверг:

| `content_restricted` | треков | с URL |
|---|---|---|
| отсутствует | 104 | **104 (100%)** |
| `2` | 12 | 0 |
| `3` | 1 | 0 |

`audio.get` / `audio.getById` (`api.vk.ru/method`, v5.251) отдают **реальные играбельные URL**
(`https://cs1-41v4.vkuseraudio.ru/s/v1/ac/…`, `https://psv4.vkuseraudio.ru/s/v1/a2/…`), они стабильны
при повторных запросах (проверено: один и тот же URL в `get` и `getById`).

Замер по плейлисту (399 треков, первые 50): **28 с URL, 22 restricted**.

**Следствия:**
- даунлоадеру НЕ нужен сетевой хук для получения ссылок — достаточно `audio.getById`;
- `content_restricted` (2/3) — неразрешимо: VK не отдаёт URL ни в `get`, ни в `getById`, ни без `access_key`;
  такие треки надо честно помечать «недоступен для скачивания», а не ретраить;
- это НЕ отменяет хук: он остаётся для треков, которые уже играются в вебе, и как запасной путь.

## Прочие замеры API

| Метод | Результат |
|---|---|
| `audio.get` | ok, отдаёт URL |
| `audio.getById` | ok, отдаёт URL, поддерживает тройки `owner_id` |
| `audio.getPlaylists` | ok (100 плейлистов) |
| `audio.search` | ok |
| `audio.getRecommendations` | ok, но вернул 0 (нужен другой параметр) |
| `audio.getPopular` | **err code 3 «Unknown method passed»** — метод закрыт |
| `al_audio.php` (`reload_audios` и др.) | ссылок не отдаёт вообще |

## Что делает оригинал

| Возможность | Реализация у них | Проверено |
|---|---|---|
| Играет без вкладки VK | offscreen document + `AudioContext` + WebAudio (Gain + Biquad-эквалайзер 31 Гц…16 кГц) | ✅ `Reason.AUDIO_PLAYBACK` в бандле |
| Потоковое воспроизведение | shaka-player (HLS), каскад FLAC → обычный → HLS | ✅ `forceHls`, `flacSrc` |
| Авторизация | `login.vk.ru?act=web_token` → `access_token`, кэш в `chrome.storage.local['auth']` | ✅ получен реальный токен |
| Метаданные | `api.vk.ru/method`, `v=5.251`, client_id `6287487` | ✅ работает |
| Тексты | Genius (`api.genius.com`, спуф UA `Genius/4.2.1 (Android)`) | ✅ правило №4 |
| Скробблинг | Last.fm (`ws.audioscrobbler.com` + OAuth `api/auth`) | ✅ |
| Эквалайзер, медиа-клавиши | 6 глобальных команд + WebAudio | ✅ |
| «Без рекламы» | НЕ блокировщик: играет через offscreen, рекламные вставки физически неоткуда взять | ✅ 37 `ADS_*` — это коды ошибок API |
| Прокси | ❌ **отсутствует полностью** (`chrome.proxy` не используется) | ✅ отсюда боль пользователя |

## 🔑 Авторизация невозможна без DNR

Проверено в залогиненном профиле, из extension-контекста:

```
web_token → 200 {"type":"error","error_code":"","error_info":"wrong origin"}
```

`Origin` — **запрещённый для fetch заголовок**; задать его скриптом нельзя. Именно поэтому у vknext
правило №1 — DNR подставляет `Origin: https://vk.ru/`. Без `declarativeNetRequest` tabless-авторизация
VK не работает в принципе. С нашими правилами (проверено):

```
web_token → 200 {"type":"okay","user_id":227520957}
audio.get → 200, реальные треки
```

## Прокси — доказано эмпирически

Собрал тестовое расширение, запустил чистый Chromium, поднял локальный прокси-логгер:

| Проверка | Результат |
|---|---|
| `chrome.proxy.settings.set/get/clear` в MV3 | ✅ (нужно только разрешение `proxy`) |
| PAC **per-host** | ✅ `CONNECT api.vk.ru:443` пошёл через прокси, `example.com` — DIRECT |
| `fixed_servers` | ✅ применяется |
| Прокси с логином/паролем | ✅ `webRequest.onAuthRequired` + `asyncBlocking` регистрируется |

→ Требование «свои прокси только для VK, остальной браузер напрямую» **реализуемо**. Сделано в Волне 1.

## DNR-правила (нужны нам в той же роли)

```
1  Origin: https://vk.ru/  → login.vk.ru?act=web_token      ← без него нет токена
2  Origin: https://vk.ru/  → vk.ru/al_audio.php?*
3  Origin: https://vk.ru/  → api.vk.ru/*
4  UA Genius/4.2.1 (Android) → api.genius.com
5  снять X-Frame-Options + CSP (для встраивания/доступа)
6  CORS + Origin для zvuk.com
7  редирект vk.com → vk.ru
8  Origin: https://vk.ru/  → web.api.vk.ru/*
```

## Честные риски

- `content_restricted` треки скачать нельзя в принципе — UI обязан это показывать, а не молча ретраить.
- `access_token` привязан к сессии VK в браузере; при выходе — переавторизация.
- `getPopular` уже закрыт; VK меняет методы без предупреждения — слой API надо изолировать.
- Ссылки имеют ограниченный срок жизни: резолвить их в момент скачивания, а не заранее.
- Реверс-инжиниринг их бандла — только как источник понимания механики (client_id, спуфы); код пишем свой.

