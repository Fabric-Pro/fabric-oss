/**
 * Coverage for the Fizzy 1869 approval-gate freeze in `createOrGetNewsletterSend`
 * (packages/database/prisma/queries/projects/newsletter.ts):
 *
 *   1. `requireApproval` + `chatChannels` are frozen onto the `NewsletterSend`
 *      row at creation (never re-read from live settings on retry/read-back).
 *   2. The catch-block read-back's `findFirst` is widened to
 *      `status: { in: ["PENDING", "PENDING_APPROVAL", "APPROVED"] }` so a
 *      unique-violation (the `(projectId) WHERE status IN (...)` partial
 *      index) returns a held/in-flight draft instead of masking it with the
 *      original create error.
 *   3. The stale-orphan `deleteMany` reclaim above it stays `status: "PENDING"`
 *      only — a held `PENDING_APPROVAL`/`APPROVED` draft is NOT an orphan and
 *      must never be reclaimed, however old it is.
 *
 * `buildCreateSendData` (the pure extraction of the `create({ data })`
 * payload) is unit-tested directly — those assertions always run, no DB
 * required. The `createOrGetNewsletterSend` behavior itself needs a live
 * Postgres (real unique-violation + partial-index semantics can't be
 * faithfully mocked), so that suite self-skips when DATABASE_URL is unset or
 * is the CI placeholder (`hasReachableDatabaseUrl`), mirroring the sibling
 * integration suites in this directory.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { hasReachableDatabaseUrl } from "../../../../__tests__/_helpers/db-availability";
import { db, Prisma } from "../../../client";
import {
	buildCreateSendData,
	type CreateNewsletterSendInput,
	createOrGetNewsletterSend,
} from "../newsletter";

describe("buildCreateSendData", () => {
	const baseInput: CreateNewsletterSendInput = {
		projectId: "p1",
		organizationId: null,
		userId: null,
		dedupeKey: "manual:p1:2026-07-09T00:00:00.000Z",
		trigger: "MANUAL",
		timeWindowStart: new Date(0),
		timeWindowEnd: new Date(1),
		triggeredByUserId: "u1",
		detailLevel: "STANDARD",
	};

	it("defaults requireApproval to false and chatChannels to [] when omitted", () => {
		expect(buildCreateSendData(baseInput)).toMatchObject({
			requireApproval: false,
			chatChannels: [],
		});
	});

	it("freezes an explicit requireApproval + chatChannels through unchanged", () => {
		const chatChannels = [
			{ platform: "SLACK" as const, teamId: "T", channelId: "C" },
		];
		expect(
			buildCreateSendData({
				...baseInput,
				requireApproval: true,
				chatChannels,
			}),
		).toMatchObject({
			requireApproval: true,
			chatChannels,
		});
	});

	it("always creates with status PENDING and defaults deliveryDestination to EMAIL", () => {
		expect(buildCreateSendData(baseInput)).toMatchObject({
			status: "PENDING",
			deliveryDestination: "EMAIL",
		});
	});
});

describe.skipIf(!hasReachableDatabaseUrl())(
	"createOrGetNewsletterSend — approval-gate freeze + widened read-back (real Postgres)",
	() => {
		const RUN_ID = `${Date.now()}-${process.pid}`;
		const USER_ID = `test-newsletter-send-user-${RUN_ID}`;
		let projectCounter = 0;
		let dedupeCounter = 0;

		beforeAll(async () => {
			const now = new Date();
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "user" (id, name, email, "emailVerified", "onboardingComplete", "createdAt", "updatedAt")
				VALUES (${USER_ID}, ${"Newsletter Send User"}, ${`${USER_ID}@test.com`}, true, false, ${now}, ${now})
				ON CONFLICT (id) DO NOTHING
			`);
		});

		afterEach(async () => {
			// Deleting the project cascades its newsletter sends (onDelete: Cascade).
			await db.project.deleteMany({ where: { userId: USER_ID } });
		});

		async function seedProject() {
			projectCounter += 1;
			return db.project.create({
				data: {
					name: `Newsletter Send Project ${projectCounter}`,
					userId: USER_ID,
				},
			});
		}

		function nextDedupeKey(prefix: string) {
			dedupeCounter += 1;
			return `${prefix}:${RUN_ID}:${dedupeCounter}`;
		}

		const baseInput = (projectId: string) =>
			({
				projectId,
				organizationId: null,
				userId: null,
				trigger: "MANUAL",
				timeWindowStart: new Date(0),
				timeWindowEnd: new Date(1),
				triggeredByUserId: USER_ID,
				detailLevel: "STANDARD",
			}) satisfies Omit<CreateNewsletterSendInput, "dedupeKey">;

		it("freezes requireApproval + chatChannels onto the created send row", async () => {
			const project = await seedProject();
			const chatChannels = [
				{ platform: "SLACK" as const, teamId: "T", channelId: "C" },
			];

			const result = await createOrGetNewsletterSend({
				...baseInput(project.id),
				dedupeKey: nextDedupeKey("manual"),
				requireApproval: true,
				chatChannels,
			});

			expect(result.created).toBe(true);
			expect(result.send.requireApproval).toBe(true);
			expect(result.send.chatChannels).toEqual(chatChannels);

			// Persisted, not just returned in-memory.
			const persisted = await db.newsletterSend.findUniqueOrThrow({
				where: { id: result.send.id },
				select: { requireApproval: true, chatChannels: true },
			});
			expect(persisted.requireApproval).toBe(true);
			expect(persisted.chatChannels).toEqual(chatChannels);
		});

		it("widened read-back returns a held PENDING_APPROVAL draft instead of duplicating it", async () => {
			const project = await seedProject();
			// Seed a held draft directly (bypassing the function under test) so it
			// occupies the (projectId) WHERE status IN (...) partial-index slot.
			const held = await db.newsletterSend.create({
				data: {
					...buildCreateSendData({
						...baseInput(project.id),
						dedupeKey: nextDedupeKey("manual"),
					}),
					status: "PENDING_APPROVAL",
				},
			});

			const result = await createOrGetNewsletterSend({
				...baseInput(project.id),
				dedupeKey: nextDedupeKey("manual"), // different key: findUnique(dedupeKey) misses
			});

			// The partial index blocked the new row; the widened findFirst must
			// surface the held draft rather than rethrowing the create error.
			expect(result.created).toBe(false);
			expect(result.send.id).toBe(held.id);
			expect(result.send.status).toBe("PENDING_APPROVAL");
		});

		it("does not reclaim a stale PENDING_APPROVAL row — the orphan reclaim stays PENDING-only", async () => {
			const project = await seedProject();
			const STALE_MS = 40 * 60 * 1000; // well past the 30m reclaim threshold
			const held = await db.newsletterSend.create({
				data: {
					...buildCreateSendData({
						...baseInput(project.id),
						dedupeKey: nextDedupeKey("manual"),
					}),
					status: "PENDING_APPROVAL",
					createdAt: new Date(Date.now() - STALE_MS),
				},
			});

			const result = await createOrGetNewsletterSend({
				...baseInput(project.id),
				dedupeKey: nextDedupeKey("manual"),
			});

			// Not reclaimed: still present, and read back as the held draft rather
			// than a freshly created row.
			const stillThere = await db.newsletterSend.findUnique({
				where: { id: held.id },
			});
			expect(stillThere).not.toBeNull();
			expect(result.created).toBe(false);
			expect(result.send.id).toBe(held.id);
		});
	},
);
