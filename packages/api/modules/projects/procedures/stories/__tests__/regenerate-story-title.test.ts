/**
 * Unit tests for `regenerateStoryTitleProcedure`.
 *
 * Mocks `@repo/database` (`hasProjectAccess` + `db.userStory.findFirst` +
 * `update` calls), the AI title-generator helper, the PM-sync enqueue
 * helper, and the oRPC procedure base so the handler can be invoked
 * directly.
 *
 * Covers:
 *   - Caller has no access to the project → FORBIDDEN.
 *   - Story not found within an accessible project → NOT_FOUND.
 *   - Happy path → updates title, aiGeneratedTitle = true, titleSource = AI.
 *   - Generator falls back → row still updated; aiGeneratedTitle = false,
 *     titleSource = DESCRIPTION_FALLBACK.
 *   - PM-sync gate: AI rename enqueues PM sync iff `pmAutoSyncEnabled` is
 *     on; transient enqueue failures must not surface to the caller.
 *
 * Permission middleware (UNAUTHORIZED if missing STORY_UPDATE) is enforced
 * by the chain composition; we assert the chain is bound correctly via the
 * `uses` capture.
 */

import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, uses, mocks } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const uses: unknown[] = [];
	const mocks = {
		generateStoryTitleFromDescription: vi.fn(),
		userStoryFindFirst: vi.fn(),
		userStoryUpdate: vi.fn(),
		updateStory: vi.fn(),
		hasProjectAccess: vi.fn(),
		enqueuePmSync: vi.fn(),
		loggerWarn: vi.fn(),
	};
	return { handlers, uses, mocks };
});

vi.mock("@repo/ai/lib/story-title-generator", () => ({
	generateStoryTitleFromDescription: mocks.generateStoryTitleFromDescription,
	mapStoryTitleSourceToEnum: (source: string) => {
		switch (source) {
			case "ai":
				return "AI";
			case "description-fallback":
				return "DESCRIPTION_FALLBACK";
			case "untitled-fallback":
				return "UNTITLED_FALLBACK";
			default:
				return null;
		}
	},
	// Real implementation mirror — Group 4 plumbs this into the helper call
	// site so the LLM prompt's `creation_source` reflects the story's
	// persisted `reporterSource`.
	mapCreationSource: (
		reporterSource: "SLACK" | "TEAMS" | "MANUAL" | null | undefined,
		fallback = "UI",
	) => {
		switch (reporterSource) {
			case "SLACK":
				return "Slack";
			case "TEAMS":
				return "Teams";
			case "MANUAL":
				return fallback;
			default:
				return fallback;
		}
	},
}));

vi.mock("@repo/database", () => ({
	db: {
		userStory: {
			findFirst: mocks.userStoryFindFirst,
			update: mocks.userStoryUpdate,
		},
	},
	hasProjectAccess: mocks.hasProjectAccess,
	updateStory: mocks.updateStory,
}));

vi.mock("@repo/logs", () => ({
	logger: {
		warn: mocks.loggerWarn,
		info: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

vi.mock("../../../lib/enqueue-pm-sync", () => ({
	enqueuePmSync: mocks.enqueuePmSync,
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: (...args: unknown[]) => {
			uses.push(...args);
			return chainable;
		},
		route: () => chainable,
		input: (schema: unknown) => {
			(chainable as { _input?: unknown })._input = schema;
			return chainable;
		},
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.regenerate = fn;
			return { _handler: fn };
		},
	});
	const Permissions = new Proxy({}, { get: (_t, p) => String(p) }) as Record<
		string,
		string
	>;
	return {
		tenantProtectedProcedure: chainable,
		Permissions,
		requirePermission: () => (c: unknown) => c,
		requireProjectPermission: (perm: string) => {
			uses.push({ requireProjectPermission: perm });
			return (c: unknown) => c;
		},
		resolveOrganizationId: (organizationId: string | null | undefined) =>
			organizationId ?? null,
	};
});

await import("../regenerate-story-title");

const ctx = {
	user: { id: "user-1" },
	session: { id: "s-1", activeOrganizationId: null },
};

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		(m as ReturnType<typeof vi.fn>).mockReset();
	}
	mocks.userStoryUpdate.mockResolvedValue({});
	mocks.updateStory.mockResolvedValue({});
	// Default: caller has access. Individual tests override.
	mocks.hasProjectAccess.mockResolvedValue(true);
	// Default: enqueue resolves (no PM sync triggered unless story flag is on,
	// but mock must be ready for the gated branch).
	mocks.enqueuePmSync.mockResolvedValue({
		enqueued: true,
		workflowId: "wf_test",
	});
});

describe("regenerateStoryTitleProcedure", () => {
	it("requires STORY_UPDATE permission", () => {
		const found = uses.some(
			(u) =>
				typeof u === "object" &&
				u !== null &&
				(u as { requireProjectPermission?: string })
					.requireProjectPermission === "STORY_UPDATE",
		);
		expect(found).toBe(true);
	});

	it("caller has no access to the project → FORBIDDEN", async () => {
		mocks.hasProjectAccess.mockResolvedValue(false);

		await expect(
			handlers.regenerate({
				input: {
					projectId: "project-out-of-scope",
					storyId: "story-1",
					organizationId: null,
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		expect(mocks.userStoryFindFirst).not.toHaveBeenCalled();
		expect(mocks.generateStoryTitleFromDescription).not.toHaveBeenCalled();
		expect(mocks.userStoryUpdate).not.toHaveBeenCalled();
	});

	it("story not found within accessible project → NOT_FOUND", async () => {
		mocks.userStoryFindFirst.mockResolvedValue(null);

		await expect(
			handlers.regenerate({
				input: {
					projectId: "project-1",
					storyId: "missing-story",
					organizationId: null,
				},
				context: ctx,
			}),
		).rejects.toBeInstanceOf(ORPCError);
		expect(mocks.generateStoryTitleFromDescription).not.toHaveBeenCalled();
		expect(mocks.userStoryUpdate).not.toHaveBeenCalled();
	});

	it("hasProjectAccess is called with (projectId, userId, organizationId)", async () => {
		mocks.userStoryFindFirst.mockResolvedValue(null);

		await expect(
			handlers.regenerate({
				input: {
					projectId: "project-1",
					storyId: "story-1",
					organizationId: "org-1",
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		expect(mocks.hasProjectAccess).toHaveBeenCalledWith(
			"project-1",
			"user-1",
			"org-1",
		);
	});

	it("scopes the userStory lookup to the requested projectId", async () => {
		mocks.userStoryFindFirst.mockResolvedValue(null);

		await expect(
			handlers.regenerate({
				input: {
					projectId: "project-1",
					storyId: "story-1",
					organizationId: "org-1",
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		const callArg = mocks.userStoryFindFirst.mock.calls[0][0] as {
			where: { id: string; projectId: string };
		};
		expect(callArg.where).toEqual({
			id: "story-1",
			projectId: "project-1",
		});
	});

	it("happy path → updates title, aiGeneratedTitle = true, titleSource = AI", async () => {
		mocks.userStoryFindFirst.mockResolvedValue({
			id: "story-1",
			description: "Users need SSO login support.",
			kind: "FEATURE",
			reporterSource: "MANUAL",
		});
		mocks.generateStoryTitleFromDescription.mockResolvedValue({
			title: "Add SSO login",
			source: "ai",
		});

		const result = await handlers.regenerate({
			input: {
				projectId: "project-1",
				storyId: "story-1",
				organizationId: null,
			},
			context: ctx,
		});

		expect(mocks.generateStoryTitleFromDescription).toHaveBeenCalledWith(
			"Users need SSO login support.",
			"FEATURE",
			expect.objectContaining({
				userId: "user-1",
				projectId: "project-1",
			}),
		);
		expect(mocks.updateStory).toHaveBeenCalledWith(
			"story-1",
			"project-1",
			{ title: "Add SSO login" },
			{
				lastEditedByName: null,
				lastEditedSource: "AI_MATURATION",
			},
		);
		expect(mocks.userStoryUpdate).toHaveBeenCalledWith({
			where: { id: "story-1" },
			data: {
				aiGeneratedTitle: true,
				titleSource: "AI",
			},
		});
		expect(result).toEqual({ title: "Add SSO login", titleSource: "ai" });
	});

	it("BUG kind is mapped to 'BUG' for the helper", async () => {
		mocks.userStoryFindFirst.mockResolvedValue({
			id: "story-bug",
			description: "Login button vanishes on small screens.",
			kind: "BUG",
			reporterSource: null,
		});
		mocks.generateStoryTitleFromDescription.mockResolvedValue({
			title: "Login button missing on mobile",
			source: "ai",
		});

		await handlers.regenerate({
			input: {
				projectId: "project-1",
				storyId: "story-bug",
				organizationId: null,
			},
			context: ctx,
		});

		expect(mocks.generateStoryTitleFromDescription).toHaveBeenCalledWith(
			expect.any(String),
			"BUG",
			expect.any(Object),
		);
	});

	// (The former "USER_STORY kind is treated as FEATURE" case was removed:
	// User Story was retired as a work-item kind, so the only kinds the helper
	// can receive are FEATURE and BUG — both covered above. The non-BUG →
	// "FEATURE" mapping is exercised by the FEATURE happy path.)

	it("story with reporterSource=SLACK → helper called with creationSource=Slack", async () => {
		mocks.userStoryFindFirst.mockResolvedValue({
			id: "story-slack",
			description: "Slack-originated request.",
			kind: "FEATURE",
			reporterSource: "SLACK",
		});
		mocks.generateStoryTitleFromDescription.mockResolvedValue({
			title: "Title",
			source: "ai",
		});

		await handlers.regenerate({
			input: {
				projectId: "project-1",
				storyId: "story-slack",
				organizationId: null,
			},
			context: ctx,
		});

		expect(mocks.generateStoryTitleFromDescription).toHaveBeenCalledWith(
			expect.any(String),
			"FEATURE",
			expect.objectContaining({ creationSource: "Slack" }),
		);
	});

	it("story with reporterSource=TEAMS → helper called with creationSource=Teams", async () => {
		mocks.userStoryFindFirst.mockResolvedValue({
			id: "story-teams",
			description: "Teams-originated request.",
			kind: "FEATURE",
			reporterSource: "TEAMS",
		});
		mocks.generateStoryTitleFromDescription.mockResolvedValue({
			title: "Title",
			source: "ai",
		});

		await handlers.regenerate({
			input: {
				projectId: "project-1",
				storyId: "story-teams",
				organizationId: null,
			},
			context: ctx,
		});

		expect(mocks.generateStoryTitleFromDescription).toHaveBeenCalledWith(
			expect.any(String),
			"FEATURE",
			expect.objectContaining({ creationSource: "Teams" }),
		);
	});

	it("story with reporterSource=MANUAL → helper called with creationSource=UI (fallback)", async () => {
		mocks.userStoryFindFirst.mockResolvedValue({
			id: "story-manual",
			description: "Manually-created.",
			kind: "FEATURE",
			reporterSource: "MANUAL",
		});
		mocks.generateStoryTitleFromDescription.mockResolvedValue({
			title: "Title",
			source: "ai",
		});

		await handlers.regenerate({
			input: {
				projectId: "project-1",
				storyId: "story-manual",
				organizationId: null,
			},
			context: ctx,
		});

		expect(mocks.generateStoryTitleFromDescription).toHaveBeenCalledWith(
			expect.any(String),
			"FEATURE",
			expect.objectContaining({ creationSource: "UI" }),
		);
	});

	it("story with reporterSource=null → helper called with creationSource=UI (fallback)", async () => {
		mocks.userStoryFindFirst.mockResolvedValue({
			id: "story-legacy",
			description: "Legacy pre-F-171 row.",
			kind: "FEATURE",
			reporterSource: null,
		});
		mocks.generateStoryTitleFromDescription.mockResolvedValue({
			title: "Title",
			source: "ai",
		});

		await handlers.regenerate({
			input: {
				projectId: "project-1",
				storyId: "story-legacy",
				organizationId: null,
			},
			context: ctx,
		});

		expect(mocks.generateStoryTitleFromDescription).toHaveBeenCalledWith(
			expect.any(String),
			"FEATURE",
			expect.objectContaining({ creationSource: "UI" }),
		);
	});

	it("AC-18 regression: pre-existing row (aiGeneratedTitle=false, titleSource=null) still regenerates", async () => {
		// The findFirst select must not filter on aiGeneratedTitle or
		// titleSource — old rows are eligible for regenerate.
		mocks.userStoryFindFirst.mockResolvedValue({
			id: "story-preexisting",
			description: "Pre-existing row from before AI-title rollout.",
			kind: "FEATURE",
			reporterSource: null,
		});
		mocks.generateStoryTitleFromDescription.mockResolvedValue({
			title: "Regenerated title",
			source: "ai",
		});

		const result = await handlers.regenerate({
			input: {
				projectId: "project-1",
				storyId: "story-preexisting",
				organizationId: null,
			},
			context: ctx,
		});

		// The lookup should not filter on aiGeneratedTitle/titleSource —
		// confirm the where-clause only scopes on id + projectId.
		const callArg = mocks.userStoryFindFirst.mock.calls[0][0] as {
			where: Record<string, unknown>;
		};
		expect(callArg.where).toEqual({
			id: "story-preexisting",
			projectId: "project-1",
		});
		expect(result).toEqual({
			title: "Regenerated title",
			titleSource: "ai",
		});
	});

	// PM auto-sync gate — the regression this group exists for.
	// Direct DB title update bypassed enqueuePmSync, so AI-regenerated
	// titles never reached the linked PM ticket until the user made an
	// unrelated edit. Mirrors the gate in update-story.ts so behavior is
	// consistent across rename-by-typing and rename-by-AI.

	it("pmAutoSyncEnabled=true → enqueuePmSync called with manual-edit trigger", async () => {
		mocks.userStoryFindFirst.mockResolvedValue({
			id: "story-sync",
			description: "Description that will be turned into a title.",
			kind: "FEATURE",
			reporterSource: "MANUAL",
			pmAutoSyncEnabled: true,
		});
		mocks.generateStoryTitleFromDescription.mockResolvedValue({
			title: "Generated title",
			source: "ai",
		});

		await handlers.regenerate({
			input: {
				projectId: "project-1",
				storyId: "story-sync",
				organizationId: "org-1",
			},
			context: ctx,
		});

		expect(mocks.enqueuePmSync).toHaveBeenCalledTimes(1);
		expect(mocks.enqueuePmSync).toHaveBeenCalledWith({
			itemId: "story-sync",
			itemType: "story",
			projectId: "project-1",
			userId: "user-1",
			triggerSource: "manual-edit",
		});
	});

	it("pmAutoSyncEnabled=false → enqueuePmSync NOT called", async () => {
		mocks.userStoryFindFirst.mockResolvedValue({
			id: "story-no-sync",
			description: "Description.",
			kind: "FEATURE",
			reporterSource: "MANUAL",
			pmAutoSyncEnabled: false,
		});
		mocks.generateStoryTitleFromDescription.mockResolvedValue({
			title: "Generated title",
			source: "ai",
		});

		await handlers.regenerate({
			input: {
				projectId: "project-1",
				storyId: "story-no-sync",
				organizationId: null,
			},
			context: ctx,
		});

		expect(mocks.enqueuePmSync).not.toHaveBeenCalled();
	});

	it("pmAutoSyncEnabled missing/undefined (legacy row) → enqueuePmSync NOT called", async () => {
		// Legacy rows from before the auto-sync flag was added must not
		// auto-push — opt-in only.
		mocks.userStoryFindFirst.mockResolvedValue({
			id: "story-legacy-flag",
			description: "Description.",
			kind: "FEATURE",
			reporterSource: null,
		});
		mocks.generateStoryTitleFromDescription.mockResolvedValue({
			title: "Generated title",
			source: "ai",
		});

		await handlers.regenerate({
			input: {
				projectId: "project-1",
				storyId: "story-legacy-flag",
				organizationId: null,
			},
			context: ctx,
		});

		expect(mocks.enqueuePmSync).not.toHaveBeenCalled();
	});

	it("pmAutoSyncEnabled=true + enqueuePmSync rejects → handler still resolves with the new title", async () => {
		// enqueuePmSync is fire-and-forget. A Temporal hiccup must not
		// surface as a 500 on the regenerate-title button.
		mocks.userStoryFindFirst.mockResolvedValue({
			id: "story-flaky-sync",
			description: "Description.",
			kind: "FEATURE",
			reporterSource: "MANUAL",
			pmAutoSyncEnabled: true,
		});
		mocks.generateStoryTitleFromDescription.mockResolvedValue({
			title: "New title",
			source: "ai",
		});
		mocks.enqueuePmSync.mockRejectedValueOnce(new Error("temporal down"));

		const result = await handlers.regenerate({
			input: {
				projectId: "project-1",
				storyId: "story-flaky-sync",
				organizationId: null,
			},
			context: ctx,
		});

		expect(result).toEqual({ title: "New title", titleSource: "ai" });
		// Yield so the .catch() handler runs before assertions on logger.
		await new Promise((r) => setImmediate(r));
		expect(mocks.loggerWarn).toHaveBeenCalledWith(
			"enqueuePmSync failed",
			expect.objectContaining({ storyId: "story-flaky-sync" }),
		);
	});

	it("pmAutoSyncEnabled flag is selected from the DB lookup", async () => {
		// Guard against future refactors that change the select clause —
		// dropping pmAutoSyncEnabled from select would silently flip the
		// gate to never-sync.
		mocks.userStoryFindFirst.mockResolvedValue({
			id: "story-1",
			description: "x",
			kind: "FEATURE",
			reporterSource: null,
			pmAutoSyncEnabled: true,
		});
		mocks.generateStoryTitleFromDescription.mockResolvedValue({
			title: "t",
			source: "ai",
		});

		await handlers.regenerate({
			input: {
				projectId: "project-1",
				storyId: "story-1",
				organizationId: null,
			},
			context: ctx,
		});

		const callArg = mocks.userStoryFindFirst.mock.calls[0][0] as {
			select: Record<string, boolean>;
		};
		expect(callArg.select).toMatchObject({ pmAutoSyncEnabled: true });
	});

	it("generator falls back → row still updated; aiGeneratedTitle = false, titleSource = DESCRIPTION_FALLBACK", async () => {
		mocks.userStoryFindFirst.mockResolvedValue({
			id: "story-fallback",
			description: "A long enough description for fallback rendering.",
			kind: "FEATURE",
			reporterSource: null,
		});
		mocks.generateStoryTitleFromDescription.mockResolvedValue({
			title: "A long enough description for fallback rendering.",
			source: "description-fallback",
		});

		const result = await handlers.regenerate({
			input: {
				projectId: "project-1",
				storyId: "story-fallback",
				organizationId: null,
			},
			context: ctx,
		});

		expect(mocks.updateStory).toHaveBeenCalledWith(
			"story-fallback",
			"project-1",
			{ title: "A long enough description for fallback rendering." },
			{
				lastEditedByName: null,
				lastEditedSource: "AI_MATURATION",
			},
		);
		expect(mocks.userStoryUpdate).toHaveBeenCalledWith({
			where: { id: "story-fallback" },
			data: {
				aiGeneratedTitle: false,
				titleSource: "DESCRIPTION_FALLBACK",
			},
		});
		expect(result.titleSource).toBe("description-fallback");
	});
});
