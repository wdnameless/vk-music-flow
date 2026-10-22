import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { parseProxyLine } from '../src/lib/proxy.js';

// Proxy lines are copied out of provider dashboards in every shape they happen
// to use. Parsing them is the difference between a working import and a form the
// user has to retype by hand, so the shapes that actually appear are pinned here.

describe('прокси: разбор строки', () => {
  it('понимает host:port и подставляет схему по умолчанию', () => {
    const p = parseProxyLine('1.2.3.4:1080');
    assert.deepEqual(p, { scheme: 'socks5', host: '1.2.3.4', port: 1080, username: undefined, password: undefined });
  });

  it('понимает строку со схемой', () => {
    assert.equal(parseProxyLine('http://1.2.3.4:8080')?.scheme, 'http');
    assert.equal(parseProxyLine('socks4://1.2.3.4:9050')?.scheme, 'socks4');
    assert.equal(parseProxyLine('https://proxy.example:3128')?.scheme, 'https');
  });

  it('понимает логин и пароль', () => {
    const p = parseProxyLine('socks5://user:secret@1.2.3.4:1080');
    assert.equal(p?.username, 'user');
    assert.equal(p?.password, 'secret');
    assert.equal(p?.host, '1.2.3.4');
    assert.equal(p?.port, 1080);
  });

  it('не ломается на пароле с двоеточием', () => {
    // Passwords contain colons often enough that splitting on the first one
    // would silently truncate them.
    const p = parseProxyLine('socks5://user:a:b:c@1.2.3.4:1080');
    assert.equal(p?.username, 'user');
    assert.equal(p?.password, 'a:b:c');
  });

  it('понимает логин без пароля', () => {
    const p = parseProxyLine('http://user@1.2.3.4:8080');
    assert.equal(p?.username, 'user');
    assert.equal(p?.password, undefined);
  });

  it('терпит пробелы и лишние слэши', () => {
    // Copied lines routinely arrive with trailing punctuation attached.
    assert.equal(parseProxyLine('  socks5://1.2.3.4:1080  ')?.port, 1080);
    assert.equal(parseProxyLine('socks5://1.2.3.4:1080/')?.host, '1.2.3.4');
  });

  it('подставляет стандартный порт, когда его нет', () => {
    assert.equal(parseProxyLine('socks5://1.2.3.4')?.port, 1080);
    assert.equal(parseProxyLine('http://1.2.3.4')?.port, 8080);
  });

  it('понимает IPv6 в скобках', () => {
    const p = parseProxyLine('[2001:db8::1]:1080');
    assert.equal(p?.host, '2001:db8::1');
    assert.equal(p?.port, 1080);
  });

  it('отклоняет то, что прокси не является', () => {
    // A wrong value here would be pushed into chrome.proxy and break networking.
    assert.equal(parseProxyLine(''), null);
    assert.equal(parseProxyLine('   '), null);
    assert.equal(parseProxyLine('ftp://1.2.3.4:21'), null, 'схема не поддерживается');
    assert.equal(parseProxyLine('не адрес'), null);
    assert.equal(parseProxyLine('1.2.3.4:99999'), null, 'порт вне диапазона');
  });

  it('возвращает то, что можно сразу положить в настройки', () => {
    const p = parseProxyLine('socks5://u:p@host.example:1080');
    assert.ok(p);
    assert.deepEqual(Object.keys(p).sort(), ['host', 'password', 'port', 'scheme', 'username']);
  });
});
