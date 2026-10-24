import { randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Session, CuratorSession } from '../../domain/contracts';
import { LocalDatabase } from '../../server/storage/database';

export interface CuratorRecord { id: string; name: string; salt: string; hash: string }
export class ActionError extends Error { constructor(message: string, public statusCode = 400) { super(message); } }
export class RoleService {
  private attempts: number[] = [];
  constructor(private db: LocalDatabase, private registry: CuratorRecord[]) {}
  async enterReader(): Promise<Session> { return this.create('reader', null, 'Просмотр'); }
  async enterCurator(code: string): Promise<Session> {
    this.attempts = this.attempts.filter(t => Date.now() - t < 60_000);
    if (this.attempts.length >= 5) throw new ActionError('Слишком много попыток. Повторите через минуту.', 429);
    this.attempts.push(Date.now());
    if (typeof code !== 'string' || code.length > 256) throw new ActionError('Неверный код куратора', 401);
    const found = this.registry.find(record => {
      const actual = scryptSync(code, record.salt, 64); const wanted = Buffer.from(record.hash, 'hex');
      return wanted.length === actual.length && timingSafeEqual(actual, wanted);
    });
    if (!found) throw new ActionError('Неверный код куратора', 401);
    this.attempts = []; return this.create('curator', found.id, found.name);
  }
  private create(role: Session['role'], curatorId: string | null, name: string): Session {
    const session: Session = { id: randomUUID(), role, curatorId, name, createdAt: new Date().toISOString() };
    this.db.set('sessions', session.id, session); return session;
  }
  get(id?: string): Session | null {
    if (!id) return null; const session = this.db.get<Session>('sessions', id);
    return session && Date.now() - Date.parse(session.createdAt) < 24 * 3600_000 ? session : null;
  }
  async requireCurator(id: string): Promise<CuratorSession> {
    const session = this.get(id);
    if (!session || session.role !== 'curator' || !session.curatorId) throw new ActionError('Изменение доступно куратору УОР', 403);
    return session as CuratorSession;
  }
}
