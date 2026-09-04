/**
 * `fabric_create_bug` + `fabric_list_features` kind-exposure tests.
 *
 * Covers the two dedup layers the tool promises an autonomous monitoring agent
 * (fingerprint, then normalized title), the unique-index race backstop, and the
 * work-item-type filter/field on the list tool.
 *
 * `@repo/database` and `@repo/temporal` are fully mocked — the handlers import
 * them dynamically, so the mock intercepts the `await import(...)` inside the
 * handler body.
 *
 * Run with: pnpm --filter web test modules/saas/mcp/lib/gateway/__tests__/create-bug-tool
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	hasProjectAccess: vi.fn(),
	canCreateProjectStory: vi.fn(),
	findFirst: vi.fn(),
	isOrganizationMember: vi.fn(),
	updateMany: vi.fn(),
	storyFindUnique: vi.fn(),
	projectFindUnique: vi.fn(),
	findCollision: vi.fn(),
	buildBacklogDedupGuard: vi.fn(),
	listStories: vi.fn(),
	createStoryFromProposal: vi.fn(),
	dispatchLifecycleEvent: vi.fn(),
	recordAuditFromRequest: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		userStory: {
			findFirst: mocks.findFirst,
			findUnique: mocks.storyFindUnique,
			updateMany: mocks.updateMany,
		},
		project: { findUnique: mocks.projectFindUnique },
	},
	isOrganizationMember: mocks.isOrganizationMember,
	hasProjectAccess: mocks.hasProjectAccess,
	canCreateProjectStory: mocks.canCreateProjectStory,
	buildBacklogDedupGuard: mocks.buildBacklogDedupGuard,
	listStories: mocks.listStories,
	TERMINAL_DRAFTING_STAGES: ["DECLINED", "CLOSED"],
}));

/**
 * Prisma's shape for a unique-constraint violation. `meta.target` is what tells
 * a fingerprint collision apart from any other P2002 on the same INSERT.
 */
function uniqueViolation(target: string | string[]) {
	return Object.assign(new Error("Unique constraint failed"), {
		code: "P2002",
		meta: { target },
	});
}

vi.mock("@repo/temporal", () => ({
	createStoryFromProposal: mocks.createStoryFromProposal,
	dispatchLifecycleEvent: mocks.dispatchLifecycleEvent,
}));

vi.mock("@repo/api/lib/audit", () => ({
	recordAuditFromRequest: mocks.recordAuditFromRequest,
}));

/**
 * The lifecycle dispatch and the audit write are fire-and-forget, and the audit
 * one sits behind a dynamic `import(...)`, so a test asserting on either has to
 * let the microtask queue drain first.
 */
async function flushSideEffects() {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

import {
	executePlatformTool,
	PLATFORM_TOOL_DEFINITIONS,
} from "../platform-tools";
import type { GatewaySession } from "../types";

const session: GatewaySession = {
	sessionId: "sess-1",
	userId: "user-1",
	organizationId: "org-1",
	userName: "Example Agent",
	email: "agent@example.com",
	role: "user",
	credential: "personal-key",
	scopes: ["*"],
	createdAt: new Date("2026-01-01T00:00:00Z"),
	expiresAt: new Date("2026-01-02T00:00:00Z"),
};

/** Parse the JSON payload a platform tool packs into its text content block. */
function payload(result: { content: Array<{ text: string }> }) {
	return JSON.parse(result.content[0].text);
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.hasProjectAccess.mockResolvedValue(true);
	mocks.canCreateProjectStory.mockResolvedValue(true);
	mocks.findFirst.mockResolvedValue(null);
	mocks.updateMany.mockResolvedValue({ count: 1 });
	// The caller IS a member of the project's organization — their ACTIVE
	// context is simply a different one. That is the case the refusal below
	// exists to name, so it is the default; a test wanting the guest case (access
	// to the project, none to its organization) overrides it.
	mocks.isOrganizationMember.mockResolvedValue(true);
	mocks.dispatchLifecycleEvent.mockResolvedValue(undefined);
	// The title-matched row is still open unless a test says otherwise.
	mocks.storyFindUnique.mockResolvedValue({
		id: "story-title-dupe",
		draftingStage: "DRAFT",
	});
	// Project's owning tenant matches the session's active org by default.
	mocks.projectFindUnique.mockResolvedValue({
		id: "proj-1",
		organizationId: "org-1",
	});
	mocks.findCollision.mockReturnValue(null);
	mocks.buildBacklogDedupGuard.mockResolvedValue({
		findCollision: mocks.findCollision,
		recordCreated: vi.fn(),
	});
	mocks.createStoryFromProposal.mockResolvedValue({
		story: {
			id: "story-new",
			identifier: "42",
			title: "Checkout returns 500 when cart is empty",
			kind: "BUG",
			priority: "P1_HIGH",
			draftingStage: "DRAFT",
			statusId: "st1",
		},
		aiDrafted: true,
	});
});

describe("fabric_create_bug — declaration", () => {
	const definition = PLATFORM_TOOL_DEFINITIONS.find(
		(t) => t.name === "fabric_create_bug",
	);

	it("is registered as a platform tool", () => {
		expect(definition).toBeDefined();
		expect(definition?._gateway_source).toBe("platform");
	});

	it("requires projectId + title and accepts description/fingerprint/priority", () => {
		const schema = definition?.inputSchema as {
			properties: Record<string, { enum?: string[] }>;
			required: string[];
		};
		expect(schema.required).toEqual(["projectId", "title"]);
		expect(Object.keys(schema.properties).sort()).toEqual([
			"description",
			"fingerprint",
			"priority",
			"projectId",
			"title",
		]);
		expect(schema.properties.priority.enum).toEqual([
			"P0_CRITICAL",
			"P1_HIGH",
			"P2_MEDIUM",
			"P3_LOW",
		]);
	});

	it("is NOT annotated read-only (it writes a work item)", () => {
		expect(definition?.annotations?.readOnlyHint).toBeUndefined();
	});
});

describe("fabric_create_bug — dedup", () => {
	it("returns the existing bug when the fingerprint already matches an open row", async () => {
		mocks.findFirst.mockResolvedValue({
			id: "story-existing",
			identifier: "17",
			title: "Checkout 500s on empty cart",
		});

		const result = await executePlatformTool(
			"fabric_create_bug",
			{
				projectId: "proj-1",
				title: "Checkout returns 500 when cart is empty",
				fingerprint: "sha256:abc123",
			},
			session,
		);

		const body = payload(result);
		expect(result.isError).toBeUndefined();
		expect(body).toMatchObject({
			success: true,
			created: false,
			dedupedBy: "fingerprint",
			id: "story-existing",
			identifier: "17",
		});
		expect(mocks.createStoryFromProposal).not.toHaveBeenCalled();
		// Scoped to the same predicate as the partial unique index: terminal
		// rows must not block a re-filing.
		expect(mocks.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					projectId: "proj-1",
					bugFingerprint: "sha256:abc123",
					draftingStage: { notIn: ["DECLINED", "CLOSED"] },
				},
			}),
		);
	});

	it("skips the fingerprint lookup entirely when no fingerprint is supplied", async () => {
		await executePlatformTool(
			"fabric_create_bug",
			{ projectId: "proj-1", title: "Some failure" },
			session,
		);
		expect(mocks.findFirst).not.toHaveBeenCalled();
	});

	it("returns the existing bug on a normalized-title collision", async () => {
		mocks.findCollision.mockReturnValue({
			existingId: "story-title-dupe",
			existingIdentifier: "9",
		});

		const body = payload(
			await executePlatformTool(
				"fabric_create_bug",
				{
					projectId: "proj-1",
					title: "Checkout returns 500 when cart is empty",
				},
				session,
			),
		);

		expect(body).toMatchObject({
			success: true,
			created: false,
			dedupedBy: "title",
			id: "story-title-dupe",
			identifier: "9",
			fingerprintAttached: false,
		});
		expect(mocks.findCollision).toHaveBeenCalledWith(
			"BUG",
			"Checkout returns 500 when cart is empty",
		);
		expect(mocks.createStoryFromProposal).not.toHaveBeenCalled();
		// Nothing to back-fill when the caller sent no fingerprint.
		expect(mocks.updateMany).not.toHaveBeenCalled();
	});

	it("back-fills the caller's fingerprint onto a title-matched bug that has none", async () => {
		mocks.findCollision.mockReturnValue({
			existingId: "story-title-dupe",
			existingIdentifier: "9",
		});

		const body = payload(
			await executePlatformTool(
				"fabric_create_bug",
				{
					projectId: "proj-1",
					title: "Checkout returns 500 when cart is empty",
					fingerprint: "sha256:abc123",
				},
				session,
			),
		);

		// Compare-and-set: guarded on bugFingerprint: null so an existing
		// fingerprint is never overwritten, AND on the row still being
		// non-terminal so a bug closed since the guard snapshot is never
		// mutated.
		expect(mocks.updateMany).toHaveBeenCalledWith({
			where: {
				id: "story-title-dupe",
				bugFingerprint: null,
				draftingStage: { notIn: ["DECLINED", "CLOSED"] },
			},
			data: { bugFingerprint: "sha256:abc123" },
		});
		expect(body).toMatchObject({
			created: false,
			dedupedBy: "title",
			fingerprintAttached: true,
		});
		expect(body.message).toContain("fingerprint has been attached");
	});

	it("reports fingerprintAttached=false when the matched bug already carries one", async () => {
		mocks.findCollision.mockReturnValue({
			existingId: "story-title-dupe",
			existingIdentifier: "9",
		});
		mocks.updateMany.mockResolvedValue({ count: 0 });

		const body = payload(
			await executePlatformTool(
				"fabric_create_bug",
				{
					projectId: "proj-1",
					title: "Checkout returns 500 when cart is empty",
					fingerprint: "sha256:abc123",
				},
				session,
			),
		);

		expect(body).toMatchObject({
			dedupedBy: "title",
			fingerprintAttached: false,
		});
		expect(body.message).not.toContain("fingerprint has been attached");
	});

	it("files a new bug when the title-matched row went terminal before the back-fill", async () => {
		// The guard's index is a snapshot: the bug it matched was closed
		// between building the guard and writing. A resolved ticket is not a
		// live duplicate, so this report deserves its own row.
		mocks.findCollision.mockReturnValue({
			existingId: "story-title-dupe",
			existingIdentifier: "9",
		});
		mocks.updateMany.mockResolvedValue({ count: 0 });
		mocks.storyFindUnique.mockResolvedValue({
			id: "story-title-dupe",
			draftingStage: "CLOSED",
		});

		const body = payload(
			await executePlatformTool(
				"fabric_create_bug",
				{
					projectId: "proj-1",
					title: "Checkout returns 500 when cart is empty",
					fingerprint: "sha256:abc123",
				},
				session,
			),
		);

		expect(body).toMatchObject({ created: true, id: "story-new" });
		expect(mocks.createStoryFromProposal).toHaveBeenCalledTimes(1);
	});

	it("files a new bug when the title-matched row was deleted before the back-fill", async () => {
		mocks.findCollision.mockReturnValue({
			existingId: "story-title-dupe",
			existingIdentifier: "9",
		});
		mocks.updateMany.mockResolvedValue({ count: 0 });
		mocks.storyFindUnique.mockResolvedValue(null);

		const body = payload(
			await executePlatformTool(
				"fabric_create_bug",
				{
					projectId: "proj-1",
					title: "Checkout returns 500 when cart is empty",
					fingerprint: "sha256:abc123",
				},
				session,
			),
		);

		expect(body).toMatchObject({ created: true });
	});

	it("prefers the fingerprint holder when the back-fill hits the unique index", async () => {
		mocks.findCollision.mockReturnValue({
			existingId: "story-title-dupe",
			existingIdentifier: "9",
		});
		mocks.updateMany.mockRejectedValue(
			uniqueViolation(["projectId", "bugFingerprint"]),
		);
		mocks.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({
			id: "story-fp-holder",
			identifier: "13",
			title: "Checkout 500s on empty cart",
		});

		const body = payload(
			await executePlatformTool(
				"fabric_create_bug",
				{
					projectId: "proj-1",
					title: "Checkout returns 500 when cart is empty",
					fingerprint: "sha256:abc123",
				},
				session,
			),
		);

		expect(body).toMatchObject({
			created: false,
			dedupedBy: "fingerprint",
			id: "story-fp-holder",
			identifier: "13",
		});
		expect(mocks.createStoryFromProposal).not.toHaveBeenCalled();
	});

	it("falls back to the open title match when the fingerprint holder went terminal", async () => {
		// The back-fill lost to the index, but by the time we look the holder
		// is closed — so it is not the live duplicate either. The title match
		// is still open, so it is the answer and a stale P2002 must not
		// surface.
		mocks.findCollision.mockReturnValue({
			existingId: "story-title-dupe",
			existingIdentifier: "9",
		});
		mocks.updateMany.mockRejectedValue(
			uniqueViolation(["projectId", "bugFingerprint"]),
		);
		mocks.findFirst.mockResolvedValue(null);

		const result = await executePlatformTool(
			"fabric_create_bug",
			{
				projectId: "proj-1",
				title: "Checkout returns 500 when cart is empty",
				fingerprint: "sha256:abc123",
			},
			session,
		);

		expect(result.isError).toBeUndefined();
		expect(payload(result)).toMatchObject({
			created: false,
			dedupedBy: "title",
			id: "story-title-dupe",
			fingerprintAttached: false,
		});
		expect(mocks.createStoryFromProposal).not.toHaveBeenCalled();
	});

	it("files a new bug when BOTH the fingerprint holder and the title match went terminal", async () => {
		// The nastiest ordering: the back-fill loses to holder W, then W and
		// the title match S are both closed before we re-read. Neither covers
		// this report, so returning S would point the agent at a resolved
		// ticket — and the P2002 is meaningless by then. A losing update says
		// nothing about S's CURRENT state: the conflict comes from the index,
		// so S satisfied the non-terminal predicate at write time only.
		mocks.findCollision.mockReturnValue({
			existingId: "story-title-dupe",
			existingIdentifier: "9",
		});
		mocks.updateMany.mockRejectedValue(
			uniqueViolation(["projectId", "bugFingerprint"]),
		);
		mocks.findFirst.mockResolvedValue(null);
		mocks.storyFindUnique.mockResolvedValue({
			id: "story-title-dupe",
			draftingStage: "CLOSED",
		});

		const result = await executePlatformTool(
			"fabric_create_bug",
			{
				projectId: "proj-1",
				title: "Checkout returns 500 when cart is empty",
				fingerprint: "sha256:abc123",
			},
			session,
		);

		expect(result.isError).toBeUndefined();
		expect(payload(result)).toMatchObject({
			created: true,
			id: "story-new",
		});
		expect(mocks.createStoryFromProposal).toHaveBeenCalledTimes(1);
	});

	it("files a new bug when the title match was deleted after losing the back-fill", async () => {
		mocks.findCollision.mockReturnValue({
			existingId: "story-title-dupe",
			existingIdentifier: "9",
		});
		mocks.updateMany.mockRejectedValue(
			uniqueViolation(["projectId", "bugFingerprint"]),
		);
		mocks.findFirst.mockResolvedValue(null);
		mocks.storyFindUnique.mockResolvedValue(null);

		const body = payload(
			await executePlatformTool(
				"fabric_create_bug",
				{
					projectId: "proj-1",
					title: "Checkout returns 500 when cart is empty",
					fingerprint: "sha256:abc123",
				},
				session,
			),
		);

		expect(body).toMatchObject({ created: true });
	});

	it("reports the winner when the unique index rejects a racing insert", async () => {
		mocks.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({
			id: "story-winner",
			identifier: "21",
			title: "Checkout returns 500 when cart is empty",
		});
		mocks.createStoryFromProposal.mockRejectedValue(
			uniqueViolation("user_story_projectId_bugFingerprint_key"),
		);

		const body = payload(
			await executePlatformTool(
				"fabric_create_bug",
				{
					projectId: "proj-1",
					title: "Checkout returns 500 when cart is empty",
					fingerprint: "sha256:abc123",
				},
				session,
			),
		);

		expect(body).toMatchObject({
			success: true,
			created: false,
			dedupedBy: "fingerprint",
			id: "story-winner",
			identifier: "21",
		});
	});

	it("retries the create once when the race winner went terminal in the window", async () => {
		// Both fingerprint reads miss: the first because nothing existed yet,
		// the second because the row that won the race was closed before we
		// looked, dropping it out of the partial index.
		mocks.findFirst.mockResolvedValue(null);
		mocks.createStoryFromProposal
			.mockRejectedValueOnce(
				uniqueViolation(["projectId", "bugFingerprint"]),
			)
			.mockResolvedValueOnce({
				story: {
					id: "story-retry",
					identifier: "44",
					title: "Checkout returns 500 when cart is empty",
					kind: "BUG",
					priority: "P2_MEDIUM",
					draftingStage: "DRAFT",
				},
				aiDrafted: true,
			});

		const body = payload(
			await executePlatformTool(
				"fabric_create_bug",
				{
					projectId: "proj-1",
					title: "Checkout returns 500 when cart is empty",
					fingerprint: "sha256:abc123",
				},
				session,
			),
		);

		expect(mocks.createStoryFromProposal).toHaveBeenCalledTimes(2);
		expect(body).toMatchObject({
			created: true,
			id: "story-retry",
			identifier: "44",
		});
	});

	it("resolves to the third racer's bug when the retry itself conflicts", async () => {
		// Reads: (1) pre-create miss, (2) post-conflict miss (winner went
		// terminal) → retry, (3) the retry conflicts too, and this read finds
		// the row a third racer created. That is a dedup hit, not a fault.
		mocks.findFirst
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce({
				id: "story-third-racer",
				identifier: "77",
				title: "Checkout returns 500 when cart is empty",
			});
		mocks.createStoryFromProposal.mockRejectedValue(
			uniqueViolation(["projectId", "bugFingerprint"]),
		);

		const result = await executePlatformTool(
			"fabric_create_bug",
			{
				projectId: "proj-1",
				title: "Checkout returns 500 when cart is empty",
				fingerprint: "sha256:abc123",
			},
			session,
		);

		expect(result.isError).toBeUndefined();
		expect(payload(result)).toMatchObject({
			created: false,
			dedupedBy: "fingerprint",
			id: "story-third-racer",
			identifier: "77",
		});
		// Exactly one retry — never a loop.
		expect(mocks.createStoryFromProposal).toHaveBeenCalledTimes(2);
	});

	it("errors when the retry conflicts and no winner can be found at all", async () => {
		mocks.findFirst.mockResolvedValue(null);
		mocks.createStoryFromProposal.mockRejectedValue(
			uniqueViolation(["projectId", "bugFingerprint"]),
		);

		const result = await executePlatformTool(
			"fabric_create_bug",
			{
				projectId: "proj-1",
				title: "Checkout returns 500 when cart is empty",
				fingerprint: "sha256:abc123",
			},
			session,
		);

		expect(result.isError).toBe(true);
		expect(mocks.createStoryFromProposal).toHaveBeenCalledTimes(2);
	});

	it("does NOT treat an unrelated P2002 as a dedup hit", async () => {
		// The (projectId, identifier) allocator backstop firing is a real
		// fault; reporting it as "already filed" would hide it.
		mocks.createStoryFromProposal.mockRejectedValue(
			uniqueViolation(["projectId", "identifier"]),
		);

		const result = await executePlatformTool(
			"fabric_create_bug",
			{
				projectId: "proj-1",
				title: "Checkout returns 500 when cart is empty",
				fingerprint: "sha256:abc123",
			},
			session,
		);

		expect(result.isError).toBe(true);
		expect(payload(result).error).toBe("Unique constraint failed");
		expect(mocks.createStoryFromProposal).toHaveBeenCalledTimes(1);
	});

	it("surfaces a non-unique-violation failure as an error", async () => {
		mocks.createStoryFromProposal.mockRejectedValue(
			new Error("drafting model unavailable"),
		);

		const result = await executePlatformTool(
			"fabric_create_bug",
			{ projectId: "proj-1", title: "Some failure" },
			session,
		);

		expect(result.isError).toBe(true);
		expect(payload(result).error).toBe("drafting model unavailable");
	});
});

describe("fabric_create_bug — creation", () => {
	it("creates a BUG through the shared story path with the fingerprint attached", async () => {
		const body = payload(
			await executePlatformTool(
				"fabric_create_bug",
				{
					projectId: "proj-1",
					title: "Checkout returns 500 when cart is empty",
					description: "TypeError: cart.items is undefined",
					fingerprint: "sha256:abc123",
					priority: "P1_HIGH",
				},
				session,
			),
		);

		expect(mocks.createStoryFromProposal).toHaveBeenCalledWith({
			projectId: "proj-1",
			organizationId: "org-1",
			createdById: "user-1",
			title: "Checkout returns 500 when cart is empty",
			description: "TypeError: cart.items is undefined",
			kind: "BUG",
			skipClassifier: true,
			priority: "P1_HIGH",
			draftingStage: "PLACEHOLDER",
			source: "CUSTOM_AGENT",
			bugFingerprint: "sha256:abc123",
		});
		expect(body).toMatchObject({
			success: true,
			created: true,
			dedupedBy: null,
			id: "story-new",
			identifier: "42",
			kind: "BUG",
			fingerprint: "sha256:abc123",
		});
	});

	it("defaults priority to P2_MEDIUM and stores a null fingerprint when omitted", async () => {
		await executePlatformTool(
			"fabric_create_bug",
			{ projectId: "proj-1", title: "Some failure" },
			session,
		);

		expect(mocks.createStoryFromProposal).toHaveBeenCalledWith(
			expect.objectContaining({
				priority: "P2_MEDIUM",
				bugFingerprint: null,
				description: undefined,
			}),
		);
	});

	it("passes a null organizationId through in personal mode (tenant XOR)", async () => {
		mocks.projectFindUnique.mockResolvedValue({
			id: "proj-1",
			organizationId: null,
		});

		await executePlatformTool(
			"fabric_create_bug",
			{ projectId: "proj-1", title: "Some failure" },
			{ ...session, organizationId: null },
		);

		expect(mocks.hasProjectAccess).toHaveBeenCalledWith(
			"proj-1",
			"user-1",
			undefined,
		);
		expect(mocks.createStoryFromProposal).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: null }),
		);
	});
});

/**
 * A bug filed here must look identical downstream to one filed through the Add
 * Feature dialog, or project automations that trigger on story creation would
 * fire for humans and silently skip the monitor that is most likely to want
 * them.
 */
describe("fabric_create_bug — creation side effects", () => {
	it("dispatches story.created and records an audit row on an actual create", async () => {
		await executePlatformTool(
			"fabric_create_bug",
			{
				projectId: "proj-1",
				title: "Checkout returns 500 when cart is empty",
				fingerprint: "sha256:abc123",
			},
			session,
		);
		await flushSideEffects();

		expect(mocks.dispatchLifecycleEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				resource: "story",
				event: "created",
				projectId: "proj-1",
				entityId: "story-new",
				userId: "user-1",
				organizationId: "org-1",
			}),
		);
		expect(mocks.recordAuditFromRequest).toHaveBeenCalledWith(
			expect.objectContaining({
				user: expect.objectContaining({ id: "user-1" }),
			}),
			expect.objectContaining({
				action: "story.created",
				category: "story",
				projectId: "proj-1",
				resource: expect.objectContaining({
					type: "story",
					id: "story-new",
				}),
				// This row IS an insert, so it can never be a dedup hit. The
				// useful signal is whether the caller can be deduped at all.
				metadata: expect.objectContaining({
					deduplicated: false,
					fingerprintProvided: true,
					via: "mcp-gateway:fabric_create_bug",
				}),
			}),
		);
	});

	it("records fingerprintProvided=false when the caller sent no fingerprint", async () => {
		await executePlatformTool(
			"fabric_create_bug",
			{ projectId: "proj-1", title: "Some failure" },
			session,
		);
		await flushSideEffects();

		expect(mocks.recordAuditFromRequest).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				metadata: expect.objectContaining({
					deduplicated: false,
					fingerprintProvided: false,
				}),
			}),
		);
	});

	it("emits on the vanished-winner retry create too", async () => {
		mocks.findFirst.mockResolvedValue(null);
		mocks.createStoryFromProposal
			.mockRejectedValueOnce(
				uniqueViolation(["projectId", "bugFingerprint"]),
			)
			.mockResolvedValueOnce({
				story: {
					id: "story-retry",
					identifier: "44",
					title: "Checkout returns 500 when cart is empty",
					kind: "BUG",
					priority: "P2_MEDIUM",
					draftingStage: "DRAFT",
					statusId: "st1",
				},
				aiDrafted: false,
			});

		await executePlatformTool(
			"fabric_create_bug",
			{
				projectId: "proj-1",
				title: "Checkout returns 500 when cart is empty",
				fingerprint: "sha256:abc123",
			},
			session,
		);
		await flushSideEffects();

		expect(mocks.dispatchLifecycleEvent).toHaveBeenCalledWith(
			expect.objectContaining({ entityId: "story-retry" }),
		);
		expect(mocks.recordAuditFromRequest).toHaveBeenCalledTimes(1);
	});

	it.each([
		[
			"a fingerprint dedup hit",
			() =>
				mocks.findFirst.mockResolvedValue({
					id: "story-existing",
					identifier: "17",
					title: "Checkout 500s on empty cart",
				}),
		],
		[
			"a title dedup hit with a back-fill",
			() =>
				mocks.findCollision.mockReturnValue({
					existingId: "story-title-dupe",
					existingIdentifier: "9",
				}),
		],
	])(
		"emits NOTHING on %s — no row came into existence",
		async (_, arrange) => {
			arrange();

			await executePlatformTool(
				"fabric_create_bug",
				{
					projectId: "proj-1",
					title: "Checkout returns 500 when cart is empty",
					fingerprint: "sha256:abc123",
				},
				session,
			);
			await flushSideEffects();

			expect(mocks.dispatchLifecycleEvent).not.toHaveBeenCalled();
			expect(mocks.recordAuditFromRequest).not.toHaveBeenCalled();
		},
	);

	it("still returns success when the lifecycle dispatch fails", async () => {
		mocks.dispatchLifecycleEvent.mockRejectedValue(new Error("bus down"));

		const result = await executePlatformTool(
			"fabric_create_bug",
			{ projectId: "proj-1", title: "Some failure" },
			session,
		);
		await flushSideEffects();

		expect(result.isError).toBeUndefined();
		expect(payload(result)).toMatchObject({ created: true });
	});
});

/**
 * `hasProjectAccess` proves membership but IGNORES its organizationId argument
 * (packages/database/prisma/queries/projects/projects.ts:918), so a session
 * active in one tenant can still name a project owned by another. The handler
 * compares the project's own owner org against the session's and refuses a
 * mismatch — otherwise the bug would be drafted with one tenant's context and
 * written into another's project.
 */
describe("fabric_create_bug — tenant context", () => {
	it("refuses an org-B project from an org-A session, naming the org to switch to", async () => {
		mocks.projectFindUnique.mockResolvedValue({
			id: "proj-1",
			organizationId: "org-2",
		});

		const result = await executePlatformTool(
			"fabric_create_bug",
			{ projectId: "proj-1", title: "Some failure" },
			session,
		);

		expect(result.isError).toBe(true);
		expect(payload(result).error).toContain("fabric_switch_organization");
		expect(payload(result).error).toContain("org-2");
		expect(mocks.canCreateProjectStory).not.toHaveBeenCalled();
		expect(mocks.createStoryFromProposal).not.toHaveBeenCalled();
	});

	/**
	 * Context is organization-only, so a project owned by no organization is
	 * unreachable rather than one switch away. The refusal deliberately no
	 * longer names `organizationId=null` — that call now always fails, so the
	 * old instruction sent a model into a retry loop.
	 */
	it("refuses an org-less project from an organization session", async () => {
		mocks.projectFindUnique.mockResolvedValue({
			id: "proj-1",
			organizationId: null,
		});

		const result = await executePlatformTool(
			"fabric_create_bug",
			{ projectId: "proj-1", title: "Some failure" },
			session,
		);

		expect(result.isError).toBe(true);
		expect(payload(result).error).toMatch(/cannot be reached/i);
		expect(payload(result).error).not.toContain("organizationId=null");
		expect(mocks.createStoryFromProposal).not.toHaveBeenCalled();
	});

	it("refuses an org project from a personal session", async () => {
		const result = await executePlatformTool(
			"fabric_create_bug",
			{ projectId: "proj-1", title: "Some failure" },
			{ ...session, organizationId: null },
		);

		expect(result.isError).toBe(true);
		expect(payload(result).error).toContain("org-1");
		expect(mocks.createStoryFromProposal).not.toHaveBeenCalled();
	});

	it("treats a project that vanished between the two reads as not found", async () => {
		mocks.projectFindUnique.mockResolvedValue(null);

		const result = await executePlatformTool(
			"fabric_create_bug",
			{ projectId: "proj-1", title: "Some failure" },
			session,
		);

		expect(result.isError).toBe(true);
		expect(payload(result).error).toBe(
			"Project not found or access denied",
		);
	});
});

describe("fabric_create_bug — validation and permissions", () => {
	it.each([
		[{ title: "Some failure" }, "projectId is required"],
		[{ projectId: "", title: "Some failure" }, "projectId is required"],
		[{ projectId: "   ", title: "Some failure" }, "projectId is required"],
		[{ projectId: 42, title: "Some failure" }, "projectId is required"],
		[{ projectId: null, title: "Some failure" }, "projectId is required"],
		[
			{ projectId: { id: "proj-1" }, title: "Some failure" },
			"projectId is required",
		],
		[{ projectId: "proj-1" }, "title is required"],
		[{ projectId: "proj-1", title: "   " }, "title is required"],
		[{ projectId: "proj-1", title: 42 }, "title is required"],
	])("rejects %j", async (args, expected) => {
		const result = await executePlatformTool(
			"fabric_create_bug",
			args,
			session,
		);
		expect(result.isError).toBe(true);
		expect(payload(result).error).toContain(expected);
		expect(mocks.createStoryFromProposal).not.toHaveBeenCalled();
	});

	it("rejects an over-long fingerprint instead of indexing it", async () => {
		const result = await executePlatformTool(
			"fabric_create_bug",
			{
				projectId: "proj-1",
				title: "Some failure",
				fingerprint: "x".repeat(201),
			},
			session,
		);
		expect(result.isError).toBe(true);
		expect(payload(result).error).toContain("200 characters or fewer");
	});

	it("caps title at the same 500 chars the oRPC create-story procedure enforces", async () => {
		const result = await executePlatformTool(
			"fabric_create_bug",
			{ projectId: "proj-1", title: "x".repeat(501) },
			session,
		);
		expect(result.isError).toBe(true);
		expect(payload(result).error).toContain("500 characters or fewer");
		expect(mocks.createStoryFromProposal).not.toHaveBeenCalled();
	});

	it("accepts a title exactly at the limit", async () => {
		const result = await executePlatformTool(
			"fabric_create_bug",
			{ projectId: "proj-1", title: "x".repeat(500) },
			session,
		);
		expect(result.isError).toBeUndefined();
	});

	it("rejects a log-file-sized description", async () => {
		const result = await executePlatformTool(
			"fabric_create_bug",
			{
				projectId: "proj-1",
				title: "Some failure",
				description: "x".repeat(50_001),
			},
			session,
		);
		expect(result.isError).toBe(true);
		expect(payload(result).error).toContain("50000 characters or fewer");
		expect(mocks.createStoryFromProposal).not.toHaveBeenCalled();
	});

	// The gateway routes hand `arguments` through with no schema validation
	// (app/mcp/route.ts, api/mcp-gateway/route.ts), so the handler is the only
	// place a bad type is caught.
	it.each([
		["priority", "P1", "priority must be one of"],
		["priority", 1, "priority must be one of"],
		["priority", "critical", "priority must be one of"],
		["fingerprint", 12345, "fingerprint must be a string"],
		["description", { text: "boom" }, "description must be a string"],
	])("rejects %s=%j instead of coercing it", async (key, value, expected) => {
		const result = await executePlatformTool(
			"fabric_create_bug",
			{ projectId: "proj-1", title: "Some failure", [key]: value },
			session,
		);
		expect(result.isError).toBe(true);
		expect(payload(result).error).toContain(expected as string);
		expect(mocks.createStoryFromProposal).not.toHaveBeenCalled();
	});

	it("never silently downgrades an invalid priority to P2_MEDIUM", async () => {
		// The dangerous failure mode: a P0 outage filed at medium severity with
		// a success response.
		const result = await executePlatformTool(
			"fabric_create_bug",
			{
				projectId: "proj-1",
				title: "Everything is down",
				priority: "P0",
			},
			session,
		);
		expect(result.isError).toBe(true);
		expect(payload(result).error).toContain("P0_CRITICAL");
	});

	it("denies a caller without project access", async () => {
		mocks.hasProjectAccess.mockResolvedValue(false);
		const result = await executePlatformTool(
			"fabric_create_bug",
			{ projectId: "proj-1", title: "Some failure" },
			session,
		);
		expect(result.isError).toBe(true);
		expect(mocks.canCreateProjectStory).not.toHaveBeenCalled();
	});

	it("denies a caller with read-only project access", async () => {
		mocks.canCreateProjectStory.mockResolvedValue(false);
		const result = await executePlatformTool(
			"fabric_create_bug",
			{ projectId: "proj-1", title: "Some failure" },
			session,
		);
		expect(result.isError).toBe(true);
		expect(payload(result).error).toContain("No permission");
		expect(mocks.createStoryFromProposal).not.toHaveBeenCalled();
	});
});

describe("fabric_list_features — work-item kind", () => {
	beforeEach(() => {
		mocks.listStories.mockResolvedValue({
			stories: [
				{
					id: "s1",
					identifier: "1",
					title: "Add SSO",
					kind: "FEATURE",
					status: { id: "st1", name: "Backlog", color: "#fff" },
					priority: "P2_MEDIUM",
					size: null,
					storyPoints: null,
					draftingStage: "PUBLISHED",
					assigneeId: null,
					tasks: [],
					externalUrl: null,
					createdAt: new Date("2026-01-01T00:00:00Z"),
					updatedAt: new Date("2026-01-01T00:00:00Z"),
				},
				{
					id: "s2",
					identifier: "2",
					title: "Checkout returns 500",
					kind: "BUG",
					status: { id: "st1", name: "Backlog", color: "#fff" },
					priority: "P1_HIGH",
					size: null,
					storyPoints: null,
					draftingStage: "DRAFT",
					assigneeId: null,
					tasks: [],
					externalUrl: null,
					createdAt: new Date("2026-01-01T00:00:00Z"),
					updatedAt: new Date("2026-01-01T00:00:00Z"),
				},
			],
			total: 2,
		});
	});

	it("declares an optional FEATURE/BUG filter", () => {
		const definition = PLATFORM_TOOL_DEFINITIONS.find(
			(t) => t.name === "fabric_list_features",
		);
		const schema = definition?.inputSchema as {
			properties: Record<string, { enum?: string[] }>;
			required: string[];
		};
		expect(schema.properties.kind.enum).toEqual(["FEATURE", "BUG"]);
		expect(schema.required).not.toContain("kind");
	});

	it("exposes kind on every returned row", async () => {
		const body = payload(
			await executePlatformTool(
				"fabric_list_features",
				{ projectId: "proj-1" },
				session,
			),
		);
		expect(body.features.map((f: { kind: string }) => f.kind)).toEqual([
			"FEATURE",
			"BUG",
		]);
	});

	it("threads the kind filter into listStories", async () => {
		await executePlatformTool(
			"fabric_list_features",
			{ projectId: "proj-1", kind: "BUG" },
			session,
		);
		expect(mocks.listStories).toHaveBeenCalledWith(
			expect.objectContaining({ projectId: "proj-1", kind: "BUG" }),
		);
	});

	it("leaves kind undefined when the caller omits it, so both types return", async () => {
		await executePlatformTool(
			"fabric_list_features",
			{ projectId: "proj-1" },
			session,
		);
		expect(mocks.listStories).toHaveBeenCalledWith(
			expect.objectContaining({ kind: undefined }),
		);
	});

	// Caught in the handler, not by Prisma — the routes pass `arguments`
	// through unvalidated, and a raw Prisma validation error is not something
	// an autonomous agent can act on.
	it.each([undefined, "", "   ", 42, null, { id: "proj-1" }])(
		"rejects projectId=%j before it reaches Prisma",
		async (projectId) => {
			const result = await executePlatformTool(
				"fabric_list_features",
				{ projectId },
				session,
			);
			expect(result.isError).toBe(true);
			expect(payload(result).error).toContain("projectId is required");
			expect(mocks.hasProjectAccess).not.toHaveBeenCalled();
			expect(mocks.listStories).not.toHaveBeenCalled();
		},
	);

	it.each(["bug", "STORY", 42, null])(
		"rejects kind=%j before it reaches Prisma",
		async (kind) => {
			const result = await executePlatformTool(
				"fabric_list_features",
				{ projectId: "proj-1", kind },
				session,
			);
			expect(result.isError).toBe(true);
			expect(payload(result).error).toContain("kind must be one of");
			expect(mocks.listStories).not.toHaveBeenCalled();
		},
	);
});
