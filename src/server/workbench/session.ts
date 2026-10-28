import { randomBytes, randomUUID } from 'node:crypto';
import type { Clock, UUIDv4 } from '../../domain/workbench/index';

export type LocalSession = { id: UUIDv4; csrfToken: string };
export interface LocalSessionStore {
  issue(): LocalSession;
  get(id: string): LocalSession | null;
  invalidateAll(): void;
}
/** Sessions deliberately have no repository/serialization path or lifetime data TTL. */
export function createLocalSessionStore({ clock }: { clock: Clock }): LocalSessionStore {
  const sessions = new Map<string, LocalSession>();
  return {
    issue() {
      // Read the supplied server clock here so a caller never needs browser time.
      clock.now();
      const session = { id: randomUUID(), csrfToken: randomBytes(32).toString('base64url') };
      sessions.set(session.id, session);
      return { ...session };
    },
    get(id) { const session = sessions.get(id); return session ? { ...session } : null; },
    invalidateAll() { sessions.clear(); },
  };
}
