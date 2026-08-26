/**
 * Integration test for the audit_log WORM (append-only) tamper-evidence
 * guard added in migration 20260702130000_audit_log_worm_tamper_evidence
 * (SOC 2 CC7.2 / CC7.3 — H7).
 *
 * Verifies against a live Postgres that:
 *  - UPDATE of an audit row is rejected (rows are immutable).
 *  - DELETE is rejected without the explicit per-transaction bypass GUC.
 *  - DELETE succeeds WITH `SET LOCAL app.audit_allow_delete = 'on'` (the
 *    controlled retention/legal-hold purge path).
 *  - Deleting an organization PRESERVES its audit rows (FK ON DELETE SET NULL,
 *    not cascade) — the trigger permits the FK->NULL transition while the row
 *    content is otherwise untouched.
 *
 * Self-skips unless a REACHABLE Postgres is configured — `hasReachableDatabaseUrl()`
 * rejects both an unset DATABASE_URL and the CI placeholder URL that the
 * unit-tests workflow exports (which is never actually connected to), so the
 * default `pnpm --filter @repo/database test` run and CI do not require a DB.
 * Runs end-to-end against a real Postgres (local Aspire dev DB / staging clone):
 *   DATABASE_URL=<real> pnpm --filter @repo/database test __tests__/audit-log-worm.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../prisma/client";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

// Gate on a REACHABLE DB, not merely a set DATABASE_URL: CI exports a
// placeholder URL that is never connected to, so `Boolean(process.env.DATABASE_URL)`
// would run this suite straight into ECONNREFUSED in beforeAll.
const hasDb = hasReachableDatabaseUrl();

const ROW = "worm-test-row";
const ORG = "worm-test-org";
const ORG_ROW = "worm-test-org-row";

// A legitimate purge sets the bypass GUC in the SAME transaction as the delete.
async function purge(id: string) {
	await db
		.$transaction([
			db.$executeRawUnsafe("SET LOCAL app.audit_allow_delete = 'on'"),
			db.auditLog.deleteMany({ where: { id } }),
		])
		.catch(() => undefined);
}

const baseRow = {
	actorType: "system",
	action: "test.worm",
	category: "audit",
	severity: "info",
	outcome: "success",
} as const;

describe.skipIf(!hasDb)(
	"audit_log WORM tamper-evidence (SOC 2 CC7.2/CC7.3)",
	() => {
		beforeAll(async () => {
			await purge(ROW);
			await purge(ORG_ROW);
			await db.organization
				.deleteMany({ where: { id: ORG } })
				.catch(() => undefined);
			await db.auditLog.create({ data: { id: ROW, ...baseRow } });
		});

		afterAll(async () => {
			await purge(ROW);
			await purge(ORG_ROW);
			await db.organization
				.deleteMany({ where: { id: ORG } })
				.catch(() => undefined);
		});

		it("rejects UPDATE — audit rows are immutable", async () => {
			await expect(
				db.auditLog.update({
					where: { id: ROW },
					data: { action: "tampered" },
				}),
			).rejects.toThrow();
			const row = await db.auditLog.findUnique({ where: { id: ROW } });
			expect(row?.action).toBe("test.worm");
		});

		it("rejects DELETE without the bypass GUC", async () => {
			await expect(
				db.auditLog.delete({ where: { id: ROW } }),
			).rejects.toThrow();
			expect(await db.auditLog.count({ where: { id: ROW } })).toBe(1);
		});

		it("allows DELETE with an in-transaction bypass (controlled purge)", async () => {
			await db.$transaction([
				db.$executeRawUnsafe("SET LOCAL app.audit_allow_delete = 'on'"),
				db.auditLog.deleteMany({ where: { id: ROW } }),
			]);
			expect(await db.auditLog.count({ where: { id: ROW } })).toBe(0);
		});

		it("preserves the audit trail when an org is deleted (SetNull, not cascade)", async () => {
			await db.organization.create({
				data: {
					id: ORG,
					name: "WORM Test Org",
					slug: `worm-test-${ORG}`,
					createdAt: new Date(),
				},
			});
			await db.auditLog.create({
				data: { id: ORG_ROW, organizationId: ORG, ...baseRow },
			});

			// Deleting the org fires an ON DELETE SET NULL update on audit_log —
			// the WORM trigger must PERMIT that specific FK->NULL transition.
			await db.organization.delete({ where: { id: ORG } });

			const row = await db.auditLog.findUnique({
				where: { id: ORG_ROW },
			});
			expect(row).not.toBeNull(); // survived (not cascade-deleted)
			expect(row?.organizationId).toBeNull(); // FK nulled
			expect(row?.action).toBe("test.worm"); // content intact
		});
	},
);
