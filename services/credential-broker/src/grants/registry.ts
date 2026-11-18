import { DurableObject } from "cloudflare:workers";
import { and, count, eq, gt, lte, min } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import migrations from "../../drizzle/migrations";
import { grants, leases } from "./schema";

const minuteMs = 60_000;

const maxActiveGrants = 1000;

const maxActiveGrantsPerOwner = 100;

const maxRequestsPerMinute = 120;

const maxConcurrentRequests = 8;

export interface GrantRecord {
  id: string;
  hash: string;
  owner: string;
  permissions: string[];
  expiresAt: number;
  traceparent?: string;
}

export type Authorization =
  | { status: "allowed"; leaseId: string; traceparent: string | null }
  | { status: "invalid" | "forbidden" | "busy" };

export class GrantRegistry extends DurableObject {
  private readonly db;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.db = drizzle(ctx.storage);
    ctx.blockConcurrencyWhile(async () => {
      await migrate(this.db, migrations);
    });
  }

  async create(record: GrantRecord): Promise<boolean> {
    const now = Date.now();

    const accepted = this.ctx.storage.transactionSync(() => {
      // Bound all active rows, including simultaneous issuances from several workflow runs.
      const { total } = this.db
        .select({ total: count() })
        .from(grants)
        .where(gt(grants.expiresAt, now))
        .get()!;

      const { owned } = this.db
        .select({ owned: count() })
        .from(grants)
        .where(and(eq(grants.owner, record.owner), gt(grants.expiresAt, now)))
        .get()!;

      if (total >= maxActiveGrants || owned >= maxActiveGrantsPerOwner) return false;

      this.db.insert(grants).values(record).run();

      return true;
    });

    if (!accepted) return false;

    await this.scheduleCleanup(record.expiresAt);

    return true;
  }

  revoke(id: string, owner: string, admin: boolean): void {
    const match = eq(grants.id, id);
    this.db
      .delete(grants)
      .where(admin ? match : and(match, eq(grants.owner, owner)))
      .run();
  }

  authorize(hash: string, permission: string): Authorization {
    const now = Date.now();

    return this.ctx.storage.transactionSync(() => {
      const grant = this.db
        .select()
        .from(grants)
        .where(and(eq(grants.hash, hash), gt(grants.expiresAt, now)))
        .get();

      if (!grant) return { status: "invalid" };

      if (!grant.permissions.includes(permission)) return { status: "forbidden" };

      const window = Math.floor(now / minuteMs);
      const used = grant.rateWindow === window ? grant.rateCount : 0;

      const { active } = this.db
        .select({ active: count() })
        .from(leases)
        .where(eq(leases.grantId, grant.id))
        .get()!;

      if (used >= maxRequestsPerMinute || active >= maxConcurrentRequests) {
        return { status: "busy" };
      }

      const leaseId = crypto.randomUUID();
      this.db
        .update(grants)
        .set({ rateWindow: window, rateCount: used + 1 })
        .where(eq(grants.id, grant.id))
        .run();
      this.db.insert(leases).values({ id: leaseId, grantId: grant.id }).run();

      return { status: "allowed", leaseId, traceparent: grant.traceparent };
    });
  }

  release(leaseId: string): void {
    this.db.delete(leases).where(eq(leases.id, leaseId)).run();
  }

  override async alarm(): Promise<void> {
    this.db.delete(grants).where(lte(grants.expiresAt, Date.now())).run();

    const next = this.db
      .select({ expire: min(grants.expiresAt) })
      .from(grants)
      .get();

    if (next?.expire != null) await this.scheduleCleanup(next.expire);
  }

  private async scheduleCleanup(at: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();

    if (current == null || at < current) await this.ctx.storage.setAlarm(at);
  }
}
