/**
 * Unit tests for the generalized `createPmSyncConflictNotifications`
 * (`@repo/database`).
 *
 * Mocks the Prisma client (`../prisma/client`) — no real DB. Mirrors the
 * `pm-sync-resolve.test.ts` convention.
 *
 * Covers:
 * - Fires for EPIC / FEATURE / STORY.
 * - CONTENT_DRIFT collapses to ONE project-level dedupe key
 *   (`pmContentDrift:${projectId}`) + project link, so a bulk external edit
 *   coalesces into a single bell row instead of one-per-item.
 * - State conflicts keep the per-entity key (`pmConflict:${entityType}:${entityId}:${id}`).
 * - `storyId` left null for EPIC/FEATURE; set for STORY (RBAC pointer).
 * - CONTENT_DRIFT snippet is content-worded (NOT the sentinel "CONTENT → CONTENT").
 * - Back-compat: the legacy STORY caller (storyId/storyTitle, prev→new) still works.
 *
 * Run with: pnpm --filter @repo/database test __tests__/pm-conflict-notifications.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { notificationCreate } = vi.hoisted(() => ({
	notificationCreate: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: {
		notification: { create: notificationCreate },
		// Write-time preference filter reads this; empty rows ⇒ all recipients
		// enabled (default-on), preserving the original fan-out expectations.
		notificationPreference: { findMany: () => Promise.resolve([]) },
	},
}));

import { createPmSyncConflictNotifications } from "../prisma/queries/pm-conflict-notifications";

const BASE = {
	projectId: "proj_1",
	organizationId: null,
	actorUserId: null,
	pendingStateChangeId: "psc_1",
	recipientUserIds: ["user_a", "user_b"],
	link: "projects/proj_1/review",
};

function lastCreateData() {
	return notificationCreate.mock.calls.at(-1)?.[0]?.data;
}

beforeEach(() => {
	notificationCreate.mockReset();
	notificationCreate.mockResolvedValue({});
});

describe("createPmSyncConflictNotifications — content drift (collapsed)", () => {
	it("uses a project-level, count-less title + snippet (not per-entity, not CONTENT → CONTENT)", async () => {
		await createPmSyncConflictNotifications({
			...BASE,
			entityType: "FEATURE",
			entityId: "feature_1",
			entityTitle: "Login flow",
			proposedAction: "CONTENT_DRIFT",
			pmToolLabel: "Azure DevOps",
			previousState: "CONTENT",
			newState: "CONTENT",
		});

		expect(notificationCreate).toHaveBeenCalledTimes(2); // one write per recipient
		const data = lastCreateData();
		// Collapsed: the title no longer names the individual entity.
		expect(data.title).toBe("Content changes to review in Azure DevOps");
		expect(data.snippet).toContain("edited in Azure DevOps");
		expect(data.title).not.toContain("Login flow");
		// The broken sentinel rendering must never appear.
		expect(data.snippet).not.toContain("CONTENT → CONTENT");
		expect(data.title).not.toContain("CONTENT → CONTENT");
	});

	it.each([
		["EPIC", "epic_1"],
		["FEATURE", "feature_1"],
	] as const)(
		"leaves storyId null for %s, keys per project, and links to the project",
		async (entityType, entityId) => {
			await createPmSyncConflictNotifications({
				...BASE,
				recipientUserIds: ["user_a"],
				entityType,
				entityId,
				entityTitle: "Some entity",
				proposedAction: "CONTENT_DRIFT",
			});

			const data = lastCreateData();
			// storyId left undefined/null for non-story entities.
			expect(data.storyId).toBeUndefined();
			expect(data.payload.storyId).toBeNull();
			// Per-item identity still carried in the payload for the review queue.
			expect(data.payload.entityType).toBe(entityType);
			expect(data.payload.entityId).toBe(entityId);
			expect(data.payload.reason).toBe("ado-content-drift");
			// Collapsed: project-level link + project-level dedupe key.
			expect(data.link).toBe("projects/proj_1");
			expect(data.dedupeKey).toBe("pmContentDrift:proj_1");
		},
	);

	it("sets storyId for STORY content drift (RBAC pointer) but still keys per project", async () => {
		await createPmSyncConflictNotifications({
			...BASE,
			recipientUserIds: ["user_a"],
			entityType: "STORY",
			entityId: "story_1",
			entityTitle: "Story title",
			proposedAction: "CONTENT_DRIFT",
		});

		const data = lastCreateData();
		expect(data.storyId).toBe("story_1");
		expect(data.dedupeKey).toBe("pmContentDrift:proj_1");
	});

	it("collapses drift across different entities in the same project to ONE dedupe key", async () => {
		await createPmSyncConflictNotifications({
			...BASE,
			recipientUserIds: ["user_a"],
			entityType: "EPIC",
			entityId: "epic_x",
			entityTitle: "E",
			proposedAction: "CONTENT_DRIFT",
		});
		const epicKey = lastCreateData().dedupeKey;

		await createPmSyncConflictNotifications({
			...BASE,
			recipientUserIds: ["user_a"],
			entityType: "FEATURE",
			entityId: "feature_y",
			entityTitle: "F",
			proposedAction: "CONTENT_DRIFT",
		});
		const featureKey = lastCreateData().dedupeKey;

		// Same project → identical key → the DB live-unread unique index coalesces
		// them into a single bell row. This is the anti-spam contract: a bulk
		// external edit produces one "content changes to review" ping, not N.
		expect(epicKey).toBe(featureKey);
		expect(epicKey).toBe("pmContentDrift:proj_1");
	});
});

describe("createPmSyncConflictNotifications — back-compat (terminal drift)", () => {
	it("defaults to STORY and keeps the prev → new snippet shape", async () => {
		await createPmSyncConflictNotifications({
			...BASE,
			recipientUserIds: ["user_a"],
			storyId: "story_9",
			storyTitle: "Legacy story",
			previousState: "Active",
			newState: "Closed",
		});

		const data = lastCreateData();
		expect(data.title).toBe('Conflict detected on "Legacy story"');
		expect(data.snippet).toBe("Active → Closed");
		expect(data.storyId).toBe("story_9");
		expect(data.dedupeKey).toBe("pmConflict:STORY:story_9:psc_1");
		expect(data.payload.entityType).toBe("STORY");
		expect(data.payload.entityId).toBe("story_9");
	});

	it("self-skips the actor and dedups recipients", async () => {
		await createPmSyncConflictNotifications({
			...BASE,
			actorUserId: "user_a",
			recipientUserIds: ["user_a", "user_b", "user_b"],
			storyId: "story_9",
			storyTitle: "S",
			previousState: "Active",
			newState: "Closed",
		});

		// user_a (actor) skipped, user_b deduped → exactly one write.
		expect(notificationCreate).toHaveBeenCalledTimes(1);
		expect(lastCreateData().userId).toBe("user_b");
	});

	it("swallows P2002 (dedupe collision) and never throws", async () => {
		notificationCreate.mockRejectedValueOnce({ code: "P2002" });

		await expect(
			createPmSyncConflictNotifications({
				...BASE,
				recipientUserIds: ["user_a"],
				storyId: "story_9",
				storyTitle: "S",
				previousState: "Active",
				newState: "Closed",
			}),
		).resolves.toBeUndefined();
	});
});
