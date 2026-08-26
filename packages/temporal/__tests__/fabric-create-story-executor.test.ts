/**
 * Unit tests for the `fabric_create_story` executor inside built-in-tools.ts.
 *
 * Mocks heavy dependencies at the boundary so the relaxed validation
 * (request-only) and the new title-generator integration can be exercised
 * without spinning up a real DB / AI provider.
 *
 * Covers:
 *   - Title provided in args → no generator call; story created with the
 *     provided title.
 *   - Title omitted, request provided → generator called; aiGeneratedTitle
 *     = true, titleSource = AI is persisted.
 *   - Request missing → returns the relaxed error message.
 *   - Generator falls back (description-fallback) → story still created.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		canCreateProjectStory: vi.fn(),
		organizationFindUnique: vi.fn(),
		userStoryUpdate: vi.fn(),
		generateStoryTitleFromDescription: vi.fn(),
		createStoryFromProposal: vi.fn(),
		dispatchLifecycleEvent: vi.fn(),
		// Hoisted so individual tests can override the dedup behaviour
		// (e.g., simulate a title collision and assert the executor's
		// skipped-response shape).
		buildBacklogDedupGuard: vi.fn(),
	},
}));

// Replace `tool` with a passthrough so we can grab the `execute` fn directly.
vi.mock("@repo/ai", () => ({
	tool: (def: { execute: unknown; description: string }) => def,
}));

vi.mock("@repo/database", () => ({
	setAiUsageRecorder: vi.fn(),
	canCreateProjectStory: mocks.canCreateProjectStory,
	db: {
		organization: { findUnique: mocks.organizationFindUnique },
		userStory: { update: mocks.userStoryUpdate },
		// Default: project has NO PM tool wired up so the new PM-sync gate
		// short-circuits and the executor behaves identically to before. The
		// PM-sync-specific test file (`fabric-create-story-pm-sync.test.ts`)
		// flips this per-case to assert the enqueue path.
		project: {
			findUnique: vi.fn().mockResolvedValue({
				projectManagementMcpConfigId: null,
				projectManagementContainerId: null,
			}),
		},
	},
	getMergedSearchProviderConfigs: vi.fn(),
	getSearchProviderConfig: vi.fn(),
	resolveModelWithCredentials: vi.fn(),
	// New dedup guard wired into `fabric_create_story` so agents can't
	// produce duplicate-by-title rows. The mock is hoisted onto `mocks`
	// so individual tests can simulate a collision and assert the
	// skipped-response shape.
	buildBacklogDedupGuard: mocks.buildBacklogDedupGuard,
	inferDedupFamily: (change: {
		kindOverride?: string | null;
		type: string;
	}) =>
		change.kindOverride === "BUG" || change.type === "bug"
			? "BUG"
			: "FEATURE",
}));

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
	// Group 5: agent-tool executor passes `creationSource: mapCreationSource(
	// reporterSource, "API")` so the LLM prompt's `creation_source` reflects
	// the original surface (SLACK/TEAMS/API).
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

vi.mock("@repo/search", () => ({
	createProvider: vi.fn(),
}));

vi.mock("@repo/storage", () => ({
	uploadFile: vi.fn(),
}));

vi.mock("@repo/utils", () => ({
	decryptApiKey: vi.fn(),
	getBaseUrl: () => "https://app.test",
}));

vi.mock("../src/lib/lifecycle-dispatcher", () => ({
	dispatchLifecycleEvent: mocks.dispatchLifecycleEvent,
}));

vi.mock("../src/lib/create-story-from-proposal", () => ({
	createStoryFromProposal: mocks.createStoryFromProposal,
}));

// built-in-tools.ts does `await import("../../lib/trigger-duplicate-detection")`
// after a successful create. Stub it (it has its own dedicated unit test) so
// this suite stays hermetic and no Temporal client / embedding calls fire.
vi.mock("../src/lib/trigger-duplicate-detection", () => ({
	triggerDuplicateDetection: vi.fn(async () => ({
		workflowId: "dup-detect-test",
	})),
}));

vi.mock("../src/activities/direct-chat/rag-retrieval", () => ({
	retrieveWorkspaceDocumentsActivity: vi.fn(),
}));

vi.mock("../src/activities/orchestrator/utils", () => ({
	jsonSchemaToZod: () => ({}),
}));

const { createBuiltInTools } = await import(
	"../src/activities/direct-chat/built-in-tools"
);

type ExecuteFn = (
	args: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

async function getExecute(): Promise<ExecuteFn> {
	const tools = (await createBuiltInTools({
		userId: "user-1",
		organizationId: "org-1",
		projectId: "project-1",
		enabledFabricToolIds: ["fabric_create_story"],
	})) as Record<string, { execute: ExecuteFn }>;
	const tool = tools.fabric_create_story;
	expect(tool).toBeDefined();
	return tool.execute;
}

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		(m as ReturnType<typeof vi.fn>).mockReset();
	}
	mocks.canCreateProjectStory.mockResolvedValue(true);
	mocks.organizationFindUnique.mockResolvedValue({ slug: "acme" });
	mocks.userStoryUpdate.mockResolvedValue({});
	mocks.dispatchLifecycleEvent.mockResolvedValue({});
	// Default: no collision. Individual tests can override with
	// `mockResolvedValueOnce` to simulate a title clash.
	mocks.buildBacklogDedupGuard.mockResolvedValue({
		findCollision: () => null,
		recordCreated: () => {},
	});
	mocks.createStoryFromProposal.mockResolvedValue({
		story: {
			id: "story-1",
			identifier: "F-007",
			title: "Stub title",
			statusId: "status-1",
			// F-171: kind is set by the classifier inside
			// createStoryFromProposal and surfaced in the executor return
			// payload. Tests that override behavior per-call can pass
			// mockResolvedValueOnce with a different `kind` to assert the
			// classifier-override path.
			kind: "FEATURE",
		},
		aiDrafted: false,
	});
});

describe("fabric_create_story executor", () => {
	it("title provided → generator is NOT called; story created with that title", async () => {
		const execute = await getExecute();

		const result = await execute({
			title: "User-supplied title",
			request: "We need a way to do X.",
			kind: "FEATURE",
		});

		expect(mocks.generateStoryTitleFromDescription).not.toHaveBeenCalled();
		expect(mocks.createStoryFromProposal).toHaveBeenCalledWith(
			expect.objectContaining({ title: "User-supplied title" }),
		);
		expect(mocks.userStoryUpdate).toHaveBeenCalledWith({
			where: { id: "story-1" },
			data: { aiGeneratedTitle: false, titleSource: null },
		});
		expect(result).toEqual(
			expect.objectContaining({
				storyId: "story-1",
				identifier: "F-007",
			}),
		);
	});

	it("title omitted, request provided → generator runs; aiGeneratedTitle = true, titleSource = AI", async () => {
		mocks.generateStoryTitleFromDescription.mockResolvedValue({
			title: "Add SSO login",
			source: "ai",
		});
		const execute = await getExecute();

		await execute({
			request: "Users need to sign in via Google or Microsoft SSO.",
			kind: "FEATURE",
		});

		expect(mocks.generateStoryTitleFromDescription).toHaveBeenCalledWith(
			"Users need to sign in via Google or Microsoft SSO.",
			"FEATURE",
			expect.objectContaining({
				userId: "user-1",
				organizationId: "org-1",
				projectId: "project-1",
				// 2026-05-14 spec §5.3: agent-tool passes request as both
				// description AND origin_context for the title generator.
				originContext:
					"Users need to sign in via Google or Microsoft SSO.",
				// No reporterSource → falls back to "API".
				creationSource: "API",
			}),
		);
		expect(mocks.createStoryFromProposal).toHaveBeenCalledWith(
			expect.objectContaining({ title: "Add SSO login" }),
		);
		expect(mocks.userStoryUpdate).toHaveBeenCalledWith({
			where: { id: "story-1" },
			data: { aiGeneratedTitle: true, titleSource: "AI" },
		});
	});

	it("request missing → returns the relaxed error", async () => {
		const execute = await getExecute();
		const result = await execute({ kind: "FEATURE" });

		expect(result).toEqual({
			error: "`request` is required to create a story.",
		});
		expect(mocks.createStoryFromProposal).not.toHaveBeenCalled();
		expect(mocks.generateStoryTitleFromDescription).not.toHaveBeenCalled();
	});

	it("generator falls back (description-fallback) → story still created", async () => {
		mocks.generateStoryTitleFromDescription.mockResolvedValue({
			title: "Login button vanishes on mobile screens.",
			source: "description-fallback",
		});
		// Override the default mock so the classifier-resolved kind reflected
		// in the return payload is BUG for this assertion.
		mocks.createStoryFromProposal.mockResolvedValueOnce({
			story: {
				id: "story-1",
				identifier: "B-002",
				title: "Login button vanishes on mobile screens.",
				statusId: "status-1",
				kind: "BUG",
			},
			aiDrafted: false,
		});
		const execute = await getExecute();

		const result = await execute({
			request: "Login button vanishes on mobile screens.",
			kind: "BUG",
		});

		expect(mocks.createStoryFromProposal).toHaveBeenCalledWith(
			expect.objectContaining({
				title: "Login button vanishes on mobile screens.",
				kind: "BUG",
			}),
		);
		expect(mocks.userStoryUpdate).toHaveBeenCalledWith({
			where: { id: "story-1" },
			data: {
				aiGeneratedTitle: false,
				titleSource: "DESCRIPTION_FALLBACK",
			},
		});
		expect(result).toEqual(
			expect.objectContaining({ storyId: "story-1", kind: "BUG" }),
		);
	});

	it("BUG kind is forwarded to the generator", async () => {
		mocks.generateStoryTitleFromDescription.mockResolvedValue({
			title: "Fix mobile login regression",
			source: "ai",
		});
		const execute = await getExecute();

		await execute({
			request: "Login is broken on mobile after the latest deploy.",
			kind: "BUG",
		});

		expect(mocks.generateStoryTitleFromDescription).toHaveBeenCalledWith(
			expect.any(String),
			"BUG",
			expect.any(Object),
		);
	});

	it("title omitted, reporterSource=SLACK → helper called with creationSource=Slack", async () => {
		mocks.generateStoryTitleFromDescription.mockResolvedValue({
			title: "Slack-driven title",
			source: "ai",
		});
		const execute = await getExecute();

		await execute({
			request: "A Slack-originated bug report.",
			reporterSource: "SLACK",
		});

		expect(mocks.generateStoryTitleFromDescription).toHaveBeenCalledWith(
			expect.any(String),
			"FEATURE",
			expect.objectContaining({
				originContext: "A Slack-originated bug report.",
				creationSource: "Slack",
			}),
		);
	});

	it("title omitted, reporterSource=TEAMS → helper called with creationSource=Teams", async () => {
		mocks.generateStoryTitleFromDescription.mockResolvedValue({
			title: "Teams-driven title",
			source: "ai",
		});
		const execute = await getExecute();

		await execute({
			request: "A Teams-originated feature request.",
			reporterSource: "TEAMS",
		});

		expect(mocks.generateStoryTitleFromDescription).toHaveBeenCalledWith(
			expect.any(String),
			"FEATURE",
			expect.objectContaining({
				originContext: "A Teams-originated feature request.",
				creationSource: "Teams",
			}),
		);
	});

	it("title omitted, reporterSource=MANUAL → helper called with creationSource=API (fallback)", async () => {
		mocks.generateStoryTitleFromDescription.mockResolvedValue({
			title: "Title",
			source: "ai",
		});
		const execute = await getExecute();

		await execute({
			request: "A manually-flagged request from inside a chat.",
			reporterSource: "MANUAL",
		});

		expect(mocks.generateStoryTitleFromDescription).toHaveBeenCalledWith(
			expect.any(String),
			"FEATURE",
			expect.objectContaining({
				creationSource: "API",
			}),
		);
	});

	it("telemetry update failure does not block story creation", async () => {
		mocks.generateStoryTitleFromDescription.mockResolvedValue({
			title: "Add SSO login",
			source: "ai",
		});
		mocks.userStoryUpdate.mockRejectedValueOnce(
			new Error("DB write failed"),
		);

		const execute = await getExecute();
		const result = await execute({
			request: "Users want SSO.",
			kind: "FEATURE",
		});

		expect(result).toEqual(expect.objectContaining({ storyId: "story-1" }));
	});

	// -----------------------------------------------------------------
	// Title-collision dedup guard — added in the comprehensive follow-up
	// to PR #1232. Agents (Slack / Teams / in-app chat) can call this
	// tool repeatedly with the same intent; without the guard each call
	// materializes a duplicate-by-title row.
	// -----------------------------------------------------------------

	it("title collides with an existing FEATURE → skipped + existing identifier returned, NO createStoryFromProposal call", async () => {
		mocks.buildBacklogDedupGuard.mockResolvedValueOnce({
			findCollision: (family: string, title: string) => {
				// Sanity: executor must call findCollision with FEATURE
				// family + the user-supplied title.
				expect(family).toBe("FEATURE");
				expect(title).toBe("Add login button");
				return { existingIdentifier: "F-012", existingId: "story-12" };
			},
			recordCreated: () => {},
		});

		const execute = await getExecute();
		const result = await execute({
			title: "Add login button",
			request: "Users want a clearer login affordance.",
			kind: "FEATURE",
		});

		// Returns the skipped shape the agent surfaces back to the user.
		expect(result).toEqual({
			skipped: true,
			existingIdentifier: "F-012",
			existingId: "story-12",
			message: expect.stringContaining(
				"already exists in this project as F-012",
			),
		});
		expect(mocks.createStoryFromProposal).not.toHaveBeenCalled();
		// No telemetry update either — there's no new row to update.
		expect(mocks.userStoryUpdate).not.toHaveBeenCalled();
	});

	it("title collides with an existing BUG → skipped + 'bug' wording in message", async () => {
		mocks.buildBacklogDedupGuard.mockResolvedValueOnce({
			findCollision: (family: string) => {
				expect(family).toBe("BUG");
				return { existingIdentifier: "B-007", existingId: "bug-7" };
			},
			recordCreated: () => {},
		});

		const execute = await getExecute();
		const result = await execute({
			title: "Login crashes on Safari",
			request: "Reproduces on Safari 17.",
			kind: "BUG",
		});

		expect(result).toEqual(
			expect.objectContaining({
				skipped: true,
				existingIdentifier: "B-007",
			}),
		);
		// Message names the *kind* so the agent's reply to the user is
		// correctly worded ("bug" vs "feature").
		expect(result.message).toEqual(expect.stringContaining("bug"));
		expect(mocks.createStoryFromProposal).not.toHaveBeenCalled();
	});

	it("title does NOT collide → guard records the create + executor proceeds normally", async () => {
		const recordCreatedSpy = vi.fn();
		mocks.buildBacklogDedupGuard.mockResolvedValueOnce({
			findCollision: () => null,
			recordCreated: recordCreatedSpy,
		});

		const execute = await getExecute();
		const result = await execute({
			title: "A genuinely new idea",
			request: "Net-new product capability.",
			kind: "FEATURE",
		});

		expect(mocks.createStoryFromProposal).toHaveBeenCalledTimes(1);
		expect(result).toEqual(
			expect.objectContaining({
				storyId: "story-1",
				identifier: "F-007",
			}),
		);
	});
});
