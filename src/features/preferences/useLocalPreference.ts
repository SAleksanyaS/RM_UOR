import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react';
import type { Category, Session } from '../../domain/contracts';
import type { GoalStatus } from '../overview/overview-model';

interface PreferenceValues {
  'shell.navigation': 'compact' | 'expanded';
  'matrix.search': string;
  'matrix.category': Category | 'all';
  'matrix.status': GoalStatus | 'all';
  'matrix.contour': 'official' | 'internal';
  'matrix.density': 'compact' | 'comfortable';
  'matrix.hiddenLeaderIds': string[];
}
export type PreferenceKey = keyof PreferenceValues;
const oneOf = (items: string[]) => (value: unknown) => typeof value === 'string' && items.includes(value);
const validators: Record<PreferenceKey, (value: unknown) => boolean> = {
  'shell.navigation': oneOf(['compact','expanded']),
  'matrix.search': value => typeof value === 'string' && value.length <= 300,
  'matrix.category': oneOf(['all', 'process', 'data', 'architecture', 'security']),
  'matrix.status': oneOf(['all', 'unknown', 'not_met', 'pending', 'confirmed']),
  'matrix.contour': oneOf(['official', 'internal']),
  'matrix.density': oneOf(['compact', 'comfortable']),
  'matrix.hiddenLeaderIds': value => Array.isArray(value) && value.length <= 10000 && value.every(id => typeof id === 'string' && id.trim().length > 0 && id.length <= 500 && !/[\u0000-\u001f]/.test(id)) && new Set(value).size === value.length,
};
/** A browser reader is one local personal profile. Curator IDs are stable public IDs, never session cookies/codes. */
export function preferenceProfile(session: Pick<Session, 'role' | 'curatorId'>) { return session.role === 'curator' && session.curatorId ? `curator:${session.curatorId}` : 'reader'; }
export function preferenceStorageKey(profile: string, key: PreferenceKey): string | null {
  if (!Object.hasOwn(validators, key) || profile.length > 600 || profile !== 'reader' && !/^curator:[^\u0000-\u001f]+$/.test(profile)) return null;
  return `uor.preferences.v1:${encodeURIComponent(profile)}:${key}`;
}
function storage() { try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; } }
export function readLocalPreference<K extends PreferenceKey>(profile: string, key: K, fallback: PreferenceValues[K]): PreferenceValues[K] {
  const name = preferenceStorageKey(profile, key); if (!name) return fallback;
  try { const raw = storage()?.getItem(name); if (!raw || raw.length > 2_000_000) return fallback; const value: unknown = JSON.parse(raw); return validators[key](value) ? value as PreferenceValues[K] : fallback; } catch { return fallback; }
}
export function writeLocalPreference<K extends PreferenceKey>(profile: string, key: K, value: PreferenceValues[K]): boolean {
  const name = preferenceStorageKey(profile, key); if (!name || !validators[key](value)) return false;
  try { const target = storage(); if (!target) return false; const raw = JSON.stringify(value); if (raw.length > 2_000_000) return false; target.setItem(name, raw); return true; } catch { return false; }
}
/** Reset only this profile's approved view keys; other profiles and unrelated local storage remain intact. */
export function resetLocalPreferences(profile: string): boolean {
  const keys = (Object.keys(validators) as PreferenceKey[]).map(key => preferenceStorageKey(profile, key));
  if (keys.some(key => !key)) return false;
  try { const target = storage(); if (!target) return false; for (const key of keys) target.removeItem(key!); return true; } catch { return false; }
}
/** Only small allowlisted view settings are written. Facts, sources, tokens and arbitrary objects have no storage key. */
export function useLocalPreference<K extends PreferenceKey>(profile: string, key: K, fallback: PreferenceValues[K]) {
  const fallbackRef = useRef(fallback); fallbackRef.current = fallback;
  const [stored, setStored] = useState(() => ({ profile, key, value: readLocalPreference(profile, key, fallback) }));
  const [failed, setFailed] = useState(false);
  const value = stored.profile === profile && stored.key === key ? stored.value : readLocalPreference(profile, key, fallback);
  const current = useRef(value); current.current = value;
  useEffect(() => { setStored({ profile, key, value: readLocalPreference(profile, key, fallbackRef.current) }); setFailed(false); }, [profile, key]);
  const setValue = useCallback((next: SetStateAction<PreferenceValues[K]>) => {
    const accepted = typeof next === 'function' ? (next as (previous: PreferenceValues[K]) => PreferenceValues[K])(current.current) : next;
    if (!Object.hasOwn(validators, key) || !validators[key](accepted)) { setFailed(true); return; }
    current.current = accepted; setStored({ profile, key, value: accepted }); setFailed(!writeLocalPreference(profile, key, accepted));
  }, [profile, key]);
  return [value, setValue, failed] as const;
}
