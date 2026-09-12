import type { JellyfinMedia } from './jellyfin.js';

export function archiveKey(value: string) {
  const match = value.trim().match(/^([a-z]{2,16})[-_\s]+(\d{2,8})$/i);
  return match ? `${match[1].toLowerCase()}-${match[2]}` : null;
}

export function mediaKeys(media: JellyfinMedia) {
  const keys = new Set<string>();
  const source = [media.name, media.originalTitle, media.path].filter((value): value is string => Boolean(value)).join(' ');
  const matcher = /(^|[^a-z0-9])([a-z]{2,16})[-_\s]+(\d{2,8})(?=$|[^a-z0-9])/gi;
  for (const match of source.matchAll(matcher)) keys.add(`${match[2].toLowerCase()}-${match[3]}`);
  return keys;
}

export function exactJellyfinMatch(content: string, candidates: JellyfinMedia[]) {
  const key = archiveKey(content);
  return key ? candidates.find((media) => mediaKeys(media).has(key)) ?? null : null;
}
