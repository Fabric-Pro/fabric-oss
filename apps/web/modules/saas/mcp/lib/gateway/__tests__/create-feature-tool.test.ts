/**
 * `fabric_create_feature` tests.
 *
 * Covers the single dedup layer the tool promises (normalized title, FEATURE
 * family only), creation through the shared `createStoryFromProposal` path, the
 * lifecycle/audit side effects, and the tenant + permission preamble shared
 * with `fabric_create_bug`.
 *
 * There is deliberately NO fingerprint layer here — a fingerprint is an error
 * signature and means nothing for a capability request — so the
 * fingerprint/back-fill/P2002 cases in `create-bug-tool.test.ts` have no
 * counterpart, and one test asserts the fingerprint read never happens.
 *
 * `@repo/database` and `@repo/temporal` are fully mocked — the handlers import
 * them dynamically, so the mock intercepts the `await import(...)` inside the
 * handler body.
 *
 * Run with: pnpm --filter web test modules/saas/mcp/lib/gateway/__tests__/create-feature-tool
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

vi.mock("@repo/temporal", () => ({
	createStoryFromProposal: mocks.createStoryFromProposal,
	dispatchLifecycleEvent: mocks.dispatchLifecycleEvent,
}));

vi.mock("@repo/api/lib/audit", () => ({
	recordAuditFromRequest: mocks.recordAuditFromRequest,
}));

/**
 * The lifecycle dispatch and the audit write are fire-and-forget and both sit
 * behind a dynamic `import(...)`, so a test asserting on either has to let the
 * microtask queue drain first.
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
			title: "Export the roadmap as CSV",
			kind: "FEATURE",
			priority: "P1_HIGH",
			size: "M",
			draftingStage: "DRAFT",
			statusId: "st1",
		},
		aiDrafted: true,
	});
});

describe("fabric_create_feature — declaration", () => {
	const definition = PLATFORM_TOOL_DEFINITIONS.find(
		(t) => t.name === "fabric_create_feature",
	);

	it("is registered as a platform tool", () => {
		expect(definition).toBeDefined();
		expect(definition?._gateway_source).toBe("platform");
	});

	it("requires projectId + title and accepts description/priority/size", () => {
		const schema = definition?.inputSchema as {
			properties: Record<string, { enum?: string[] }>;
			required: string[];
		};
		expect(schema.required).toEqual(["projectId", "title"]);
		expect(Object.keys(schema.properties).sort()).toEqual([
			"description",
			"priority",
			"projectId",
			"size",
			"title",
		]);
		expect(schema.properties.priority.enum).toEqual([
			"P0_CRITICAL",
			"P1_HIGH",
			"P2_MEDIUM",
			"P3_LOW",
		]);
		expect(schema.properties.size.enum).toEqual([
			"XS",
			"S",
			"M",
			"L",
			"XL",
		]);
	});

	it("declares no fingerprint input — that is a bug-only concept", () => {
		const schema = definition?.inputSchema as {
			properties: Record<string, unknown>;
		};
		expect(schema.properties.fingerprint).toBeUndefined();
	});

	it("is NOT annotated read-only (it writes a work item)", () => {
		expect(definition?.annotations?.readOnlyHint).toBeUndefined();
	});
});

describe("fabric_create_feature — title dedup", () => {
	it("returns the existing feature on a normalized-title collision", async () => {
		mocks.findCollision.mockReturnValue({
			existingId: "story-title-dupe",
			existingIdentifier: "9",
		});

		const result = await executePlatformTool(
			"fabric_create_feature",
			{ projectId: "proj-1", title: "Export the roadmap as CSV" },
			session,
		);

		const body = payload(result);
		expect(result.isError).toBeUndefined();
		expect(body).toMatchObject({
			success: true,
			created: false,
			dedupedBy: "title",
			id: "story-title-dupe",
			identifier: "9",
			title: "Export the roadmap as CSV",
		});
		// A feature dedup hit carries no fingerprint bookkeeping.
		expect(body.fingerprintAttached).toBeUndefined();
		expect(mocks.createStoryFromProposal).not.toHaveBeenCalled();
	});

	it("matches within the FEATURE family only", async () => {
		await executePlatformTool(
			"fabric_create_feature",
			{ projectId: "proj-1", title: "  Export the roadmap as CSV  " },
			session,
		);

		expect(mocks.buildBacklogDedupGuard).toHaveBeenCalledWith("proj-1");
		expect(mocks.findCollision).toHaveBeenCalledWith(
			"FEATURE",
			"Export the roadmap as CSV",
		);
	});

	it("never runs a fingerprint lookup — there is no such layer", async () => {
		await executePlatformTool(
			"fabric_create_feature",
			{ projectId: "proj-1", title: "Export the roadmap as CSV" },
			session,
		);

		expect(mocks.findFirst).not.toHaveBeenCalled();
		expect(mocks.updateMany).not.toHaveBeenCalled();
	});

	it("files a new feature when the title-matched row went terminal", async () => {
		mocks.findCollision.mockReturnValue({
			existingId: "story-title-dupe",
			existingIdentifier: "9",
		});
		mocks.storyFindUnique.mockResolvedValue({
			id: "story-title-dupe",
			draftingStage: "CLOSED",
		});

		const body = payload(
			await executePlatformTool(
				"fabric_create_feature",
				{ projectId: "proj-1", title: "Export the roadmap as CSV" },
				session,
			),
		);

		expect(body).toMatchObject({ created: true, id: "story-new" });
		expect(mocks.createStoryFromProposal).toHaveBeenCalledTimes(1);
	});

	it("files a new feature when the title-matched row vanished", async () => {
		mocks.findCollision.mockReturnValue({
			existingId: "story-title-dupe",
			existingIdentifier: "9",
		});
		mocks.storyFindUnique.mockResolvedValue(null);

		const body = payload(
			await executePlatformTool(
				"fabric_create_feature",
				{ projectId: "proj-1", title: "Export the roadmap as CSV" },
				session,
			),
		);

		expect(body).toMatchObject({ created: true, id: "story-new" });
		expect(mocks.createStoryFromProposal).toHaveBeenCalledTimes(1);
	});
});

describe("fabric_create_feature — creation", () => {
	it("creates a FEATURE through the shared story path", async () => {
		const body = payload(
			await executePlatformTool(
				"fabric_create_feature",
				{
					projectId: "proj-1",
					title: "Export the roadmap as CSV",
					description: "Requested so PMs can pivot the backlog.",
					priority: "P1_HIGH",
					size: "M",
				},
				session,
			),
		);

		expect(mocks.createStoryFromProposal).toHaveBeenCalledWith({
			projectId: "proj-1",
			organizationId: "org-1",
			createdById: "user-1",
			title: "Export the roadmap as CSV",
			description: "Requested so PMs can pivot the backlog.",
			kind: "FEATURE",
			skipClassifier: true,
			priority: "P1_HIGH",
			size: "M",
			draftingStage: "PLACEHOLDER",
			source: "CUSTOM_AGENT",
		});
		expect(body).toMatchObject({
			success: true,
			created: true,
			dedupedBy: null,
			id: "story-new",
			identifier: "42",
			kind: "FEATURE",
			size: "M",
		});
	});

	it("declares the kind rather than letting the classifier pick it", async () => {
		await executePlatformTool(
			"fabric_create_feature",
			{ projectId: "proj-1", title: "Export the roadmap as CSV" },
			session,
		);

		expect(mocks.createStoryFromProposal).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "FEATURE", skipClassifier: true }),
		);
	});

	it("defaults priority to P2_MEDIUM and leaves size unset when omitted", async () => {
		await executePlatformTool(
			"fabric_create_feature",
			{ projectId: "proj-1", title: "Export the roadmap as CSV" },
			session,
		);

		expect(mocks.createStoryFromProposal).toHaveBeenCalledWith(
			expect.objectContaining({
				priority: "P2_MEDIUM",
				size: undefined,
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
			"fabric_create_feature",
			{ projectId: "proj-1", title: "Export the roadmap as CSV" },
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
 * A feature filed here must look identical downstream to one filed through the
 * Add Feature dialog, or project automations that trigger on story creation
 * would fire for humans and silently skip the gateway.
 */
describe("fabric_create_feature — creation side effects", () => {
	it("dispatches story.created and records an audit row on an actual create", async () => {
		await executePlatformTool(
			"fabric_create_feature",
			{ projectId: "proj-1", title: "Export the roadmap as CSV" },
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
				session: expect.objectContaining({ id: "sess-1" }),
			}),
			expect.objectContaining({
				action: "story.created",
				category: "story",
				projectId: "proj-1",
				resource: expect.objectContaining({
					type: "story",
					id: "story-new",
				}),
				metadata: expect.objectContaining({
					kind: "FEATURE",
					deduplicated: false,
					via: "mcp-gateway:fabric_create_feature",
				}),
			}),
		);
	});

	it("records no fingerprint metadata — that is bug-only", async () => {
		await executePlatformTool(
			"fabric_create_feature",
			{ projectId: "proj-1", title: "Export the roadmap as CSV" },
			session,
		);
		await flushSideEffects();

		const [, entry] = mocks.recordAuditFromRequest.mock.calls[0];
		expect(entry.metadata.fingerprintProvided).toBeUndefined();
	});

	it("emits NOTHING on a title dedup hit — no row came into existence", async () => {
		mocks.findCollision.mockReturnValue({
			existingId: "story-title-dupe",
			existingIdentifier: "9",
		});

		await executePlatformTool(
			"fabric_create_feature",
			{ projectId: "proj-1", title: "Export the roadmap as CSV" },
			session,
		);
		await flushSideEffects();

		expect(mocks.dispatchLifecycleEvent).not.toHaveBeenCalled();
		expect(mocks.recordAuditFromRequest).not.toHaveBeenCalled();
	});

	it("still returns success when the lifecycle dispatch fails", async () => {
		mocks.dispatchLifecycleEvent.mockRejectedValue(new Error("bus down"));

		const result = await executePlatformTool(
			"fabric_create_feature",
			{ projectId: "proj-1", title: "Export the roadmap as CSV" },
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
 * active in one tenant can still name a project owned by another. The shared
 * write preamble compares the project's own owner org against the session's and
 * refuses a mismatch — otherwise the feature would be drafted with one tenant's
 * context and written into another's project.
 */
describe("fabric_create_feature — tenant context", () => {
	it("refuses an org-B project from an org-A session, naming the org to switch to", async () => {
		mocks.projectFindUnique.mockResolvedValue({
			id: "proj-1",
			organizationId: "org-2",
		});

		const result = await executePlatformTool(
			"fabric_create_feature",
			{ projectId: "proj-1", title: "Export the roadmap as CSV" },
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
			"fabric_create_feature",
			{ projectId: "proj-1", title: "Export the roadmap as CSV" },
			session,
		);

		expect(result.isError).toBe(true);
		expect(payload(result).error).toMatch(/cannot be reached/i);
		expect(payload(result).error).not.toContain("organizationId=null");
		expect(mocks.createStoryFromProposal).not.toHaveBeenCalled();
	});

	it("refuses an org project from a personal session", async () => {
		const result = await executePlatformTool(
			"fabric_create_feature",
			{ projectId: "proj-1", title: "Export the roadmap as CSV" },
			{ ...session, organizationId: null },
		);

		expect(result.isError).toBe(true);
		expect(payload(result).error).toContain("org-1");
		expect(mocks.createStoryFromProposal).not.toHaveBeenCalled();
	});

	it("treats a project that vanished between the two reads as not found", async () => {
		mocks.projectFindUnique.mockResolvedValue(null);

		const result = await executePlatformTool(
			"fabric_create_feature",
			{ projectId: "proj-1", title: "Export the roadmap as CSV" },
			session,
		);

		expect(result.isError).toBe(true);
		expect(payload(result).error).toBe(
			"Project not found or access denied",
		);
	});
});

describe("fabric_create_feature — validation and permissions", () => {
	it.each([
		[{ title: "Export the roadmap as CSV" }, "projectId is required"],
		[
			{ projectId: "", title: "Export the roadmap as CSV" },
			"projectId is required",
		],
		[
			{ projectId: "   ", title: "Export the roadmap as CSV" },
			"projectId is required",
		],
		[
			{ projectId: 42, title: "Export the roadmap as CSV" },
			"projectId is required",
		],
		[
			{ projectId: null, title: "Export the roadmap as CSV" },
			"projectId is required",
		],
		[
			{ projectId: { id: "proj-1" }, title: "Export the roadmap as CSV" },
			"projectId is required",
		],
		[{ projectId: "proj-1" }, "title is required"],
		[{ projectId: "proj-1", title: "   " }, "title is required"],
		[{ projectId: "proj-1", title: 42 }, "title is required"],
	])("rejects %j", async (args, expected) => {
		const result = await executePlatformTool(
			"fabric_create_feature",
			args,
			session,
		);
		expect(result.isError).toBe(true);
		expect(payload(result).error).toContain(expected);
		expect(mocks.createStoryFromProposal).not.toHaveBeenCalled();
	});

	it("caps title at the same 500 chars the oRPC create-story procedure enforces", async () => {
		const result = await executePlatformTool(
			"fabric_create_feature",
			{ projectId: "proj-1", title: "x".repeat(501) },
			session,
		);
		expect(result.isError).toBe(true);
		expect(payload(result).error).toContain("500 characters or fewer");
		expect(mocks.createStoryFromProposal).not.toHaveBeenCalled();
	});

	it("accepts a title exactly at the limit", async () => {
		const result = await executePlatformTool(
			"fabric_create_feature",
			{ projectId: "proj-1", title: "x".repeat(500) },
			session,
		);
		expect(result.isError).toBeUndefined();
	});

	it("rejects an oversized description without bug-report wording", async () => {
		const result = await executePlatformTool(
			"fabric_create_feature",
			{
				projectId: "proj-1",
				title: "Export the roadmap as CSV",
				description: "x".repeat(50_001),
			},
			session,
		);
		expect(result.isError).toBe(true);
		expect(payload(result).error).toContain("50000 characters or fewer");
		// The shared cap must not carry the bug tool's stack-frame phrasing.
		expect(payload(result).error).not.toContain("stack frames");
		expect(mocks.createStoryFromProposal).not.toHaveBeenCalled();
	});

	// The gateway routes hand `arguments` through with no schema validation
	// (app/mcp/route.ts, api/mcp-gateway/route.ts), so the handler is the only
	// place a bad type is caught.
	it.each([
		["priority", "P1", "priority must be one of"],
		["priority", 1, "priority must be one of"],
		["priority", "critical", "priority must be one of"],
		["size", "medium", "size must be one of"],
		["size", "XXL", "size must be one of"],
		["size", 3, "size must be one of"],
		["description", { text: "an idea" }, "description must be a string"],
	])("rejects %s=%j instead of coercing it", async (key, value, expected) => {
		const result = await executePlatformTool(
			"fabric_create_feature",
			{
				projectId: "proj-1",
				title: "Export the roadmap as CSV",
				[key]: value,
			},
			session,
		);
		expect(result.isError).toBe(true);
		expect(payload(result).error).toContain(expected as string);
		expect(mocks.createStoryFromProposal).not.toHaveBeenCalled();
	});

	it("never silently defaults an invalid priority to P2_MEDIUM", async () => {
		const result = await executePlatformTool(
			"fabric_create_feature",
			{
				projectId: "proj-1",
				title: "Export the roadmap as CSV",
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
			"fabric_create_feature",
			{ projectId: "proj-1", title: "Export the roadmap as CSV" },
			session,
		);
		expect(result.isError).toBe(true);
		expect(mocks.canCreateProjectStory).not.toHaveBeenCalled();
		expect(mocks.createStoryFromProposal).not.toHaveBeenCalled();
	});

	it("denies a caller with read-only project access", async () => {
		mocks.canCreateProjectStory.mockResolvedValue(false);
		const result = await executePlatformTool(
			"fabric_create_feature",
			{ projectId: "proj-1", title: "Export the roadmap as CSV" },
			session,
		);
		expect(result.isError).toBe(true);
		expect(payload(result).error).toContain("No permission");
		expect(mocks.createStoryFromProposal).not.toHaveBeenCalled();
	});
});
