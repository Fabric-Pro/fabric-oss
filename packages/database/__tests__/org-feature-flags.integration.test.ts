/**
 * Real-Postgres properties of the per-organization override table. The mocked
 * suite in feature-flags.test.ts proves the resolution rule; these three
 * properties belong to the schema and no mock can answer them.
 *
 * Registered in .github/workflows/db-integration.yml — an unlisted suite here
 * runs in no job while both workflows report green.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../prisma/client";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

const d = describe.skipIf(!hasReachableDatabaseUrl());

d("organization_feature_flag_override (real Postgres)", () => {
	let organizationId: string;

	beforeEach(async () => {
		// `createdAt` is REQUIRED with no @default(now()) on this model, so it
		// must be supplied explicitly — a create without it fails at runtime.
		const org = await db.organization.create({
			data: {
				name: "example-org",
				slug: `example-org-${Date.now()}`,
				createdAt: new Date(),
			},
		});
		organizationId = org.id;
	});

	it("stores one row per (key, organization) and rejects a duplicate", async () => {
		await db.organizationFeatureFlagOverride.create({
			data: {
				key: "PUBLISHING_SUITE",
				organizationId,
				enabled: true,
				updatedBy: "user_test",
			},
		});

		await expect(
			db.organizationFeatureFlagOverride.create({
				data: {
					key: "PUBLISHING_SUITE",
					organizationId,
					enabled: false,
					updatedBy: "user_test",
				},
			}),
		).rejects.toMatchObject({ code: "P2002" });
	});

	it("keeps rows for the same key in different organizations", async () => {
		const other = await db.organization.create({
			data: {
				name: "example-org",
				slug: `example-org-other-${Date.now()}`,
				createdAt: new Date(),
			},
		});

		await db.organizationFeatureFlagOverride.createMany({
			data: [
				{
					key: "PUBLISHING_SUITE",
					organizationId,
					enabled: true,
					updatedBy: "user_test",
				},
				{
					key: "PUBLISHING_SUITE",
					organizationId: other.id,
					enabled: false,
					updatedBy: "user_test",
				},
			],
		});

		// Scoped to THIS test's two organizations on purpose. An unscoped
		// `where: { key: "PUBLISHING_SUITE" }` reads the whole table, which
		// still holds the row the previous test created — this file has no
		// cleanup and vitest runs `it` blocks in declaration order — so the
		// count would be 3, not 2, and the suite would fail on its first real
		// run in CI. Scoping also makes the assertion say what it means: this
		// key, for these two organizations. Do not "simplify" the filter away.
		const rows = await db.organizationFeatureFlagOverride.findMany({
			where: {
				key: "PUBLISHING_SUITE",
				organizationId: { in: [organizationId, other.id] },
			},
		});
		expect(rows).toHaveLength(2);
	});

	// A row that outlives its organization is a grant pointing at nothing.
	it("cascades the override away when the organization is deleted", async () => {
		await db.organizationFeatureFlagOverride.create({
			data: {
				key: "PUBLISHING_SUITE",
				organizationId,
				enabled: true,
				updatedBy: "user_test",
			},
		});

		await db.organization.delete({ where: { id: organizationId } });

		const remaining = await db.organizationFeatureFlagOverride.findMany({
			where: { organizationId },
		});
		expect(remaining).toEqual([]);
	});
});
