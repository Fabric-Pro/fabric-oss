/**
 * Integration test — end-to-end notification-emission for a URL crawl.
 *
 * Mirrors the production wiring from `processLink` (API package) through the
 * `urlSourceCrawlWorkflow`'s finalize activity (`updateParentStatusActivity`,
 * temporal package). Mocks the Temporal client + DB write layer so we can
 * assert ON CALLS rather than spinning up Temporalite. Repo convention — see
 * `cancellation.test.ts` header for the same rationale (Group 4 audit).
 *
 * Assertions (per spec §13.2 + §13.3 + tasks.md 6.7):
 *   (i)   CONTEXT_INDEXING_STARTED row inserted post-`workflow.start`.
 *   (ii)  CONTEXT_INDEXING_COMPLETED row inserted post-finalize on COMPLETED.
 *   (iii) CANCELLED finalize path inserts NO completed row (§6.4 silent).
 *
 * What we don't simulate (out of scope for this test):
 *   - Real Firecrawl HTTP calls (mocked at the activity level).
 *   - Real Temporal scheduling / replay (the workflow body is exercised via
 *     a small async helper that calls the same `updateParentStatusActivity`
 *     entry point the workflow calls in production).
 *
 * Spec ref: `2026-05-23-unified-context-uploader-wizard/spec.md` §8.2, §6.4,
 * §8.5.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// Bare vi.fn() mocks for the db surface — both the started-side
// (in `process-context-link.ts` mirrored locally) and the completed-side
// (via `update-parent-status-activity.ts` → `emit-completion-notification.ts`)
// write through `db.notification.create`. We assert directly on
// `mockNotificationCreate.mock.calls` rather than a shared mutable dbState
// — closure-captured state proved fragile across Vitest pool modes in CI
// (see prior PR #1169 attempt). Mock-call introspection is the supported
// path.
vi.mock("@repo/database/prisma/client", () => ({
	db: {
		projectContext: {
			update: vi.fn().mockResolvedValue({}),
		},
		notification: {
			create: vi
				.fn()
				.mockImplementation(async () => ({ id: "notif-stub" })),
			updateMany: vi.fn().mockResolvedValue({ count: 1 }),
		},
		organization: {
			findUnique: vi.fn().mockResolvedValue({ slug: "acme" }),
		},
	},
}));

vi.mock("../../../src/activities/lib/activity-logger", () => ({
	activityLogger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

import { db } from "@repo/database/prisma/client";
import { updateParentStatusActivity } from "../../src/activities/url-source/update-parent-status-activity";

// Typed mock handles for direct assertions. `db.notification.create` is the
// single channel both the started-side helper AND the completed-side helper
// write through, so its `mock.calls` is the source of truth for "what got
// inserted in what order".
const mockNotificationCreate = db.notification.create as ReturnType<
	typeof vi.fn
>;

interface NotificationInsert {
	dedupeKey: string;
	type: string;
	title: string;
	snippet?: string | null;
	userId: string;
	organizationId: string | null;
	payload?: unknown;
}

function getInsertedNotifications(): NotificationInsert[] {
	return mockNotificationCreate.mock.calls.map((call) => {
		const data = (call[0] as { data: Record<string, unknown> }).data;
		return {
			dedupeKey: String(data.dedupeKey ?? ""),
			type: String(data.type ?? ""),
			title: String(data.title ?? ""),
			snippet: (data.snippet as string | null | undefined) ?? null,
			userId: String(data.userId ?? ""),
			organizationId: (data.organizationId as string | null) ?? null,
			payload: data.payload,
		};
	});
}

beforeEach(() => {
	mockNotificationCreate.mockClear();
});

/**
 * Mock for the started-side insert. Mirrors what `process-context-link.ts`
 * writes via `createNotification` immediately after `workflow.start` resolves.
 * Production lives in `packages/api/modules/projects/procedures/contexts/process-context-link.ts`
 * lines 421-450 (the nested try/catch); kept here as a hand-rolled mirror so
 * the test stays free of an @repo/api dep.
 */
async function emitStartedNotification(args: {
	contextId: string;
	projectId: string;
	userId: string;
	organizationId: string | null;
	sourceUrl: string;
	scope: "SINGLE_PAGE" | "PATH_PREFIX";
	maxPages: number;
}): Promise<void> {
	const { db } = (await import(
		"@repo/database/prisma/client"
	)) as unknown as {
		db: { notification: { create: (args: unknown) => Promise<unknown> } };
	};
	await db.notification.create({
		data: {
			userId: args.userId,
			organizationId: args.organizationId,
			type: "CONTEXT_INDEXING_STARTED",
			category: "CONTEXT_INDEXING_STARTED",
			title: `Indexing ${args.sourceUrl}`,
			snippet:
				args.scope === "SINGLE_PAGE"
					? "About 30 seconds — we'll notify you when it's ready."
					: `Estimated ${Math.max(1, Math.round((args.maxPages * 5 + 30) / 60))} min — we'll notify you when it's ready.`,
			link: args.organizationId
				? `/app/acme/projects/${args.projectId}/context`
				: `/app/projects/${args.projectId}/context`,
			projectId: args.projectId,
			payload: {
				contextId: args.contextId,
				sourceUrl: args.sourceUrl,
				scope: args.scope,
			},
			dedupeKey: `context-indexing-started:${args.contextId}`,
		},
	});
}

describe("notification emission — end-to-end (started + completed)", () => {
	it("(i) inserts CONTEXT_INDEXING_STARTED row when processLink starts a crawl", async () => {
		// Mirror of process-context-link.ts: after the workflow starts, the
		// procedure emits the started-notification.
		await emitStartedNotification({
			contextId: "ctx-1",
			projectId: "proj-1",
			userId: "user-1",
			organizationId: null,
			sourceUrl: "https://example.com/docs",
			scope: "PATH_PREFIX",
			maxPages: 5,
		});

		const inserts = getInsertedNotifications();
		expect(inserts).toHaveLength(1);
		const started = inserts[0];
		expect(started.type).toBe("CONTEXT_INDEXING_STARTED");
		expect(started.dedupeKey).toBe("context-indexing-started:ctx-1");
		// 5 pages × 5s + 30s = 55s → rounds to 1 min.
		expect(started.snippet).toBe(
			"Estimated 1 min — we'll notify you when it's ready.",
		);
	});

	it("(ii) inserts CONTEXT_INDEXING_COMPLETED row when the activity finalizes COMPLETED", async () => {
		// Simulated end-to-end: started → COMPLETED.
		await emitStartedNotification({
			contextId: "ctx-2",
			projectId: "proj-1",
			userId: "user-1",
			organizationId: null,
			sourceUrl: "https://example.com/docs",
			scope: "PATH_PREFIX",
			maxPages: 5,
		});

		// Workflow's finalize activity call mirrors the COMPLETED branch in
		// `url-source-crawl.ts` (PATH_PREFIX section line 1062).
		await updateParentStatusActivity({
			contextId: "ctx-2",
			extractionStatus: "COMPLETED",
			urlLastSyncedAt: new Date("2026-05-23T12:00:00Z"),
			urlNextRefreshAt: null,
			projectId: "proj-1",
			userId: "user-1",
			organizationId: null,
			sourceUrl: "https://example.com/docs",
			pagesIndexed: 5,
		});

		const inserts = getInsertedNotifications();
		expect(inserts).toHaveLength(2);
		const completed = inserts.find(
			(n) => n.type === "CONTEXT_INDEXING_COMPLETED",
		);
		expect(completed).toBeDefined();
		expect(completed?.dedupeKey).toBe("context-indexing-completed:ctx-2");
		expect(completed?.title).toBe("Indexed example.com/docs");
		expect(completed?.snippet).toBe("5 pages ready for AI");
		// Started + completed use DIFFERENT prefixes so they coexist.
		expect(inserts.map((n) => n.dedupeKey)).toEqual([
			"context-indexing-started:ctx-2",
			"context-indexing-completed:ctx-2",
		]);
	});

	it("(iii) inserts NO completed row when the activity finalizes CANCELLED (silent §6.4)", async () => {
		// Started → CANCELLED (user clicked cancel mid-crawl with no progress).
		await emitStartedNotification({
			contextId: "ctx-3",
			projectId: "proj-1",
			userId: "user-1",
			organizationId: null,
			sourceUrl: "https://example.com/docs",
			scope: "PATH_PREFIX",
			maxPages: 5,
		});

		// Workflow's cancel-no-progress branch finalizes with CANCELLED.
		await updateParentStatusActivity({
			contextId: "ctx-3",
			extractionStatus: "CANCELLED",
			urlLastSyncedAt: null,
			urlNextRefreshAt: null,
			projectId: "proj-1",
			userId: "user-1",
			organizationId: null,
			sourceUrl: "https://example.com/docs",
		});

		// Only the started-row exists; CANCELLED is silent.
		const inserts = getInsertedNotifications();
		expect(inserts).toHaveLength(1);
		expect(inserts[0].type).toBe("CONTEXT_INDEXING_STARTED");
		expect(
			inserts.some((n) => n.type === "CONTEXT_INDEXING_COMPLETED"),
		).toBe(false);
	});

	it("inserts FAILED-variant of completed row when finalize is FAILED", async () => {
		// The negative-case sibling of (ii) — confirms the spec's §8.2
		// "Failed to index" title + extractionError snippet path runs from
		// the activity-level integration too.
		await emitStartedNotification({
			contextId: "ctx-4",
			projectId: "proj-1",
			userId: "user-1",
			organizationId: "org-1",
			sourceUrl: "https://example.com/docs",
			scope: "PATH_PREFIX",
			maxPages: 5,
		});

		await updateParentStatusActivity({
			contextId: "ctx-4",
			extractionStatus: "FAILED",
			extractionError: "Firecrawl returned 403",
			urlLastSyncedAt: null,
			urlNextRefreshAt: null,
			projectId: "proj-1",
			userId: "user-1",
			organizationId: "org-1",
			sourceUrl: "https://example.com/docs",
		});

		const completed = getInsertedNotifications().find(
			(n) => n.type === "CONTEXT_INDEXING_COMPLETED",
		);
		expect(completed?.title).toBe("Failed to index example.com/docs");
		expect(completed?.snippet).toBe("Firecrawl returned 403");
	});
});
