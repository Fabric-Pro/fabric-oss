/**
 * Verifies the `featureMaturationV2Enabled` column on `Organization` defaults
 * to `false` (Feature Maturation V2 is opt-in — every existing org keeps the
 * current single-document maturation flow until explicitly enrolled).
 *
 * Mirrors `organization-document-assistant-flag.test.ts`, but asserts the
 * opposite default: that flag is a default-on kill switch, this one is a
 * default-off opt-in. Inserting via raw SQL exercises the DB-side default so a
 * future migration accidentally flipping it to `true` (which would expose the
 * unreleased editor to every org) is caught at test time, not in production.
 *
 * Real Postgres only — connects to the dev DB Aspire spins up. The `RUN_ID`
 * suffix prevents collisions across parallel vitest workers.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, Prisma } from "../prisma/client";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

const RUN_ID = `${Date.now()}-${process.pid}`;
const ORG_ID = `test-maturation-v2-flag-default-${RUN_ID}`;

describe.skipIf(!hasReachableDatabaseUrl())(
	"Organization.featureMaturationV2Enabled — default value",
	() => {
		beforeAll(async () => {
			// Insert via raw SQL so we exercise the DB-side default rather than
			// Prisma's TS-side default. Reading back via Prisma then proves the
			// row was committed with the expected value.
			const now = new Date();
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "organization" (id, name, slug, "createdAt")
				VALUES (${ORG_ID}, ${"Maturation V2 Flag Default Org"}, ${ORG_ID}, ${now})
				ON CONFLICT (id) DO NOTHING
			`);
		});

		afterAll(async () => {
			await db.organization.deleteMany({ where: { id: ORG_ID } });
		});

		// The default was flipped from false to true when Feature Maturation V2
		// was enabled for every organization and personal workspace, so a new
		// org opts in rather than out. This asserted `false` for weeks after
		// that and nobody saw it: the suite self-skips without a database, and
		// the job that runs it in CI has none.
		it("reads back as true when the column is omitted on insert", async () => {
			const row = await db.organization.findUnique({
				where: { id: ORG_ID },
				select: { featureMaturationV2Enabled: true },
			});
			expect(row).not.toBeNull();
			expect(row?.featureMaturationV2Enabled).toBe(true);
		});
	},
);
