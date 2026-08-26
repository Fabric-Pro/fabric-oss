/**
 * Integration tests for audit-log sealing against a REAL Postgres.
 *
 * Proves what the pure unit tests (audit-log-seal.test.ts) cannot: that the DB
 * layer actually works end to end —
 *   1. sealing a window and verifying it against the stored rows,
 *   2. detecting a row deleted through the WORM retention-bypass GUC,
 *   3. the audit_log_seal table's own append-only (WORM) trigger.
 *
 * Hermetic on a shared dev DB: every audit row is tagged via `requestId` and
 * lives in a far-future window (year 2099) that no real data occupies, and each
 * test cleans up its rows + seals through the bypass GUCs. Self-skips when no
 * reachable DATABASE_URL is present, and is excluded from the default unit run
 * (see vitest.config.ts INTEGRATION_TESTS).
 *
 * Run locally (Aspire Postgres up):
 *   pnpm --filter @repo/database exec dotenv -c -e ../../.env.local -- \
 *     vitest run __tests__/audit-log-seal.integration.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../prisma/client";
import {
	AUDIT_SEAL_VERSION,
	buildSignedSeal,
	computeContentHash,
	type SealableAuditRow,
	verifySeal,
} from "../prisma/queries/audit-log-seal";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

const TAG = "seal-itest-2099";
const WINDOW_START = new Date("2099-01-01T00:00:00.000Z");
const WINDOW_END = new Date("2099-01-01T01:00:00.000Z");

function auditRowData(id: string, createdAt: Date) {
	return {
		id,
		createdAt,
		actorType: "system",
		action: "auth.login.success",
		category: "auth",
		severity: "info",
		outcome: "success",
		requestId: TAG,
	};
}

async function purgeTestAuditRows(): Promise<void> {
	await db.$transaction([
		db.$executeRawUnsafe("SET LOCAL app.audit_allow_delete = 'on'"),
		db.$executeRaw`DELETE FROM "audit_log" WHERE "requestId" = ${TAG}`,
	]);
}

async function purgeTestSeals(): Promise<void> {
	await db.$transaction([
		db.$executeRawUnsafe("SET LOCAL app.audit_seal_allow_delete = 'on'"),
		db.$executeRaw`DELETE FROM "audit_log_seal" WHERE "keyId" = ${`itest:${TAG}`}`,
	]);
}

async function readWindow(): Promise<SealableAuditRow[]> {
	const rows = await db.auditLog.findMany({
		where: {
			createdAt: { gte: WINDOW_START, lt: WINDOW_END },
			requestId: TAG,
		},
		orderBy: [{ createdAt: "asc" }, { id: "asc" }],
	});
	return rows as unknown as SealableAuditRow[];
}

describe.skipIf(!hasReachableDatabaseUrl())(
	"audit-log sealing (real DB)",
	() => {
		const savedKey = process.env.AUDIT_LOG_SIGNING_KEY;

		beforeAll(async () => {
			process.env.AUDIT_LOG_SIGNING_KEY =
				"integration-test-signing-key-000000";
			await purgeTestSeals();
			await purgeTestAuditRows();
		});

		afterAll(async () => {
			await purgeTestSeals();
			await purgeTestAuditRows();
			if (savedKey === undefined) {
				delete process.env.AUDIT_LOG_SIGNING_KEY;
			} else {
				process.env.AUDIT_LOG_SIGNING_KEY = savedKey;
			}
		});

		it("seals a window, verifies it, then detects a deleted row", async () => {
			await db.auditLog.create({
				data: auditRowData(
					`${TAG}-1`,
					new Date("2099-01-01T00:10:00.000Z"),
				),
			});
			await db.auditLog.create({
				data: auditRowData(
					`${TAG}-2`,
					new Date("2099-01-01T00:20:00.000Z"),
				),
			});
			await db.auditLog.create({
				data: auditRowData(
					`${TAG}-3`,
					new Date("2099-01-01T00:30:00.000Z"),
				),
			});

			const rows = await readWindow();
			expect(rows).toHaveLength(3);

			const { contentHash, rowCount } = computeContentHash(rows);
			const core = {
				sequence: 900_000_001,
				periodStart: WINDOW_START.toISOString(),
				periodEnd: WINDOW_END.toISOString(),
				rowCount,
				contentHash,
				prevSealHash: null,
			};
			const signed = buildSignedSeal(core);
			await db.auditLogSeal.create({
				data: {
					sequence: core.sequence,
					periodStart: WINDOW_START,
					periodEnd: WINDOW_END,
					rowCount,
					contentHash,
					prevSealHash: null,
					sealHash: signed.sealHash,
					signature: signed.signature,
					// Tagged keyId so cleanup can find exactly this test's seals.
					keyId: `itest:${TAG}`,
					version: AUDIT_SEAL_VERSION,
				},
			});

			const seal = {
				...core,
				sealHash: signed.sealHash,
				signature: signed.signature,
				keyId: signed.keyId,
				version: AUDIT_SEAL_VERSION,
			};

			// Clean read of the stored rows verifies against the stored seal.
			expect(verifySeal(seal, await readWindow(), null)).toEqual({
				ok: true,
			});

			// Delete a covered row through the sanctioned WORM bypass — simulating a
			// tamper that got past the trigger — and confirm the seal now fails.
			await db.$transaction([
				db.$executeRawUnsafe("SET LOCAL app.audit_allow_delete = 'on'"),
				db.$executeRaw`DELETE FROM "audit_log" WHERE "id" = ${`${TAG}-2`}`,
			]);

			const afterTamper = await readWindow();
			expect(afterTamper).toHaveLength(2);
			expect(verifySeal(seal, afterTamper, null)).toMatchObject({
				ok: false,
				reason: "CONTENT_TAMPERED",
			});
		});

		it("audit_log_seal rejects UPDATE (append-only)", async () => {
			await db.auditLogSeal.create({
				data: {
					sequence: 900_000_002,
					periodStart: WINDOW_START,
					periodEnd: WINDOW_END,
					rowCount: 0,
					contentHash: "x",
					prevSealHash: null,
					sealHash: "y",
					signature: "z",
					keyId: `itest:${TAG}`,
					version: AUDIT_SEAL_VERSION,
				},
			});

			await expect(
				db.auditLogSeal.update({
					where: { sequence: 900_000_002 },
					data: { rowCount: 999 },
				}),
			).rejects.toThrow(/append-only/i);
		});

		it("audit_log_seal rejects DELETE without the bypass GUC", async () => {
			await db.auditLogSeal.create({
				data: {
					sequence: 900_000_003,
					periodStart: WINDOW_START,
					periodEnd: WINDOW_END,
					rowCount: 0,
					contentHash: "x",
					prevSealHash: null,
					sealHash: "y",
					signature: "z",
					keyId: `itest:${TAG}`,
					version: AUDIT_SEAL_VERSION,
				},
			});

			await expect(
				db.auditLogSeal.delete({ where: { sequence: 900_000_003 } }),
			).rejects.toThrow(/append-only/i);

			// The bypass GUC in the same transaction DOES allow the delete.
			await expect(
				db.$transaction([
					db.$executeRawUnsafe(
						"SET LOCAL app.audit_seal_allow_delete = 'on'",
					),
					db.$executeRaw`DELETE FROM "audit_log_seal" WHERE "sequence" = 900000003`,
				]),
			).resolves.toBeDefined();
		});
	},
);
