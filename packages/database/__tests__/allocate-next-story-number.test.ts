/**
 * Spec 2026-05-21-roadmap-unique-sequential-ticket-ids — Group 2 verification.
 *
 * Covers the atomic per-project counter allocator (`allocateNextStoryNumber`)
 * plus the end-to-end `createStory` race that was the root cause of duplicate
 * roadmap identifiers (the old `findFirst({orderBy:createdAt desc}) + 1` had
 * no row lock; two concurrent callers both saw the same "last" row and both
 * minted the same number).
 *
 * Real Postgres only — the same dev DB Aspire spins up. The allocator's
 * `UPDATE ... RETURNING` semantics are not mockable, so the suite self-skips
 * when DATABASE_URL is unset or points at the CI placeholder (see
 * _helpers/db-availability.ts). Mirrors the pattern in
 * cascade-document-assistant.test.ts.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { db, Prisma } from "../prisma/client";
import {
	allocateNextStoryNumber,
	createStory,
} from "../prisma/queries/projects/stories";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

// Unique per-process suffix prevents cross-suite collisions when vitest
// runs files in parallel against the same dev Postgres.
const RUN_ID = `${Date.now()}-${process.pid}`;
const ORG_ID = `test-allocate-next-org-${RUN_ID}`;
const USER_ID = `test-allocate-next-user-${RUN_ID}`;

describe.skipIf(!hasReachableDatabaseUrl())(
	"allocateNextStoryNumber + createStory (spec 2026-05-21 Group 2)",
	() => {
		beforeAll(async () => {
			const now = new Date();
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "user" (id, name, email, "emailVerified", "onboardingComplete", "createdAt", "updatedAt")
				VALUES (${USER_ID}, ${"Allocate Test User"}, ${`${USER_ID}@test.com`}, true, false, ${now}, ${now})
				ON CONFLICT (id) DO NOTHING
			`);
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "organization" (id, name, slug, "createdAt")
				VALUES (${ORG_ID}, ${"Allocate Test Org"}, ${ORG_ID}, ${now})
				ON CONFLICT (id) DO NOTHING
			`);
		});

		afterEach(async () => {
			// Stories must go before statuses must go before projects (FKs).
			await db.userStory.deleteMany({ where: { createdById: USER_ID } });
			await db.projectStoryStatus.deleteMany({
				where: { project: { userId: USER_ID } },
			});
			await db.project.deleteMany({ where: { userId: USER_ID } });
		});

		async function seedProject(overrides?: { nextStoryNumber?: number }) {
			const project = await db.project.create({
				data: {
					name: "Allocate Project",
					userId: USER_ID,
					organizationId: ORG_ID,
					...(overrides?.nextStoryNumber !== undefined
						? { nextStoryNumber: overrides.nextStoryNumber }
						: {}),
				},
			});
			// Seed a default status so createStory doesn't trigger the slow
			// auto-bootstrap path during the concurrency test.
			await db.projectStoryStatus.create({
				data: {
					projectId: project.id,
					name: "Backlog",
					color: "#94a3b8",
					order: 0,
					isDefault: true,
				},
			});
			return project;
		}

		it("returns the pre-incremented counter value as a plain decimal string", async () => {
			const project = await seedProject({ nextStoryNumber: 1 });

			const first = await db.$transaction((tx) =>
				allocateNextStoryNumber(tx, project.id),
			);
			expect(first).toBe("1");

			const second = await db.$transaction((tx) =>
				allocateNextStoryNumber(tx, project.id),
			);
			expect(second).toBe("2");

			const refreshed = await db.project.findUnique({
				where: { id: project.id },
				select: { nextStoryNumber: true },
			});
			expect(refreshed?.nextStoryNumber).toBe(3);
		});

		it("does not advance the counter when the surrounding transaction rolls back", async () => {
			const project = await seedProject({ nextStoryNumber: 7 });

			const ROLLBACK_SENTINEL = "rollback-on-purpose";
			await expect(
				db.$transaction(async (tx) => {
					await allocateNextStoryNumber(tx, project.id);
					throw new Error(ROLLBACK_SENTINEL);
				}),
			).rejects.toThrow(ROLLBACK_SENTINEL);

			const refreshed = await db.project.findUnique({
				where: { id: project.id },
				select: { nextStoryNumber: true },
			});
			expect(refreshed?.nextStoryNumber).toBe(7);
		});

		it("throws a descriptive error when the project does not exist", async () => {
			await expect(
				db.$transaction((tx) =>
					allocateNextStoryNumber(tx, "nonexistent-project-id"),
				),
			).rejects.toThrow(/nonexistent-project-id/);
			await expect(
				db.$transaction((tx) =>
					allocateNextStoryNumber(tx, "nonexistent-project-id"),
				),
			).rejects.toThrow(/not found/i);
		});

		it("produces 50 unique sequential identifiers under 50 concurrent createStory calls (AC6)", async () => {
			const project = await seedProject({ nextStoryNumber: 1 });

			const results = await Promise.all(
				Array.from({ length: 50 }, (_, idx) =>
					createStory({
						projectId: project.id,
						title: `Concurrent story ${idx}`,
						createdById: USER_ID,
						source: "MANUAL",
					}),
				),
			);

			const identifiers = results.map((s) => s.identifier);

			// AC1: all distinct.
			expect(new Set(identifiers).size).toBe(50);

			// AC6: strictly increasing with no gaps starting from 1.
			const numbers = identifiers
				.map((x) => Number.parseInt(x, 10))
				.sort((a, b) => a - b);
			for (let i = 0; i < numbers.length; i++) {
				expect(numbers[i]).toBe(i + 1);
			}

			// The counter now points one past the last allocated value.
			const refreshed = await db.project.findUnique({
				where: { id: project.id },
				select: { nextStoryNumber: true },
			});
			expect(refreshed?.nextStoryNumber).toBe(51);
		});
	},
);
