import type { PlatformId } from '../types.js';
import { PLATFORM_LABELS } from '../types.js';
import type { MusicProvider } from './provider.js';
import { vkProvider } from './vk.js';

/**
 * Provider registry.
 *
 * VK is registered; Spotify and YouTube are declared as planned so the UI can
 * show them disabled rather than pretending they exist. Adding a real one later
 * is a single `register()` call — nothing in the popup or player changes.
 */

/** Platforms the extension intends to support, in UI order. */
export const PLANNED_PLATFORMS: readonly PlatformId[] = ['vk', 'spotify', 'youtube'];

const registry = new Map<PlatformId, MusicProvider>();

/** Register (or replace) a provider. */
export function register(p: MusicProvider): void {
  registry.set(p.id, p);
}

/** Look up a provider, or null when that platform is not implemented yet. */
export function provider(id: PlatformId): MusicProvider | null {
  return registry.get(id) ?? null;
}

/** Provider for a given track key (`<platform>:<id>`). */
export function providerForKey(key: string): MusicProvider | null {
  const i = key.indexOf(':');
  const id = (i < 0 ? 'vk' : key.slice(0, i)) as PlatformId;
  return provider(id);
}

/** Every implemented provider. */
export function implemented(): MusicProvider[] {
  return [...registry.values()];
}

/** What the source picker renders: label plus whether it is usable yet. */
export function platformStatus(): { id: PlatformId; label: string; available: boolean }[] {
  return PLANNED_PLATFORMS.map((id) => ({
    id,
    label: PLATFORM_LABELS[id],
    available: registry.has(id),
  }));
}

register(vkProvider);
