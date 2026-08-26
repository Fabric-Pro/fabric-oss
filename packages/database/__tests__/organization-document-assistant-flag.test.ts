/**
 * Verifies the `documentAssistantHistoryEnabled` column on `Organization`
 * defaults to `true` (spec 2026-05-19 §3.11 FR-27, AC-15; Risk R12).
 *
 * Inserts a fresh Organization row without specifying the column and
 * reads it back via Prisma. Asserts the value is `true` so a future
 * accidental migration flipping the default to `false` is caught at
 * test time rather than in production.
 *
 * Real Postgres only — connects to the dev DB Aspire spins up. The
 * `RUN_ID` suffix prevents collisions across parallel vitest workers.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, Prisma } from "../prisma/client";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

const RUN_ID = `${Date.now()}-${process.pid}`;
const ORG_ID = `test-doc-asst-flag-default-${RUN_ID}`;

describe.skipIf(!hasReachableDatabaseUrl())(
	"Organization.documentAssistantHistoryEnabled — default value",
	() => {
		beforeAll(async () => {
			// Insert via raw SQL so we exercise the DB-side default rather
			// than Prisma's TS-side default. Reading back via Prisma then
			// proves the row was committed with the expected value.
			const now = new Date();
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "organization" (id, name, slug, "createdAt")
				VALUES (${ORG_ID}, ${"Doc Asst Flag Default Org"}, ${ORG_ID}, ${now})
				ON CONFLICT (id) DO NOTHING
			`);
		});

		afterAll(async () => {
			await db.organization.deleteMany({ where: { id: ORG_ID } });
		});

		it("reads back as true when the column is omitted on insert", async () => {
			const row = await db.organization.findUnique({
				where: { id: ORG_ID },
				select: { documentAssistantHistoryEnabled: true },
			});
			expect(row).not.toBeNull();
			expect(row?.documentAssistantHistoryEnabled).toBe(true);
		});
	},
);
