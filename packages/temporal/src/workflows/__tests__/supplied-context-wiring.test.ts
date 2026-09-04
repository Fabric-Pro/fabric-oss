/**
 * Supplied source text must reach the generation run ALONGSIDE retrieved
 * project context — additively, exactly once, on either branch.
 *
 * Two failure modes are pinned here, and they are different in kind:
 *
 *  1. **Silent drop at the parent.** The API starts
 *     `projectDocumentGenerationWorkflow` by string name with untyped args, and
 *     the parent destructures a fixed field list and hands the child an
 *     explicitly enumerated args object — it does not spread. A field added to
 *     the child's input but not forwarded through the parent therefore raises
 *     no type error anywhere: the feature simply never arrives, with every unit
 *     test still green. The forwarding assertions below are the only thing
 *     standing between that and production.
 *
 *  2. **Assignment where a join belongs.** `document-generation-child.ts`
 *     accumulates context from several producers (episodic memory, Teams,
 *     Slack). `docs/solutions/design-patterns/prompt-context-fan-in-must-join-not-assign.md`
 *     records a shipped bug of exactly this shape — a branch that assigned into
 *     the accumulator instead of joining, discarding an earlier source, and
 *     stayed invisible until two sources were present at once. This feature
 *     makes two sources present at once by design, so the "everything survives"
 *     test below is not belt-and-braces; it is the feature's own path.
 *
 * Convention (see `document-refresh-dispatcher.test.ts`): mock the activity
 * surface and drive the workflow body as a plain async function rather than
 * standing up `TestWorkflowEnvironment`. Determinism is gated separately by the
 * replay-validation matrix. The source-text assertions at the bottom follow
 * `document-decision-precheck-wiring.test.ts` and pin the structural facts a
 * behavioral test cannot see — chiefly *where* the join sits relative to the
 * branch convergence, and that no new patch gate was introduced.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { activityMocks, executeChildMock, startChildMock } = vi.hoisted(() => ({
	activityMocks: {
		// Parent workflow's tracking activities
		createAgentTask: vi.fn(),
		updateAgentTaskWorkflow: vi.fn(),
		updateAgentTaskStatus: vi.fn(),
		updateProjectWorkflowStatus: vi.fn(),
		// Child workflow's generation activities
		retrieveProjectContexts: vi.fn(),
		retrieveAndFormatEpisodicMemory: vi.fn(),
		generateDocumentWithAgent: vi.fn(),
		saveProjectDocument: vi.fn(),
		createDocumentVersion: vi.fn(),
		embedProjectDocumentActivity: vi.fn(),
		checkProjectHasTeamsIntegration: vi.fn(),
		fetchRecentTeamsMessages: vi.fn(),
		checkProjectHasSlackIntegration: vi.fn(),
		fetchRecentSlackMessages: vi.fn(),
		updateProjectDocumentStatus: vi.fn(),
		runDocumentDecisionPrecheckActivity: vi.fn(),
	},
	executeChildMock: vi.fn(),
	startChildMock: vi.fn(),
}));

vi.mock("@temporalio/workflow", () => {
	class ActivityFailure extends Error {}
	class ApplicationFailure extends Error {
		static nonRetryable(message: string, type?: string) {
			const failure = new ApplicationFailure(message);
			(failure as ApplicationFailure & { type?: string }).type = type;
			return failure;
		}
	}

	return {
		ActivityFailure,
		ApplicationFailure,
		executeChild: executeChildMock,
		startChild: startChildMock,
		log: {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn(),
		},
		ParentClosePolicy: {
			PARENT_CLOSE_POLICY_ABANDON: "ABANDON",
		},
		patched: () => true,
		proxyActivities: () => activityMocks,
		workflowInfo: () => ({ workflowId: "wf_1", runId: "run_1" }),
	};
});

import { documentGenerationChildWorkflow } from "../document-generation-child";
import { projectDocumentGenerationWorkflow } from "../project-document-generation";

/**
 * Stand-in for what `supplied-context.ts` hands the dispatch: already
 * neutralized, bounded, and wrapped in the shared attachment envelope. This
 * unit adds no escaping of its own — it only joins — so the test treats the
 * string as opaque and asserts on identity, not on shape.
 */
const SUPPLIED = "[Uploaded Document: Pasted source content]\nrough draft text";

const PARENT_INPUT = {
	projectId: "proj_1",
	documentId: "doc_1",
	documentType: "PRD",
	userId: "user_1",
	organizationId: "org_1",
	aiToken: "ai-token",
	prompt: "Focus on the migration",
	promptId: "prompt_1",
	promptVersionId: "prompt_version_1",
	currentDocument: "previous body",
};

const CHILD_INPUT = {
	projectId: "proj_1",
	documentId: "doc_1",
	documentType: "PRD",
	userId: "user_1",
	organizationId: "org_1",
	aiToken: "ai-token",
	prompt: "Focus on the migration",
};

/** The `contexts` array the generation activity was actually handed. */
function contextsPassedToAgent(): string[] {
	const call = activityMocks.generateDocumentWithAgent.mock.calls[0]?.[0] as
		| { contexts: string[] }
		| undefined;
	if (!call) {
		throw new Error("generateDocumentWithAgent was never called");
	}
	return call.contexts;
}

beforeEach(() => {
	vi.clearAllMocks();

	executeChildMock.mockResolvedValue({
		success: true,
		documentId: "doc_1",
		documentContent: "# Generated",
		metrics: {
			contextCount: 2,
			episodeCount: 0,
			integrationMessageCount: 0,
			teamsSearchCount: 0,
			documentLength: 11,
			wordCount: 2,
			durationMs: 1,
		},
	});
	startChildMock.mockResolvedValue(undefined);

	activityMocks.createAgentTask.mockResolvedValue({ id: "task_1" });
	activityMocks.updateAgentTaskWorkflow.mockResolvedValue(undefined);
	activityMocks.updateAgentTaskStatus.mockResolvedValue(undefined);
	activityMocks.updateProjectWorkflowStatus.mockResolvedValue(undefined);

	activityMocks.retrieveProjectContexts.mockResolvedValue([
		"retrieved context A",
		"retrieved context B",
	]);
	activityMocks.retrieveAndFormatEpisodicMemory.mockResolvedValue({
		episodeCount: 0,
		formattedContext: "",
	});
	activityMocks.checkProjectHasTeamsIntegration.mockResolvedValue(false);
	activityMocks.checkProjectHasSlackIntegration.mockResolvedValue(false);
	activityMocks.fetchRecentTeamsMessages.mockResolvedValue({
		messageCount: 0,
		formattedContexts: [],
		fetchedChats: 0,
	});
	activityMocks.fetchRecentSlackMessages.mockResolvedValue({
		messageCount: 0,
		formattedContexts: [],
		fetchedChannels: 0,
	});
	activityMocks.generateDocumentWithAgent.mockResolvedValue({
		content: "# Generated",
	});
	activityMocks.saveProjectDocument.mockResolvedValue(undefined);
	activityMocks.createDocumentVersion.mockResolvedValue(undefined);
	activityMocks.embedProjectDocumentActivity.mockResolvedValue({
		success: true,
	});
	activityMocks.updateProjectDocumentStatus.mockResolvedValue(undefined);
	activityMocks.runDocumentDecisionPrecheckActivity.mockResolvedValue(
		undefined,
	);
});

describe("parent workflow forwards supplied context to the child", () => {
	/** The args object the parent enumerated for `executeChild`. */
	function childArgs(): Record<string, unknown> {
		const call = executeChildMock.mock.calls[0];
		if (!call) {
			throw new Error("executeChild was never called");
		}
		return (call[1] as { args: Record<string, unknown>[] }).args[0];
	}

	it("passes both new fields through to the child workflow", async () => {
		await projectDocumentGenerationWorkflow({
			...PARENT_INPUT,
			suppliedContext: SUPPLIED,
			excludeContextId: "ctx_just_created",
		});

		expect(executeChildMock.mock.calls[0][0]).toBe(
			documentGenerationChildWorkflow,
		);
		// The silent-drop case: the API starts this workflow by name with
		// untyped args, so a field the parent forgets to enumerate here simply
		// never arrives — no type error, no failing test, no feature.
		expect(childArgs().suppliedContext).toBe(SUPPLIED);
		expect(childArgs().excludeContextId).toBe("ctx_just_created");
	});

	it("produces the child call it produced before the change when the fields are absent", async () => {
		await projectDocumentGenerationWorkflow(PARENT_INPUT);

		// `toEqual` (not `toStrictEqual`) on purpose: the parent enumerates the
		// new keys unconditionally, so they are present-and-undefined. That is
		// exactly "identical to today's call" for every consumer — the child
		// guards on truthiness — and asserting it this way keeps the test from
		// forcing conditional spreads into the workflow body.
		expect(childArgs()).toEqual({
			projectId: "proj_1",
			documentId: "doc_1",
			documentType: "PRD",
			userId: "user_1",
			organizationId: "org_1",
			aiToken: "ai-token",
			prompt: "Focus on the migration",
			promptId: "prompt_1",
			promptVersionId: "prompt_version_1",
			currentDocument: "previous body",
		});
	});
});

describe("child workflow joins supplied context into the context array", () => {
	it("delivers supplied text alongside retrieved context, exactly once (AE3)", async () => {
		await documentGenerationChildWorkflow({
			...CHILD_INPUT,
			suppliedContext: SUPPLIED,
		});

		const contexts = contextsPassedToAgent();

		// Present even though it was supplied moments ago and retrieval may not
		// have indexed it yet — the whole reason it travels directly.
		expect(contexts).toContain(SUPPLIED);
		// And the retrieved project context is still there: additive, not
		// instead-of.
		expect(contexts).toContain("retrieved context A");
		expect(contexts).toContain("retrieved context B");
		// Exactly once.
		expect(contexts.filter((c) => c === SUPPLIED)).toHaveLength(1);
	});

	it("joins rather than assigns, so every earlier producer survives", async () => {
		// The fan-in bug's own conditions: several producers writing into one
		// accumulator. Anything that assigns instead of joining drops whichever
		// sources ran before it.
		activityMocks.retrieveAndFormatEpisodicMemory.mockResolvedValue({
			episodeCount: 2,
			formattedContext: "episodic memory block",
		});
		activityMocks.checkProjectHasTeamsIntegration.mockResolvedValue(true);
		activityMocks.fetchRecentTeamsMessages.mockResolvedValue({
			messageCount: 1,
			formattedContexts: ["teams message block"],
			fetchedChats: 1,
		});
		activityMocks.checkProjectHasSlackIntegration.mockResolvedValue(true);
		activityMocks.fetchRecentSlackMessages.mockResolvedValue({
			messageCount: 1,
			formattedContexts: ["slack message block"],
			fetchedChannels: 1,
		});

		await documentGenerationChildWorkflow({
			...CHILD_INPUT,
			suppliedContext: SUPPLIED,
		});

		const contexts = contextsPassedToAgent();

		expect(contexts).toContain(SUPPLIED);
		expect(contexts).toContain("episodic memory block");
		expect(contexts).toContain("teams message block");
		expect(contexts).toContain("slack message block");
		expect(contexts).toContain("retrieved context A");
		expect(contexts).toContain("retrieved context B");
	});

	it("applies on the direct-context path too, because it sits after the branch convergence", async () => {
		await documentGenerationChildWorkflow({
			...CHILD_INPUT,
			directContext: ["orchestrator response"],
			suppliedContext: SUPPLIED,
		});

		const contexts = contextsPassedToAgent();

		expect(contexts).toContain(SUPPLIED);
		expect(contexts).toContain("orchestrator response");
		expect(activityMocks.retrieveProjectContexts).not.toHaveBeenCalled();
	});

	it("leaves the direct-context branch's replace-everything behavior intact for its existing caller", async () => {
		await documentGenerationChildWorkflow({
			...CHILD_INPUT,
			directContext: ["orchestrator response"],
		});

		// `code-based-project-setup.ts` means "the orchestrator response IS the
		// context" — retrieval, episodic memory, Teams, and Slack stay skipped.
		expect(contextsPassedToAgent()).toEqual(["orchestrator response"]);
		expect(activityMocks.retrieveProjectContexts).not.toHaveBeenCalled();
		expect(
			activityMocks.retrieveAndFormatEpisodicMemory,
		).not.toHaveBeenCalled();
		expect(
			activityMocks.checkProjectHasTeamsIntegration,
		).not.toHaveBeenCalled();
	});

	it("produces the same context array as before the change when nothing was supplied", async () => {
		await documentGenerationChildWorkflow(CHILD_INPUT);

		expect(contextsPassedToAgent()).toEqual([
			"retrieved context A",
			"retrieved context B",
		]);
	});

	it("adds no empty entry when the supplied text is blank", async () => {
		// The server rejects blank text before it ever gets here (R19); this
		// guards the workflow against handing the model an empty context slot
		// if that ever stops being true.
		await documentGenerationChildWorkflow({
			...CHILD_INPUT,
			suppliedContext: "   \n  ",
		});

		expect(contextsPassedToAgent()).toEqual([
			"retrieved context A",
			"retrieved context B",
		]);
	});
});

describe("child workflow excludes the just-created context from this run's retrieval", () => {
	it("passes the excluded context id to the retrieval activity", async () => {
		await documentGenerationChildWorkflow({
			...CHILD_INPUT,
			suppliedContext: SUPPLIED,
			excludeContextId: "ctx_just_created",
		});

		// The exclusion has to reach the query: `retrieveProjectContexts`
		// returns `string[]` with no identifiers, so a post-filter in the
		// workflow would have nothing to match on.
		expect(activityMocks.retrieveProjectContexts).toHaveBeenCalledWith(
			expect.objectContaining({ excludeContextId: "ctx_just_created" }),
		);
	});
});

describe("supplied-context wiring (source assertions)", () => {
	const child = readFileSync(
		join(__dirname, "../document-generation-child.ts"),
		"utf8",
	);
	const parent = readFileSync(
		join(__dirname, "../project-document-generation.ts"),
		"utf8",
	);
	const types = readFileSync(join(__dirname, "../../types.ts"), "utf8");

	it("declares both fields on the parent workflow's input type", () => {
		expect(types).toContain("suppliedContext?: string;");
		expect(types).toContain("excludeContextId?: string;");
	});

	it("destructures both fields in the parent and enumerates them in the child args", () => {
		const executeChildStart = parent.indexOf("executeChild(");
		const executeChildEnd = parent.indexOf("// If we reach here");
		expect(executeChildStart).toBeGreaterThan(-1);
		expect(executeChildEnd).toBeGreaterThan(executeChildStart);

		const argsBlock = parent.slice(executeChildStart, executeChildEnd);
		expect(argsBlock).toContain("suppliedContext,");
		expect(argsBlock).toContain("excludeContextId,");

		// Destructured from `input` above the call — otherwise the identifiers
		// in the args object would not resolve to the workflow's input at all.
		const destructureBlock = parent.slice(0, parent.indexOf("} = input;"));
		expect(destructureBlock).toContain("suppliedContext,");
		expect(destructureBlock).toContain("excludeContextId,");
	});

	it("joins supplied context into the array instead of assigning over it", () => {
		// The precise shape matters: `contexts = [suppliedContext]` would be
		// the fan-in bug, and it reads almost identically at review.
		expect(child).toContain("contexts = [suppliedContext, ...contexts];");
		expect(child).not.toContain("contexts = [suppliedContext];");
	});

	it("places the join after the branch convergence and before generation", () => {
		const convergence = child.indexOf(
			"end of else (non-directContext path)",
		);
		const joinIdx = child.indexOf(
			"contexts = [suppliedContext, ...contexts];",
		);
		const generateIdx = child.indexOf("await generateDocumentWithAgent(");

		expect(convergence).toBeGreaterThan(-1);
		// After the convergence, so the direct-context path gets it too.
		expect(joinIdx).toBeGreaterThan(convergence);
		// And before the array is handed to the model.
		expect(joinIdx).toBeLessThan(generateIdx);
	});

	it("does not reuse directContext to carry supplied text", () => {
		// `directContext` replaces the array outright and skips retrieval,
		// episodic memory, Teams, and Slack. Routing supplied text through it
		// would silently drop the retrieved project context this unit exists to
		// preserve.
		expect(child).not.toContain("directContext: [suppliedContext");
		expect(child).not.toContain("directContext = [suppliedContext");
	});

	it("threads the exclusion into the retrieval activity call", () => {
		const retrievalCall = child.slice(
			child.indexOf("await retrieveProjectContexts({"),
			child.indexOf("const contextDuration"),
		);
		expect(retrievalCall).toContain("excludeContextId,");
	});

	it("introduces no new patch gate", () => {
		// Adding an optional input field consumed by an already-scheduled
		// activity call adds no command to the workflow's command stream, so it
		// needs no `patched()` gate.
		//
		// Asserted as an exact SET of marker ids rather than a count, so this
		// stays a guard on THIS unit's scope. Both existing gates earned their
		// place: `document-decision-precheck-v1` added an activity CALL, and
		// `document-provider-refusal-fatal-v1` widened which context-retrieval
		// failures abort the run (Fizzy #1875) — a history recorded before it
		// carried on without RAG and must keep replaying that way. Neither is
		// supplied-context's, and a marker appearing here for a change that
		// adds no command is still the regression this test is looking for.
		const markers = (child.match(/patched\("([^"]+)"\)/g) ?? []).sort();
		expect(markers).toEqual([
			'patched("document-decision-precheck-v1")',
			'patched("document-provider-refusal-fatal-v1")',
		]);
	});
});
