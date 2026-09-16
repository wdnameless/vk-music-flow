import type { PlayerCommand, PlayerTrack } from '../types.js';
import { Player } from './player.js';

/**
 * Offscreen host: bridges the service worker to the audio player.
 *
 * The worker cannot hold an HTMLMediaElement, so it creates this document and
 * talks to it over `chrome.runtime` messages. Playback therefore continues
 * while the popup is closed, which is the whole point of the offscreen design.
 */

const player = new Player({
  onState: (state) => {
    void chrome.runtime.sendMessage({ t: 'PLAYER_STATE', state }).catch(() => undefined);
  },
  onLoudness: (key, rms, peak) => {
    void chrome.runtime.sendMessage({ t: 'PLAYER_LOUDNESS', key, rms, peak }).catch(() => undefined);
  },
  onEnded: (track) => {
    void chrome.runtime.sendMessage({ t: 'PLAYER_ENDED', track }).catch(() => undefined);
  },
});

chrome.runtime.onMessage.addListener((msg: unknown, _sender, reply) => {
  const m = msg as PlayerCommand | { t: string };
  if (!m || typeof m.t !== 'string') return false;
  switch (m.t) {
    case 'P_PLAY_QUEUE': {
      const c = m as Extract<PlayerCommand, { t: 'P_PLAY_QUEUE' }>;
      void player.setQueue(c.tracks as PlayerTrack[], c.startIndex ?? 0).then(() => reply(player.state()));
      return true;
    }
    case 'P_PLAY':
      void player.play().then(() => reply(player.state()));
      return true;
    case 'P_PAUSE':
      player.pause();
      reply(player.state());
      return false;
    // ---- Queue control ----
    case 'P_SHUFFLE': {
      player.setShuffle((m as Extract<PlayerCommand, { t: 'P_SHUFFLE' }>).on);
      reply(player.state());
      return false;
    }
    case 'P_REPEAT': {
      player.setRepeat((m as Extract<PlayerCommand, { t: 'P_REPEAT' }>).mode);
      reply(player.state());
      return false;
    }
    case 'P_INSERT': {
      const c = m as Extract<PlayerCommand, { t: 'P_INSERT' }>;
      player.insert(c.tracks, c.next ?? false);
      reply(player.state());
      return false;
    }
    case 'P_REMOVE': {
      player.remove((m as Extract<PlayerCommand, { t: 'P_REMOVE' }>).index);
      reply(player.state());
      return false;
    }
    case 'P_MOVE': {
      const c = m as Extract<PlayerCommand, { t: 'P_MOVE' }>;
      player.move(c.from, c.to);
      reply(player.state());
      return false;
    }
    case 'P_JUMP': {
      const c = m as Extract<PlayerCommand, { t: 'P_JUMP' }>;
      void player.jump(c.index).then(() => reply(player.state()));
      return true;
    }
    case 'P_NEXT':
      void player.next().then(() => reply(player.state()));
      return true;
    case 'P_PREV':
      void player.prev().then(() => reply(player.state()));
      return true;
    case 'P_SEEK': {
      const c = m as Extract<PlayerCommand, { t: 'P_SEEK' }>;
      player.seek(c.seconds);
      reply(player.state());
      return false;
    }
    case 'P_VOLUME': {
      const c = m as Extract<PlayerCommand, { t: 'P_VOLUME' }>;
      player.setVolume(c.volume);
      reply(player.state());
      return false;
    }
    case 'P_EQ_ENABLED': {
      const c = m as Extract<PlayerCommand, { t: 'P_EQ_ENABLED' }>;
      player.setEqEnabled(c.enabled);
      reply(player.state());
      return false;
    }
    case 'P_EQ_BANDS': {
      const c = m as Extract<PlayerCommand, { t: 'P_EQ_BANDS' }>;
      player.setEqBands(c.gains);
      reply(player.state());
      return false;
    }
    case 'P_FX': {
      player.setFx((m as Extract<PlayerCommand, { t: 'P_FX' }>).fx);
      reply(player.state());
      return false;
    }
    case 'P_GAIN': {
      player.setNormGain((m as Extract<PlayerCommand, { t: 'P_GAIN' }>).gainDb);
      reply(player.state());
      return false;
    }
    case 'P_OUTPUT': {
      void player.setOutputDevice((m as Extract<PlayerCommand, { t: 'P_OUTPUT' }>).deviceId).then(() => reply(player.state()));
      return true;
    }
    case 'P_DEVICES': {
      void player.refreshDevices().then(() => reply(player.state()));
      return true;
    }
    case 'P_STATE':
      reply(player.state());
      return false;
    default:
      return false;
  }
});

// Tell the worker we are alive so it can push the current queue if it restarts.
void chrome.runtime.sendMessage({ t: 'PLAYER_READY' }).catch(() => undefined);
