/**
 * Enum round-trip coverage for the two new `Notification` categories /
 * types added by the unified-context-uploader-wizard spec (Group 1):
 *
 *   - NotificationCategory.CONTEXT_INDEXING_STARTED
 *   - NotificationCategory.CONTEXT_INDEXING_COMPLETED
 *   - NotificationType.CONTEXT_INDEXING_STARTED
 *   - NotificationType.CONTEXT_INDEXING_COMPLETED
 *
 * Spec ref: fabric/specs/2026-05-23-unified-context-uploader-wizard/spec.md
 *   §4.1 (the additive enum migration) and §13.1 (DB-layer testing).
 *
 * Skips automatically when DATABASE_URL is unset (or the CI placeholder),
 * matching the pattern used by `document-assistant-conversation.test.ts`.
 * Locally, run with the dev DB up:
 *   pnpm --filter @repo/database test __tests__/notification-context-indexing-categories.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, Prisma } from "../prisma/client";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

// Unique per-process suffix so parallel test files do not collide on the
// shared dev Postgres.
const RUN_ID = `${Date.now()}-${process.pid}`;
const USER_ID = `test-ctx-idx-notif-user-${RUN_ID}`;

// Cases we want to round-trip. The wizard spec emits both values on both
// enums; the migration adds them as a matched pair so the in-app
// notification renderer can branch on `category` alone (see §8.1 + §8.2).
const CASES = [
	{
		type: "CONTEXT_INDEXING_STARTED" as const,
		category: "CONTEXT_INDEXING_STARTED" as const,
		dedupeKey: `context-indexing-started:test-${RUN_ID}`,
		title: "Indexing https://example.com",
		snippet: "About 30 seconds — we'll notify you when it's ready.",
	},
	{
		type: "CONTEXT_INDEXING_COMPLETED" as const,
		category: "CONTEXT_INDEXING_COMPLETED" as const,
		dedupeKey: `context-indexing-completed:test-${RUN_ID}`,
		title: "Indexed https://example.com",
		snippet: "5 pages ready for AI",
	},
];

describe.skipIf(!hasReachableDatabaseUrl())(
	"Notification — CONTEXT_INDEXING_* enum round-trip",
	() => {
		beforeAll(async () => {
			const now = new Date();
			// Seed a throwaway user so the Notification FK is satisfied.
			// `ON CONFLICT DO NOTHING` keeps reruns idempotent.
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "user" (id, name, email, "emailVerified", "onboardingComplete", "createdAt", "updatedAt")
				VALUES (${USER_ID}, ${USER_ID}, ${`${USER_ID}@test.com`}, true, false, ${now}, ${now})
				ON CONFLICT (id) DO NOTHING
			`);
		});

		afterAll(async () => {
			// Cleanup notifications first (FK depends on the user row).
			await db.notification.deleteMany({ where: { userId: USER_ID } });
			await db.user.deleteMany({ where: { id: USER_ID } });
		});

		it.each(CASES)(
			"insert + read + delete a Notification with $type / $category",
			async ({ type, category, dedupeKey, title, snippet }) => {
				// Insert: Prisma will reject at the generated-client layer if
				// either enum value is missing from the regenerated client,
				// and Postgres will reject if the migration has not extended
				// the underlying enum types.
				const created = await db.notification.create({
					data: {
						userId: USER_ID,
						organizationId: null,
						type,
						category,
						title,
						snippet,
						link: "/app/projects/test/contexts",
						payload: {
							contextId: `ctx-test-${RUN_ID}`,
							sourceUrl: "https://example.com",
							scope: "SINGLE_PAGE",
						},
						dedupeKey,
					},
				});

				expect(created.id).toBeTruthy();
				expect(created.type).toBe(type);
				expect(created.category).toBe(category);

				// Read: confirm round-trip via Prisma returns the same enum
				// values verbatim (no string coercion / casing surprise).
				const fetched = await db.notification.findUnique({
					where: { id: created.id },
				});
				expect(fetched).not.toBeNull();
				expect(fetched?.type).toBe(type);
				expect(fetched?.category).toBe(category);
				expect(fetched?.title).toBe(title);

				// Delete: clean up before the next iteration so dedupe-key
				// uniqueness on (userId, dedupeKey) does not interfere.
				await db.notification.delete({ where: { id: created.id } });

				const afterDelete = await db.notification.findUnique({
					where: { id: created.id },
				});
				expect(afterDelete).toBeNull();
			},
		);
	},
);
