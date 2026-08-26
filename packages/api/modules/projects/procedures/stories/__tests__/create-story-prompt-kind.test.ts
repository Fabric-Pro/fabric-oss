/**
 * Creation refuses a hand-picked prompt bound to the other kind (Fizzy #2048,
 * FR11 / AE-HPG1).
 *
 * This is the third surface of the cross-kind prompt guard, and the only one
 * that cannot be enforced in the procedure. When `createStoryProcedure` holds
 * `input.promptId` no work item exists yet: `input.kind` is a HINT the shipped
 * create dialog deliberately never sends, and the classifier inside
 * `createStoryFromProposal` is licensed to overrule it. Guarding the hint would
 * pass a FEATURE-bound prompt for an item the classifier then routes to BUG.
 * So the guard lives between classification and prompt resolution, in
 * `@repo/temporal`, and these tests exercise the REAL one: `@repo/temporal` is
 * mocked only to hand the procedure the actual
 * `create-story-from-proposal.ts`, and `prompt-kind-guard.ts` is not mocked at
 * all. What IS mocked is the binding table underneath it.
 *
 * THE AXIS THESE TESTS PIN. "No binding found" is a refusal in this guard (deny
 * by default), so the document type it asks about decides which prompts survive.
 * Creation's own `resolvePrompt` tries CLEAN_SPEC first and falls back to the
 * drafting stage, and that stage is snapped to DRAFT for bugs — three candidate
 * axes, one correct. The guard asks at the REQUESTED drafting stage, because
 * that is the document type the create dialog's picker built its list from
 * (`project_document_generator` at the selected stage). Two tests below fail if
 * that is changed to either alternative:
 *   - "accepts a prompt bound only at the stage the picker queried" fails if
 *     the axis moves to CLEAN_SPEC.
 *   - "names both kinds when the classifier routes to bug" fails if the axis
 *     moves to the bug-snapped `effectiveStage`, because the refusal would
 *     degrade to the weaker "bound to nothing" message.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const { handlers, mocks } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const mocks = {
		classifyWorkItem: vi.fn(),
		createStory: vi.fn(),
		createFeatureVersion: vi.fn(),
		getBoundPromptForAgent: vi.fn(),
		getPromptById: vi.fn(),
		promptBindingFindMany: vi.fn(),
		promptVersionFindFirst: vi.fn(),
		projectFindUnique: vi.fn(),
		userStoryUpdate: vi.fn(),
		getAIModelWithMetadata: vi.fn(),
		generateObject: vi.fn(),
		logModelUsageAsync: vi.fn(),
		retrieveProjectContexts: vi.fn(),
		formatContextsForPrompt: vi.fn(),
		fetchLiveIntegrationContext: vi.fn(),
		formatLiveContextForPrompt: vi.fn(),
		renderTemplate: vi.fn(),
		generateStoryTitleFromDescription: vi.fn(),
		dispatchLifecycleEvent: vi.fn(),
		recordAuditFromRequest: vi.fn(),
	};
	return { handlers, mocks };
});

vi.mock("@repo/database", () => ({
	db: {
		project: { findUnique: mocks.projectFindUnique },
		userStory: { update: mocks.userStoryUpdate },
		promptBinding: { findMany: mocks.promptBindingFindMany },
		promptVersion: { findFirst: mocks.promptVersionFindFirst },
	},
	createStory: mocks.createStory,
	createFeatureVersion: mocks.createFeatureVersion,
	getBoundPromptForAgent: mocks.getBoundPromptForAgent,
	getPromptById: mocks.getPromptById,
	StoryKindSchema: z.enum(["FEATURE", "BUG"]),
	FeatureDraftingStageSchema: z.enum([
		"PLACEHOLDER",
		"ACTIVE_ANALYSIS",
		"SANITY_CHECK",
		"DRAFT",
		"PUBLISHED",
		"DECLINED",
		"CLOSED",
	]),
}));

vi.mock("@repo/ai", () => {
	class AIProviderNotConfiguredError extends Error {}
	return {
		AIProviderNotConfiguredError,
		getAIModelWithMetadata: mocks.getAIModelWithMetadata,
		generateObject: mocks.generateObject,
		logModelUsageAsync: mocks.logModelUsageAsync,
	};
});

// Imported from the subpath by the drafting core precisely so it survives a
// mocked `@repo/ai` root; mocked here too so no real budget math runs.
vi.mock("@repo/ai/lib/output-token-budget", () => ({
	computeScaledOutputTokenBudget: () => undefined,
}));

vi.mock("@repo/ai/lib/story-title-generator", () => ({
	generateStoryTitleFromDescription: mocks.generateStoryTitleFromDescription,
	mapStoryTitleSourceToEnum: () => null,
}));

vi.mock("@repo/rag", () => ({
	retrieveProjectContexts: mocks.retrieveProjectContexts,
	formatContextsForPrompt: mocks.formatContextsForPrompt,
}));

vi.mock("@repo/rag/lib/project-contexts/live-integration-context", () => ({
	fetchLiveIntegrationContext: mocks.fetchLiveIntegrationContext,
	formatLiveContextForPrompt: mocks.formatLiveContextForPrompt,
}));

vi.mock("@repo/utils", () => ({
	renderTemplate: mocks.renderTemplate,
	stripLeadingDuplicateTitleHeading: (body: string) => body,
	stripWorkItemTitlePrefix: (title: string) => title,
}));

vi.mock("@repo/logs", () => ({
	logger: {
		warn: vi.fn(),
		info: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

// The classifier is the authority on kind here, so it is stubbed per test —
// that verdict is the left-hand side of every comparison the guard makes.
vi.mock("../../../../../../temporal/src/lib/classify-work-item", () => ({
	classifyWorkItem: mocks.classifyWorkItem,
}));

// `@repo/temporal` is mocked ONLY to avoid pulling the barrel's workflow graph
// into an api unit test. The function it hands back is the real one, so the real
// classifier→guard→resolvePrompt sequence runs. `@repo/temporal/prompt-kind-guard`
// (which `create-story.ts` imports for the `instanceof` check) is left alone and
// resolves to the same module the drafting core imports as `./prompt-kind-guard`,
// so the identity check the procedure relies on is genuinely exercised.
vi.mock("@repo/temporal", async () => {
	const real = await import(
		"../../../../../../temporal/src/lib/create-story-from-proposal"
	);
	return { createStoryFromProposal: real.createStoryFromProposal };
});

vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: mocks.recordAuditFromRequest,
}));

vi.mock("../../../../agent-deployments/lib/lifecycle-dispatcher", () => ({
	dispatchLifecycleEvent: mocks.dispatchLifecycleEvent,
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.create = fn;
			return { _handler: fn };
		},
	});
	return {
		tenantProtectedProcedure: chainable,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireProjectPermission: () => (c: unknown) => c,
		resolveOrganizationId: (organizationId: string | null | undefined) =>
			organizationId ?? null,
	};
});

await import("../create-story");

const ctx = {
	user: { id: "user-1", name: "Test User" },
	session: { id: "s-1", activeOrganizationId: null },
};

const PROMPT_ID = "prompt-hand-picked";
const PROMPT_VERSION_ID = "prompt-version-7";
const PROMPT_CONTENT = "HAND_PICKED_PROMPT_SENTINEL";

type KindScope = "FEATURE" | "BUG" | null;

/**
 * The binding table, keyed by document type. The guard's whole decision is
 * "which kind scopes does this prompt carry AT THIS document type", so the mock
 * has to answer per document type — a mock that returned one fixed row set
 * would make every axis look identical and pin nothing.
 */
let bindings: Record<string, { storyKind: KindScope }[]> = {};

/** Every document type the guard actually asked the binding table about. */
function queriedDocumentTypes(): string[] {
	return mocks.promptBindingFindMany.mock.calls.map(
		(call) =>
			(call[0] as { where: { documentType: string } }).where.documentType,
	);
}

/** Nothing was persisted and no drafting model call was made. */
function expectNothingWritten() {
	expect(mocks.createStory).not.toHaveBeenCalled();
	expect(mocks.createFeatureVersion).not.toHaveBeenCalled();
	expect(mocks.generateObject).not.toHaveBeenCalled();
	expect(mocks.userStoryUpdate).not.toHaveBeenCalled();
	expect(mocks.dispatchLifecycleEvent).not.toHaveBeenCalled();
}

/** Run the procedure and return whatever it threw. */
async function refusalFrom(input: Record<string, unknown>): Promise<unknown> {
	return handlers.create({ input, context: ctx }).then(
		() => {
			throw new Error("expected the creation to be refused");
		},
		(caught: unknown) => caught,
	) as Promise<unknown>;
}

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		(m as ReturnType<typeof vi.fn>).mockReset();
	}
	bindings = {};

	mocks.classifyWorkItem.mockResolvedValue({
		kind: "FEATURE",
		confidence: "High",
		fallback_used: false,
		primary_signals: [],
		rationale: "test",
	});

	mocks.promptBindingFindMany.mockImplementation(
		async (args: {
			where: {
				documentType: string;
				promptVersion: { promptId: string };
			};
		}) => {
			// The guard must compare the bindings of the prompt it was pointed
			// at — including, on the version path, the version's PARENT prompt.
			if (args.where.promptVersion.promptId !== PROMPT_ID) {
				return [];
			}
			return bindings[args.where.documentType] ?? [];
		},
	);

	mocks.getPromptById.mockResolvedValue({
		id: PROMPT_ID,
		key: "hand_picked_prompt",
		name: "Hand-picked template",
		format: "PLAIN_TEXT",
		versions: [{ content: PROMPT_CONTENT }],
	});
	mocks.promptVersionFindFirst.mockResolvedValue({
		content: PROMPT_CONTENT,
		promptId: PROMPT_ID,
		prompt: {
			name: "Hand-picked template",
			key: "hand_picked_prompt",
			format: "PLAIN_TEXT",
		},
	});
	mocks.getBoundPromptForAgent.mockResolvedValue(null);

	mocks.projectFindUnique.mockResolvedValue({
		name: "Test project",
		description: "Test project description",
	});
	mocks.retrieveProjectContexts.mockResolvedValue([]);
	mocks.formatContextsForPrompt.mockReturnValue("");
	mocks.fetchLiveIntegrationContext.mockResolvedValue({});
	mocks.formatLiveContextForPrompt.mockReturnValue(null);
	mocks.renderTemplate.mockResolvedValue({
		rendered: PROMPT_CONTENT,
		error: null,
	});

	mocks.getAIModelWithMetadata.mockResolvedValue({
		model: { id: "stub-model" },
		metadata: { providerKey: "stub" },
		trackUsage: vi.fn(),
	});
	mocks.generateObject.mockResolvedValue({
		object: {
			description: "AI-drafted feature body",
			acceptanceCriteria: "AI-drafted criteria",
			markdown: "AI-drafted bug card",
			needsMoreInfo: false,
			title: undefined,
		},
		usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
	});

	mocks.createStory.mockImplementation(
		async (args: { kind: string; title: string }) => ({
			id: "story-1",
			title: args.title,
			kind: args.kind,
			statusId: null,
		}),
	);
	mocks.createFeatureVersion.mockResolvedValue({ id: "feature-version-1" });
	mocks.userStoryUpdate.mockResolvedValue({});
	mocks.dispatchLifecycleEvent.mockResolvedValue({});
});

const baseInput = {
	projectId: "project-1",
	organizationId: null,
	title: "Login button does nothing on the second click",
	description:
		"Clicking sign-in a second time leaves the page on the form with no error.",
	draftingStage: "PLACEHOLDER",
};

describe("createStoryProcedure — a hand-picked prompt is checked against the CLASSIFIED kind", () => {
	it("refuses a FEATURE-bound prompt when the classifier routes the body to BUG, and writes nothing", async () => {
		mocks.classifyWorkItem.mockResolvedValue({
			kind: "BUG",
			confidence: "High",
			fallback_used: false,
		});
		bindings = { PLACEHOLDER: [{ storyKind: "FEATURE" }] };

		const error = await refusalFrom({
			...baseInput,
			promptId: PROMPT_ID,
		});

		expect((error as { code?: string }).code).toBe("BAD_REQUEST");
		expectNothingWritten();
	});

	it("names both kinds when the classifier routes to bug — which also pins the axis to the REQUESTED stage", async () => {
		// The requested stage is PLACEHOLDER; `effectiveStage` is snapped to
		// DRAFT for bugs. The prompt is bound only at PLACEHOLDER, so asking at
		// the snapped stage would find nothing and produce the weaker "not bound
		// to any work item kind" refusal instead of this one.
		mocks.classifyWorkItem.mockResolvedValue({
			kind: "BUG",
			confidence: "High",
			fallback_used: false,
		});
		bindings = { PLACEHOLDER: [{ storyKind: "FEATURE" }] };

		const error = await refusalFrom({
			...baseInput,
			promptId: PROMPT_ID,
		});

		const message = (error as Error).message;
		expect(message).toContain("FEATURE");
		expect(message).toContain("BUG");
		expect(message).toContain("Hand-picked template");
		expect(queriedDocumentTypes()).toEqual(["PLACEHOLDER"]);
	});

	it("ignores the caller's kind hint — the classifier's verdict is what the prompt is compared against", async () => {
		// The hint says FEATURE and the prompt is FEATURE-bound, so a guard that
		// trusted the hint would let this through. The classifier says BUG.
		mocks.classifyWorkItem.mockResolvedValue({
			kind: "BUG",
			confidence: "High",
			fallback_used: false,
		});
		bindings = { PLACEHOLDER: [{ storyKind: "FEATURE" }] };

		const error = await refusalFrom({
			...baseInput,
			kind: "FEATURE",
			promptId: PROMPT_ID,
		});

		expect((error as { code?: string }).code).toBe("BAD_REQUEST");
		expectNothingWritten();
	});

	it("accepts a prompt bound to the classified kind and drafts normally", async () => {
		bindings = { PLACEHOLDER: [{ storyKind: "FEATURE" }] };

		const result = (await handlers.create({
			input: { ...baseInput, promptId: PROMPT_ID },
			context: ctx,
		})) as { story: { id: string }; aiGenerated: boolean };

		expect(result.story.id).toBe("story-1");
		expect(result.aiGenerated).toBe(true);
		// The hand-picked prompt is the one that ran.
		expect(mocks.renderTemplate).toHaveBeenCalledWith(
			expect.objectContaining({ template: PROMPT_CONTENT }),
		);
		expect(mocks.createStory).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "FEATURE" }),
		);
	});
});

describe("createStoryProcedure — the prompt VERSION path does not bypass the guard", () => {
	it("refuses a hand-picked version whose PARENT prompt is bound to the other kind", async () => {
		// `resolvePrompt` reads `explicitPromptVersionId` first and returns
		// before `explicitPromptId` is ever consulted, so a guard keyed on the
		// prompt id alone would never see this input at all.
		mocks.classifyWorkItem.mockResolvedValue({
			kind: "BUG",
			confidence: "High",
			fallback_used: false,
		});
		bindings = { PLACEHOLDER: [{ storyKind: "FEATURE" }] };

		const error = await refusalFrom({
			...baseInput,
			promptVersionId: PROMPT_VERSION_ID,
		});

		expect((error as { code?: string }).code).toBe("BAD_REQUEST");
		expect((error as Error).message).toContain("FEATURE");
		expectNothingWritten();
		// The version was resolved to its parent before the comparison.
		expect(mocks.promptVersionFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ id: PROMPT_VERSION_ID }),
			}),
		);
		expect(mocks.promptBindingFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					promptVersion: { promptId: PROMPT_ID },
				}),
			}),
		);
	});

	it("accepts a hand-picked version whose parent prompt matches the classified kind", async () => {
		bindings = { PLACEHOLDER: [{ storyKind: "FEATURE" }] };

		const result = (await handlers.create({
			input: { ...baseInput, promptVersionId: PROMPT_VERSION_ID },
			context: ctx,
		})) as { story: { id: string } };

		expect(result.story.id).toBe("story-1");
		expect(mocks.createStory).toHaveBeenCalledTimes(1);
	});
});

describe("createStoryProcedure — the document-type axis", () => {
	it("accepts a prompt bound only at the stage the creation picker queried, not at CLEAN_SPEC", async () => {
		// The create dialog's picker lists `project_document_generator`
		// bindings at the selected stage, so this is exactly the prompt it
		// offers. Asking at CLEAN_SPEC instead would find no binding and — deny
		// by default — refuse a legitimate choice.
		bindings = { PLACEHOLDER: [{ storyKind: "FEATURE" }] };

		const result = (await handlers.create({
			input: { ...baseInput, promptId: PROMPT_ID },
			context: ctx,
		})) as { story: { id: string } };

		expect(result.story.id).toBe("story-1");
		expect(queriedDocumentTypes()).toEqual(["PLACEHOLDER"]);
		expect(queriedDocumentTypes()).not.toContain("CLEAN_SPEC");
	});

	it("follows the stage the caller actually requested, not the default", async () => {
		bindings = { ACTIVE_ANALYSIS: [{ storyKind: "FEATURE" }] };

		await handlers.create({
			input: {
				...baseInput,
				draftingStage: "ACTIVE_ANALYSIS",
				promptId: PROMPT_ID,
			},
			context: ctx,
		});

		expect(queriedDocumentTypes()).toEqual(["ACTIVE_ANALYSIS"]);
	});

	it("falls back to PLACEHOLDER when no stage was requested, matching the drafting default", async () => {
		const { draftingStage: _omitted, ...noStage } = baseInput;
		bindings = { PLACEHOLDER: [{ storyKind: "FEATURE" }] };

		await handlers.create({
			input: { ...noStage, promptId: PROMPT_ID },
			context: ctx,
		});

		expect(queriedDocumentTypes()).toEqual(["PLACEHOLDER"]);
	});
});

describe("createStoryProcedure — inputs the guard leaves alone", () => {
	it("does not consult the binding table when neither a prompt id nor a version id was sent", async () => {
		// The shipped create dialog's submission. Nothing is hand-picked, so
		// there is nothing to refuse and the bound lookup decides the template.
		const result = (await handlers.create({
			input: baseInput,
			context: ctx,
		})) as { story: { id: string } };

		expect(mocks.promptBindingFindMany).not.toHaveBeenCalled();
		expect(mocks.getPromptById).not.toHaveBeenCalled();
		expect(mocks.promptVersionFindFirst).not.toHaveBeenCalled();
		expect(result.story.id).toBe("story-1");
		expect(mocks.createStory).toHaveBeenCalledTimes(1);
	});

	it.each([["FEATURE"], ["BUG"]])(
		"accepts a prompt with a null kind scope for a %s classification",
		async (kind) => {
			// NULL is the one scope that means kind-agnostic; the non-stage
			// bindings are seeded that way and are valid for both kinds.
			mocks.classifyWorkItem.mockResolvedValue({
				kind,
				confidence: "High",
				fallback_used: false,
			});
			bindings = { PLACEHOLDER: [{ storyKind: null }] };

			const result = (await handlers.create({
				input: { ...baseInput, promptId: PROMPT_ID },
				context: ctx,
			})) as { story: { id: string } };

			expect(result.story.id).toBe("story-1");
			expect(mocks.createStory).toHaveBeenCalledWith(
				expect.objectContaining({ kind }),
			);
		},
	);

	it("does not refuse a prompt id the caller cannot see — that resolves to nothing and creates the row raw", async () => {
		// `resolvePrompt` returns null for an invisible id, so no cross-kind
		// template can run and there is nothing to refuse. Refusing here would
		// turn an unusable id into a failed creation instead of a closed hole.
		mocks.getPromptById.mockResolvedValue(null);

		const result = (await handlers.create({
			input: { ...baseInput, promptId: "prompt-from-another-tenant" },
			context: ctx,
		})) as { story: { id: string } };

		expect(result.story.id).toBe("story-1");
		expect(mocks.promptBindingFindMany).not.toHaveBeenCalled();
		expect(mocks.generateObject).not.toHaveBeenCalled();
	});

	it("does not refuse a version id the caller cannot see, for the same reason", async () => {
		mocks.promptVersionFindFirst.mockResolvedValue(null);

		const result = (await handlers.create({
			input: { ...baseInput, promptVersionId: "version-from-elsewhere" },
			context: ctx,
		})) as { story: { id: string } };

		expect(result.story.id).toBe("story-1");
		expect(mocks.promptBindingFindMany).not.toHaveBeenCalled();
	});
});
