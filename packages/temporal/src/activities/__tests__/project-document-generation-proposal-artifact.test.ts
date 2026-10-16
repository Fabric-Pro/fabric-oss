/**
 * The generation activity in artifact mode (Fizzy #2801): one coordinated
 * Proposal run renders exactly its pinned client-only Main prompt, saves each
 * finished section while the agent streams, and cannot write its final
 * document, version or FAILED status over a run that superseded it.
 *
 * The first block characterizes today's behaviour, which artifact mode must
 * leave untouched for every caller that does not opt in: the stream asks for
 * no extra mode, `updates` chunks are never read, and the save, version and
 * status writes issue exactly the queries they always have.
 */

import { ApplicationFailure } from "@temporalio/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const tx = {
		projectDocument: {
			findUnique: vi.fn(),
			updateMany: vi.fn(),
		},
		documentVersion: {
			findFirst: vi.fn(),
			findUnique: vi.fn(),
			create: vi.fn(),
		},
	};
	return {
		runsStream: vi.fn(),
		hasProjectAccess: vi.fn(),
		projectFindUnique: vi.fn(),
		fetchAndRenderPrompt: vi.fn(),
		renderPromptWithContext: vi.fn(),
		getPromptById: vi.fn(),
		incrementPromptUsage: vi.fn(),
		getAIModelWithMetadata: vi.fn(),
		streamText: vi.fn(),
		recordAuditDurable: vi.fn(),
		claimLiveAttempt: vi.fn(),
		writeLiveSections: vi.fn(),
		clearLiveContent: vi.fn(),
		emitDocumentChange: vi.fn(),
		activityContext: vi.fn(),
		buildSettledDecisionsBlock: vi.fn(),
		isFeatureEnabled: vi.fn(),
		isOrganizationMember: vi.fn(),
		authorMaySettleDecisions: vi.fn(),
		listResponsesForDocument: vi.fn(),
		getAnalysisForCurrentContent: vi.fn(),
		projectDocument: {
			findUnique: vi.fn(),
			findFirst: vi.fn(),
			update: vi.fn(),
			updateMany: vi.fn(),
		},
		documentVersion: {
			findFirst: vi.fn(),
			create: vi.fn(),
		},
		tx,
		transaction: vi.fn(async (fn: (client: typeof tx) => unknown) =>
			fn(tx),
		),
	};
});

vi.mock("@langchain/langgraph-sdk", () => ({
	Client: class {
		assistants = { getSchemas: vi.fn().mockResolvedValue({}) };
		runs = {
			stream: (...args: unknown[]) => mocks.runsStream(...args),
		};
	},
}));

vi.mock("@repo/database", () => ({
	db: {
		project: {
			findUnique: (...args: unknown[]) =>
				mocks.projectFindUnique(...args),
		},
		projectDocument: mocks.projectDocument,
		documentVersion: mocks.documentVersion,
		$transaction: mocks.transaction,
	},
	hasProjectAccess: (...args: unknown[]) => mocks.hasProjectAccess(...args),
	recordAuditDurable: (...args: unknown[]) =>
		mocks.recordAuditDurable(...args),
	listEmbeddedDocumentsForSweep: vi.fn().mockResolvedValue([]),
	claimLiveAttempt: (...args: unknown[]) => mocks.claimLiveAttempt(...args),
	writeLiveSections: (...args: unknown[]) => mocks.writeLiveSections(...args),
	clearLiveContent: (...args: unknown[]) => mocks.clearLiveContent(...args),
	// Behind the real settled-decisions builder, for the tests that run it.
	isFeatureEnabled: (...args: unknown[]) => mocks.isFeatureEnabled(...args),
	isOrganizationMember: (...args: unknown[]) =>
		mocks.isOrganizationMember(...args),
	authorMaySettleDecisions: (...args: unknown[]) =>
		mocks.authorMaySettleDecisions(...args),
	listResponsesForDocument: (...args: unknown[]) =>
		mocks.listResponsesForDocument(...args),
	getAnalysisForCurrentContent: (...args: unknown[]) =>
		mocks.getAnalysisForCurrentContent(...args),
}));

// The builder is stubbed at the module boundary; the join, the echo check and
// the constants stay real. Tests that need the real builder point the stub
// at it. The echo guard and check are the real ones, counted, so a test can
// tell what each check was built from, which texts were checked, and that a
// run with nothing carried checks none.
vi.mock(
	"../../lib/proposal-artifact/settled-decisions",
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import("../../lib/proposal-artifact/settled-decisions")
			>();
		return {
			...actual,
			buildSettledDecisionsBlock: (...args: unknown[]) =>
				mocks.buildSettledDecisionsBlock(...args),
			buildEchoGuard: vi.fn(actual.buildEchoGuard),
			checkEcho: vi.fn(actual.checkEcho),
		};
	},
);

vi.mock("@repo/rag", () => ({}));

vi.mock("@repo/ai", () => ({
	DEFAULT_BASE_URLS: {},
	getAIModelWithMetadata: (...args: unknown[]) =>
		mocks.getAIModelWithMetadata(...args),
	logModelUsageAsync: vi.fn(),
	streamText: (...args: unknown[]) => mocks.streamText(...args),
}));

vi.mock("@repo/ai/skills", () => ({
	isTextContentType: vi.fn(),
	loadSkillBundle: vi.fn(),
	readSkillFile: vi.fn(),
}));

vi.mock("@repo/utils/realtime-emit", () => ({
	emitDocumentChange: (...args: unknown[]) =>
		mocks.emitDocumentChange(...args),
}));

vi.mock("../prompt-activities", () => ({
	fetchAndRenderPrompt: (...args: unknown[]) =>
		mocks.fetchAndRenderPrompt(...args),
	renderPromptWithContext: (...args: unknown[]) =>
		mocks.renderPromptWithContext(...args),
}));

// Behind the real `renderPromptWithContext`, for the tests that pin which of
// its errors the activity treats as a refusal.
vi.mock("@repo/database/prisma/queries/prompts", () => ({
	getPromptById: (...args: unknown[]) => mocks.getPromptById(...args),
	incrementPromptUsage: (...args: unknown[]) =>
		mocks.incrementPromptUsage(...args),
}));

vi.mock("@temporalio/activity", async () => {
	const temporalCommon = await import("@temporalio/common");
	return {
		Context: { current: () => mocks.activityContext() },
		heartbeat: vi.fn(),
		ApplicationFailure: temporalCommon.ApplicationFailure,
	};
});

vi.mock("../lib/activity-logger", () => ({
	activityLogger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

// Import AFTER mocks
import { logger } from "@repo/logs";
import { buildSectionMap } from "@repo/utils/proposal-artifact/section-hash";
import { normalizeQuoteArtifacts } from "@repo/utils/quote-artifacts";
import { heartbeat } from "@temporalio/activity";
import { contentIdentity } from "../../lib/proposal-artifact/content-identity";
import {
	buildEchoGuard,
	checkEcho,
	RESPONSE_ECHOED_MESSAGE,
	type ResponseEchoInput,
	SETTLED_DECISIONS_CLOSE,
	SETTLED_DECISIONS_MARKER,
	SETTLED_DECISIONS_OPEN,
	type SettledDecisionsBlock,
} from "../../lib/proposal-artifact/settled-decisions";
import { RESPONSE_ECHOED } from "../../lib/proposal-artifact/types";
import { activityLogger } from "../lib/activity-logger";
import {
	createDocumentVersion,
	generateDocumentWithAgent,
	repairMalformedMermaidFences,
	saveProjectDocument,
	updateProjectDocumentStatus,
} from "../project-document-generation";

type StreamChunk = { event: string; data: unknown };

/** An agent stream that yields `chunks` in order. */
function agentStreams(chunks: StreamChunk[]) {
	mocks.runsStream.mockImplementation(() =>
		(async function* () {
			for (const chunk of chunks) {
				yield chunk;
			}
		})(),
	);
}

/** A cumulative partial document, as the agent's `updates` mode sends it. */
function preview(document: string): StreamChunk {
	return { event: "updates", data: { agent: { document } } };
}

function finalValues(document: string): StreamChunk {
	return { event: "values", data: { document } };
}

/** What `saveProjectDocument` writes for the string the workflow hands it. */
function asSaved(raw: string): string {
	return normalizeQuoteArtifacts(repairMalformedMermaidFences(raw));
}

/** The `runs.stream` payload of the first stream call. */
function streamPayload(): Record<string, unknown> {
	return mocks.runsStream.mock.calls[0]?.[2] as Record<string, unknown>;
}

const SECTION_ONE = "## Executive Summary\n\nThe client modernizes picking.";
const SECTION_TWO = "## Scope\n\nThree warehouses in the first phase.";
const SECTION_THREE = "## Timeline\n\nTwelve weeks end to end.";
const FINAL_DOCUMENT = `${SECTION_ONE}\n\n${SECTION_TWO}\n\n${SECTION_THREE}\n`;

/**
 * The user message a run with a bound or pinned prompt sends for this file's
 * project and the instruction "Emphasize the pilot.", written out as it read
 * before answers to the Internal Analysis could join it.
 */
const BOUND_PROMPT_MESSAGE = [
	"Generate the document following the instructions provided in the system prompt. The system prompt contains the complete custom template and formatting requirements. Adhere to its structure and guidelines precisely.",
	"\nProject: Warehouse modernization\nDescription: Replace paper-based picking.\nTech Stack: React",
	"\n---\n\nADDITIONAL USER INSTRUCTIONS:\nEmphasize the pilot.",
].join("\n");

/** The user message the agent was sent on stream call `index`. */
function userMessage(index = 0): string {
	const payload = mocks.runsStream.mock.calls[index]?.[2] as
		| { input: { messages: Array<{ content: string }> } }
		| undefined;
	return payload?.input.messages[0]?.content ?? "";
}

function generateLegacy(overrides: { prompt?: string } = {}) {
	return generateDocumentWithAgent({
		projectId: "project-1",
		documentId: "doc-1",
		documentType: "PROPOSAL",
		prompt: overrides.prompt ?? "",
		contexts: ["The client picks 4,000 orders a day on paper."],
		userId: "user-1",
		organizationId: "org-1",
		aiToken: "token-1",
		hasRagContexts: true,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.hasProjectAccess.mockResolvedValue(true);
	mocks.projectFindUnique.mockResolvedValue({
		name: "Warehouse modernization",
		description: "Replace paper-based picking.",
		goals: null,
		techStack: ["React"],
		features: [],
		projectTypes: [],
		qaStrategyLevel: null,
	});
	mocks.getAIModelWithMetadata.mockResolvedValue({
		model: {},
		metadata: { modelString: "example-model", provider: "openai" },
		trackUsage: vi.fn(),
	});
	mocks.fetchAndRenderPrompt.mockResolvedValue(null);
	mocks.recordAuditDurable.mockResolvedValue(undefined);
	mocks.claimLiveAttempt.mockResolvedValue("written");
	mocks.writeLiveSections.mockResolvedValue("written");
	mocks.clearLiveContent.mockResolvedValue("written");
	mocks.emitDocumentChange.mockResolvedValue(undefined);
	mocks.activityContext.mockReturnValue({
		info: { attempt: 1 },
		cancellationSignal: new AbortController().signal,
	});
	mocks.projectDocument.update.mockResolvedValue({});
	mocks.documentVersion.findFirst.mockResolvedValue(null);
	mocks.documentVersion.create.mockResolvedValue({ id: "version-row" });
	mocks.transaction.mockImplementation(
		async (fn: (client: typeof mocks.tx) => unknown) => fn(mocks.tx),
	);
	// No answers to carry unless a test says otherwise.
	mocks.buildSettledDecisionsBlock.mockResolvedValue(null);
});

afterEach(() => {
	vi.useRealTimers();
});

// -----------------------------------------------------------------------------
// Today's behaviour, for every caller that does not opt in
// -----------------------------------------------------------------------------

describe("without artifact options — the stream is today's", () => {
	it("asks for no stream mode and passes no abort signal", async () => {
		agentStreams([finalValues(FINAL_DOCUMENT)]);

		await generateLegacy();

		const payload = streamPayload();
		expect(payload).not.toHaveProperty("streamMode");
		expect(payload).not.toHaveProperty("signal");
		expect(Object.keys(payload)).toEqual(["input"]);
	});

	it("reads only `values` chunks: a document in an `updates` chunk is ignored and nothing live is written", async () => {
		agentStreams([
			preview(`${SECTION_ONE}\n\n## Scope\n\nThree`),
			preview(`${SECTION_ONE}\n\n${SECTION_TWO}\n\n## Timeline`),
			finalValues(FINAL_DOCUMENT),
		]);

		const result = await generateLegacy();

		expect(result.content).toBe(FINAL_DOCUMENT);
		expect(mocks.activityContext).not.toHaveBeenCalled();
		expect(mocks.claimLiveAttempt).not.toHaveBeenCalled();
		expect(mocks.writeLiveSections).not.toHaveBeenCalled();
		expect(mocks.clearLiveContent).not.toHaveBeenCalled();
		expect(mocks.emitDocumentChange).not.toHaveBeenCalled();
	});

	it("takes the bound-prompt path and keeps the request's free-text instructions", async () => {
		agentStreams([finalValues(FINAL_DOCUMENT)]);
		mocks.fetchAndRenderPrompt.mockResolvedValue({
			rendered: "Write the client-facing proposal.",
			promptId: "prompt-bound",
			promptName: "Proposal",
			promptVersionId: "pv-bound",
			scope: "ORGANIZATION",
		});

		const result = await generateLegacy({ prompt: "Emphasize the pilot." });

		expect(mocks.renderPromptWithContext).not.toHaveBeenCalled();
		expect(result.resolvedPromptVersionId).toBe("pv-bound");
		const input = streamPayload().input as {
			systemPrompt: string;
			messages: Array<{ content: string }>;
		};
		expect(input.systemPrompt).toBe("Write the client-facing proposal.");
		expect(input.messages[0]?.content).toContain(
			"ADDITIONAL USER INSTRUCTIONS:\nEmphasize the pilot.",
		);
	});

	it("never asks for settled decisions, so a gate-off Proposal's prompt is today's", async () => {
		agentStreams([finalValues(FINAL_DOCUMENT)]);
		mocks.fetchAndRenderPrompt.mockResolvedValue({
			rendered: "Write the client-facing proposal.",
			promptId: "prompt-bound",
			promptName: "Proposal",
			promptVersionId: "pv-bound",
			scope: "ORGANIZATION",
		});

		await generateLegacy({ prompt: "Emphasize the pilot." });

		expect(mocks.buildSettledDecisionsBlock).not.toHaveBeenCalled();
		expect(userMessage()).toBe(BOUND_PROMPT_MESSAGE);
	});

	it("never asks for settled decisions for another document type", async () => {
		agentStreams([finalValues("## Overview\n\nA PRD.\n")]);

		await generateDocumentWithAgent({
			projectId: "project-1",
			documentId: "doc-1",
			documentType: "PRD",
			prompt: "",
			contexts: ["The client picks 4,000 orders a day on paper."],
			userId: "user-1",
			organizationId: "org-1",
			aiToken: "token-1",
			hasRagContexts: true,
		});

		expect(mocks.buildSettledDecisionsBlock).not.toHaveBeenCalled();
		expect(userMessage()).not.toContain(SETTLED_DECISIONS_MARKER);
	});
});

describe("without the live-run guard — the writes are today's", () => {
	it("saveProjectDocument updates by id only and never touches the live columns", async () => {
		mocks.projectDocument.findUnique.mockResolvedValue({
			status: "GENERATING",
			content: "# Old",
			version: 3,
		});

		await saveProjectDocument("doc-1", "# New body", "user-1");

		expect(mocks.projectDocument.update).toHaveBeenCalledTimes(1);
		expect(mocks.projectDocument.update).toHaveBeenCalledWith({
			where: { id: "doc-1" },
			data: {
				content: "# New body",
				wordCount: 3,
				status: "COMPLETE",
				updatedAt: expect.any(Date),
			},
		});
		expect(mocks.transaction).not.toHaveBeenCalled();
		expect(mocks.projectDocument.updateMany).not.toHaveBeenCalled();
	});

	it("createDocumentVersion bumps by id only and resolves with nothing", async () => {
		mocks.documentVersion.findFirst.mockResolvedValue({ version: 3 });

		await expect(
			createDocumentVersion("doc-1", "# New", "user-1", "pv-1"),
		).resolves.toBeUndefined();

		expect(mocks.projectDocument.update).toHaveBeenCalledWith({
			where: { id: "doc-1" },
			data: { version: 4 },
		});
		expect(mocks.transaction).not.toHaveBeenCalled();
		expect(mocks.projectDocument.updateMany).not.toHaveBeenCalled();
	});

	it("updateProjectDocumentStatus writes FAILED by id only", async () => {
		await updateProjectDocumentStatus({
			documentId: "doc-1",
			status: "FAILED",
			progress: 0,
			error: "The agent could not be reached.",
		});

		expect(mocks.projectDocument.update).toHaveBeenCalledWith({
			where: { id: "doc-1" },
			data: {
				status: "FAILED",
				generationProgress: 0,
				updatedAt: expect.any(Date),
				generationError: "The agent could not be reached.",
			},
		});
		expect(mocks.projectDocument.updateMany).not.toHaveBeenCalled();
	});
});

// -----------------------------------------------------------------------------
// Artifact mode: the pinned prompt
// -----------------------------------------------------------------------------

const ARTIFACT = {
	liveRunId: "run-2",
	promptId: "prompt-main",
	promptVersionNumber: 3,
};

const PINNED_PROMPT = "Write the client-only proposal (version 3).";

function generateArtifact(
	overrides: { prompt?: string; promptId?: string } = {},
) {
	return generateDocumentWithAgent({
		projectId: "project-1",
		documentId: "doc-1",
		documentType: "PROPOSAL",
		prompt: overrides.prompt ?? "",
		contexts: ["The client picks 4,000 orders a day on paper."],
		userId: "user-1",
		organizationId: "org-1",
		aiToken: "token-1",
		promptId: overrides.promptId,
		hasRagContexts: true,
		artifact: ARTIFACT,
	});
}

/**
 * The library: the bound version 3, and a newer version 4 that another scope
 * (or an edit made mid-run) put on the same prompt.
 */
function promptLibraryRenders() {
	mocks.renderPromptWithContext.mockImplementation(
		async ({ versionNumber }: { versionNumber?: number }) =>
			versionNumber === 3
				? {
						rendered: PINNED_PROMPT,
						version: 3,
						versionId: "pv-3",
						format: "MARKDOWN",
					}
				: {
						rendered:
							"Write the proposal with an Internal Review (version 4).",
						version: 4,
						versionId: "pv-4",
						format: "MARKDOWN",
					},
	);
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		() => {
			throw new Error("expected a failure");
		},
		(error: unknown) => error,
	);
}

function expectPromptNotBound(error: unknown) {
	expect(error).toBeInstanceOf(ApplicationFailure);
	const failure = error as ApplicationFailure;
	expect(failure.type).toBe("PROPOSAL_PROMPT_NOT_BOUND");
	expect(failure.nonRetryable).toBe(true);
	expect(failure.message).toMatch(/could not be rendered/);
	expect(failure.message).toContain("Client proposal (Main)");
}

/** Nothing reached the agent, a fallback model, or the live columns. */
function expectNothingGenerated() {
	expect(mocks.runsStream).not.toHaveBeenCalled();
	expect(mocks.streamText).not.toHaveBeenCalled();
	expect(mocks.getAIModelWithMetadata).not.toHaveBeenCalled();
	expect(mocks.writeLiveSections).not.toHaveBeenCalled();
	expect(mocks.fetchAndRenderPrompt).not.toHaveBeenCalled();
}

describe("artifact mode — the pinned Main prompt", () => {
	beforeEach(() => {
		promptLibraryRenders();
		agentStreams([finalValues(FINAL_DOCUMENT)]);
	});

	it("renders the bound version, not a newer one, and ignores the request's prompt", async () => {
		const result = await generateArtifact({ promptId: "prompt-editor" });

		expect(mocks.renderPromptWithContext).toHaveBeenCalledTimes(1);
		expect(mocks.renderPromptWithContext).toHaveBeenCalledWith(
			expect.objectContaining({
				promptId: "prompt-main",
				versionNumber: 3,
				userId: "user-1",
				organizationId: "org-1",
				documentType: "proposal",
			}),
		);
		expect(mocks.fetchAndRenderPrompt).not.toHaveBeenCalled();
		const input = streamPayload().input as { systemPrompt: string };
		expect(input.systemPrompt).toBe(PINNED_PROMPT);
		expect(result.resolvedPromptVersionId).toBe("pv-3");
		expect(mocks.getAIModelWithMetadata).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ promptVersionId: "pv-3" }),
		);
	});

	it("keeps the request's free-text instructions after the system prompt", async () => {
		await generateArtifact({ prompt: "Emphasize the pilot." });

		const input = streamPayload().input as {
			messages: Array<{ content: string }>;
		};
		expect(input.messages[0]?.content).toContain(
			"ADDITIONAL USER INSTRUCTIONS:\nEmphasize the pilot.",
		);
	});

	it("fails non-retryably before the agent is called when the pinned prompt cannot be rendered", async () => {
		mocks.renderPromptWithContext.mockRejectedValue(
			new Error("Prompt version not found: prompt-main, version: 3"),
		);

		expectPromptNotBound(await failureOf(generateArtifact()));

		expectNothingGenerated();
	});

	it("fails non-retryably when the pinned prompt itself is gone", async () => {
		mocks.renderPromptWithContext.mockRejectedValue(
			new Error("Prompt not found: prompt-main"),
		);

		expectPromptNotBound(await failureOf(generateArtifact()));

		expectNothingGenerated();
	});

	it("rethrows a transient error while loading the pinned prompt unchanged, so the activity retries it", async () => {
		const outage = Object.assign(
			new Error("Can't reach database server at example.com:5432"),
			{ code: "P1001" },
		);
		mocks.renderPromptWithContext.mockRejectedValue(outage);

		const error = await failureOf(generateArtifact());

		expect(error).toBe(outage);
		expect(error).not.toBeInstanceOf(ApplicationFailure);
		expectNothingGenerated();
	});

	describe("against the prompt library's own errors", () => {
		/** The real renderer, over a mocked prompt store. */
		beforeEach(async () => {
			const actual = await vi.importActual<
				typeof import("../prompt-activities")
			>("../prompt-activities");
			mocks.renderPromptWithContext.mockImplementation(
				(input: Parameters<typeof actual.renderPromptWithContext>[0]) =>
					actual.renderPromptWithContext(input),
			);
			mocks.incrementPromptUsage.mockResolvedValue(undefined);
		});

		it("refuses a prompt the run can no longer see", async () => {
			mocks.getPromptById.mockResolvedValue(null);

			expectPromptNotBound(await failureOf(generateArtifact()));

			expectNothingGenerated();
		});

		it("refuses a prompt whose pinned version is gone", async () => {
			mocks.getPromptById.mockResolvedValue({
				id: "prompt-main",
				format: "MARKDOWN",
				versions: [{ id: "pv-4", version: 4, content: "Version 4." }],
			});

			expectPromptNotBound(await failureOf(generateArtifact()));

			expectNothingGenerated();
		});

		it("lets a database outage through for a retry", async () => {
			const outage = Object.assign(new Error("Connection pool timeout"), {
				code: "P2024",
			});
			mocks.getPromptById.mockRejectedValue(outage);

			expect(await failureOf(generateArtifact())).toBe(outage);

			expectNothingGenerated();
		});

		it("renders the pinned version when the store has it", async () => {
			mocks.getPromptById.mockResolvedValue({
				id: "prompt-main",
				format: "MARKDOWN",
				versions: [
					{ id: "pv-4", version: 4, content: "Version 4." },
					{ id: "pv-3", version: 3, content: PINNED_PROMPT },
				],
			});

			const result = await generateArtifact();

			expect(result.resolvedPromptVersionId).toBe("pv-3");
			const input = streamPayload().input as { systemPrompt: string };
			expect(input.systemPrompt.startsWith(PINNED_PROMPT)).toBe(true);
		});
	});

	it("refuses an empty rendered prompt", async () => {
		mocks.renderPromptWithContext.mockResolvedValue({
			rendered: "  \n ",
			version: 3,
			versionId: "pv-3",
			format: "MARKDOWN",
		});

		expectPromptNotBound(await failureOf(generateArtifact()));

		expectNothingGenerated();
	});

	it("refuses a render of any version other than the pinned one", async () => {
		mocks.renderPromptWithContext.mockResolvedValue({
			rendered: "Write the proposal with an Internal Review (version 4).",
			version: 4,
			versionId: "pv-4",
			format: "MARKDOWN",
		});

		expectPromptNotBound(await failureOf(generateArtifact()));

		expectNothingGenerated();
	});
});

// -----------------------------------------------------------------------------
// Artifact mode: settled decisions from the Internal Analysis (Fizzy #2946)
// -----------------------------------------------------------------------------

/** A member's answer, long enough for the echo check to recognise a copy. */
const SETTLED_ANSWER =
	"Handheld scanners stay with the client and are never part of the fixed fee for either phase of the rollout";
const SETTLED_TITLE = "Scope does not say who supplies the handheld scanners";
const SETTLED_KEY = "k1:0123456789abcdef0123456789abcdef";

/** What the builder returns for one standing answer. */
function settledBlock(
	carried: SettledDecisionsBlock["carried"] = {
		responseTexts: [SETTLED_ANSWER],
		findingTitles: [SETTLED_TITLE],
		responseKeys: [SETTLED_KEY],
		titleKeys: [SETTLED_KEY],
	},
): SettledDecisionsBlock {
	return {
		block: [
			SETTLED_DECISIONS_OPEN,
			"## Settled decisions",
			"",
			`- "${SETTLED_TITLE}" — answered: "${SETTLED_ANSWER}"`,
			SETTLED_DECISIONS_CLOSE,
		].join("\n"),
		analysisBlock: "Not used by a generation.",
		carried,
		itemCount: 1,
	};
}

const SUPPLIED_CONTEXT = "The client picks 4,000 orders a day on paper.";

function generateArtifactWith(
	overrides: {
		contexts?: string[];
		organizationId?: string;
		currentDocument?: string;
		prompt?: string;
	} = {},
) {
	return generateDocumentWithAgent({
		projectId: "project-1",
		documentId: "doc-1",
		documentType: "PROPOSAL",
		prompt: overrides.prompt ?? "Emphasize the pilot.",
		contexts: overrides.contexts ?? [SUPPLIED_CONTEXT],
		userId: "user-1",
		organizationId: overrides.organizationId ?? "org-1",
		aiToken: "token-1",
		currentDocument: overrides.currentDocument,
		hasRagContexts: true,
		artifact: ARTIFACT,
	});
}

/** The project row the activity reads, with its owning organization. */
function projectOwnedBy(
	organizationId: string,
	overrides: Record<string, unknown> = {},
) {
	mocks.projectFindUnique.mockResolvedValue({
		name: "Warehouse modernization",
		description: "Replace paper-based picking.",
		goals: null,
		techStack: ["React"],
		features: [],
		projectTypes: [],
		qaStrategyLevel: null,
		organizationId,
		...overrides,
	});
}

/**
 * Every echo check, in order: the text checked and the inputs its guard was
 * built from. A check against a guard no `buildEchoGuard` call returned fails.
 */
function echoChecks(): ResponseEchoInput[] {
	const built = vi.mocked(buildEchoGuard).mock;
	return vi.mocked(checkEcho).mock.calls.map(([guard, mainText]) => {
		const at = built.results.findIndex((result) => result.value === guard);
		expect(at).toBeGreaterThanOrEqual(0);
		return { ...built.calls[at][0], mainText };
	});
}

/** Everything the activity logged at info level and above, as one string. */
function activityLogText(): string {
	const logged = activityLogger as unknown as Record<
		"info" | "warn" | "error",
		{ mock: { calls: unknown[][] } }
	>;
	return JSON.stringify([
		logged.info.mock.calls,
		logged.warn.mock.calls,
		logged.error.mock.calls,
	]);
}

describe("artifact mode — settled decisions", () => {
	beforeEach(() => {
		promptLibraryRenders();
		projectOwnedBy("org-1");
	});

	it("asks once per attempt, for the starter, in the project's owning organization", async () => {
		agentStreams([finalValues(FINAL_DOCUMENT)]);
		projectOwnedBy("org-owning");

		await generateArtifactWith({ organizationId: "org-session" });

		expect(mocks.buildSettledDecisionsBlock).toHaveBeenCalledTimes(1);
		expect(mocks.buildSettledDecisionsBlock).toHaveBeenCalledWith({
			projectId: "project-1",
			documentId: "doc-1",
			starterUserId: "user-1",
			organizationId: "org-owning",
		});
	});

	it("joins the block after the request's instructions, keeping both, and never as a reference", async () => {
		agentStreams([finalValues(FINAL_DOCUMENT)]);
		const settled = settledBlock();
		mocks.buildSettledDecisionsBlock.mockResolvedValue(settled);

		await generateArtifactWith();

		expect(userMessage()).toBe(
			`${BOUND_PROMPT_MESSAGE}\n\n${settled.block}`,
		);
		// The supplied context reaches the pinned prompt as it was: the block
		// is not one of the numbered references.
		expect(mocks.renderPromptWithContext).toHaveBeenCalledWith(
			expect.objectContaining({ ragContexts: [SUPPLIED_CONTEXT] }),
		);
		const input = streamPayload().input as {
			systemPrompt: string;
			ragContexts: string[];
		};
		expect(input.systemPrompt).toBe(PINNED_PROMPT);
		expect(input.systemPrompt).not.toContain(SETTLED_DECISIONS_MARKER);
		expect(input.ragContexts).toEqual([]);
	});

	it("leaves today's prompt byte for byte when there are no settled decisions", async () => {
		agentStreams([finalValues(FINAL_DOCUMENT)]);

		const result = await generateArtifactWith();

		expect(userMessage()).toBe(BOUND_PROMPT_MESSAGE);
		expect(result.content).toBe(FINAL_DOCUMENT);
	});

	it("carries the block into the gateway fallback too", async () => {
		mocks.runsStream.mockImplementation(() => {
			throw new Error("agent unavailable");
		});
		mocks.streamText.mockReturnValue({
			textStream: (async function* () {
				yield FINAL_DOCUMENT;
			})(),
			finishReason: Promise.resolve("stop"),
			usage: Promise.resolve({}),
		});
		const settled = settledBlock();
		mocks.buildSettledDecisionsBlock.mockResolvedValue(settled);

		await generateArtifactWith();

		const fallback = mocks.streamText.mock.calls[0]?.[0] as {
			prompt: string;
		};
		expect(fallback.prompt).toBe(
			`${BOUND_PROMPT_MESSAGE}\n\n${settled.block}`,
		);
	});

	describe("the echo check before Main leaves the activity", () => {
		const ECHOING_DOCUMENT = `${SECTION_ONE}\n\n## Scope\n\nThree warehouses in the first phase. ${SETTLED_ANSWER}.\n\n${SECTION_THREE}\n`;

		it("refuses a Main that repeats an answer, non-retryably and without naming it, and never shows it live", async () => {
			agentStreams([finalValues(ECHOING_DOCUMENT)]);
			mocks.buildSettledDecisionsBlock.mockResolvedValue(settledBlock());

			const error = await failureOf(generateArtifactWith());

			expect(error).toBeInstanceOf(ApplicationFailure);
			const failure = error as ApplicationFailure;
			expect(failure.type).toBe(RESPONSE_ECHOED);
			expect(failure.nonRetryable).toBe(true);
			expect(failure.message).toBe(RESPONSE_ECHOED_MESSAGE);
			expect(failure.message).not.toContain("scanners");
			expect(JSON.stringify(failure.details ?? [])).not.toContain(
				"scanners",
			);
			// The whole document, written live once the stream ends, is
			// checked first: it never reaches the live columns, and the
			// preview is dropped at once.
			expect(mocks.writeLiveSections).not.toHaveBeenCalled();
			expect(mocks.clearLiveContent).toHaveBeenCalledWith({
				documentId: "doc-1",
				runId: "run-2",
				attempt: 1,
			});
			// No fallback stands in for the refused run.
			expect(mocks.streamText).not.toHaveBeenCalled();
			// Counts only: no answer, title or document text in any log line.
			expect(activityLogger.warn).toHaveBeenCalledWith(
				expect.stringContaining("settled answer"),
				expect.objectContaining({
					step: "finish",
					echoedResponses: 1,
					echoedTitles: 0,
					error: RESPONSE_ECHOED,
				}),
			);
			expect(activityLogText()).not.toContain("scanners");
			expect(activityLogText()).not.toContain("Three warehouses");
			expect(activityLogger.info).not.toHaveBeenCalledWith(
				"Document generation completed successfully",
				expect.anything(),
			);
		});

		it("refuses an echoing Main the gateway fallback wrote, before logging success", async () => {
			mocks.runsStream.mockImplementation(() => {
				throw new Error("agent unavailable");
			});
			fallbackProduces(ECHOING_DOCUMENT);
			mocks.buildSettledDecisionsBlock.mockResolvedValue(settledBlock());

			const failure = (await failureOf(
				generateArtifactWith(),
			)) as ApplicationFailure;

			expect(failure.type).toBe(RESPONSE_ECHOED);
			expect(failure.message).toBe(RESPONSE_ECHOED_MESSAGE);
			// The fallback writes nothing live; the final check refuses it.
			expect(mocks.writeLiveSections).not.toHaveBeenCalled();
			expect(activityLogger.warn).toHaveBeenCalledWith(
				"Generated Main repeated a settled answer's wording; not saving it",
				{
					projectId: "project-1",
					documentId: "doc-1",
					liveRunId: "run-2",
					echoedResponses: 1,
					echoedTitles: 0,
					echoedKeys: [SETTLED_KEY],
					error: RESPONSE_ECHOED,
				},
			);
			expect(activityLogger.info).not.toHaveBeenCalledWith(
				"Document generation completed successfully",
				expect.anything(),
			);
			expect(activityLogText()).not.toContain("scanners");
		});

		it("refuses a Main that copies a finding's title", async () => {
			const title =
				"The proposal never states who supplies and maintains the handheld scanners during the rollout";
			agentStreams([
				finalValues(`${SECTION_ONE}\n\n## Risks\n\n${title}.\n`),
			]);
			mocks.buildSettledDecisionsBlock.mockResolvedValue(
				settledBlock({ responseTexts: [], findingTitles: [title] }),
			);

			const failure = (await failureOf(
				generateArtifactWith(),
			)) as ApplicationFailure;

			expect(failure.type).toBe(RESPONSE_ECHOED);
		});

		it.each([
			[
				"the supplied context",
				{ contexts: [`Site survey notes. ${SETTLED_ANSWER}.`] },
			],
			[
				"the document before this run",
				{ currentDocument: `## Scope\n\n${SETTLED_ANSWER}.\n` },
			],
		])("lets through wording %s also holds", async (_case, overrides) => {
			agentStreams([finalValues(ECHOING_DOCUMENT)]);
			mocks.buildSettledDecisionsBlock.mockResolvedValue(settledBlock());

			const result = await generateArtifactWith(overrides);

			expect(result.content).toBe(ECHOING_DOCUMENT);
		});

		// The prompt renders the project's information outside the supplied
		// context, so Main may repeat it whatever an answer says.
		it.each([
			["description", { description: `Pilot terms. ${SETTLED_ANSWER}.` }],
			["goals", { goals: `${SETTLED_ANSWER}.` }],
			["tech stack", { techStack: ["React", SETTLED_ANSWER] }],
		])(
			"lets through wording the project's %s also holds",
			async (_field, project) => {
				projectOwnedBy("org-1", project);
				agentStreams([finalValues(ECHOING_DOCUMENT)]);
				mocks.buildSettledDecisionsBlock.mockResolvedValue(
					settledBlock(),
				);

				const result = await generateArtifactWith();

				expect(result.content).toBe(ECHOING_DOCUMENT);
				expect(activityLogText()).not.toContain("scanners");
			},
		);

		it("lets through wording the project's features hold only when the prompt rendered them, which it does without project context", async () => {
			projectOwnedBy("org-1", { features: [SETTLED_ANSWER] });
			mocks.buildSettledDecisionsBlock.mockResolvedValue(settledBlock());

			agentStreams([finalValues(ECHOING_DOCUMENT)]);
			expect((await generateArtifactWith({ contexts: [] })).content).toBe(
				ECHOING_DOCUMENT,
			);

			// With project context supplied, the prompt leaves the features
			// out, so a copy of an answer cannot have come from them.
			agentStreams([finalValues(ECHOING_DOCUMENT)]);
			const failure = (await failureOf(
				generateArtifactWith(),
			)) as ApplicationFailure;
			expect(failure.type).toBe(RESPONSE_ECHOED);
		});

		it("still refuses wording only the answer holds when the project has information of its own", async () => {
			projectOwnedBy("org-1", {
				goals: "Cut picking errors in half within a year.",
				projectTypes: ["WEB_APP"],
			});
			agentStreams([finalValues(ECHOING_DOCUMENT)]);
			mocks.buildSettledDecisionsBlock.mockResolvedValue(settledBlock());

			const failure = (await failureOf(
				generateArtifactWith(),
			)) as ApplicationFailure;

			expect(failure.type).toBe(RESPONSE_ECHOED);
			expect(echoChecks()).toContainEqual(
				expect.objectContaining({
					sourceContext: [
						SUPPLIED_CONTEXT,
						"Warehouse modernization",
						"Replace paper-based picking.",
						"Cut picking errors in half within a year.",
						"React",
						"WEB_APP",
						"Emphasize the pilot.",
					],
				}),
			);
		});

		// Fizzy #2946: the member who started the run wrote its instructions,
		// and the prompt carries them, so Main may repeat their wording even
		// when an answer shares it.
		it("lets through wording the run's own instructions also hold, and never logs them", async () => {
			const instructions = `Make sure the proposal says plainly that ${SETTLED_ANSWER}.`;
			agentStreams([finalValues(ECHOING_DOCUMENT)]);
			mocks.buildSettledDecisionsBlock.mockResolvedValue(settledBlock());

			const result = await generateArtifactWith({ prompt: instructions });

			expect(result.content).toBe(ECHOING_DOCUMENT);
			expect(userMessage()).toContain(
				`ADDITIONAL USER INSTRUCTIONS:\n${instructions}`,
			);
			// The live write once the stream ended and the final Main were
			// both checked against them.
			const checks = echoChecks();
			expect(checks.map((input) => input.mainText)).toEqual([
				ECHOING_DOCUMENT.trimEnd(),
				ECHOING_DOCUMENT,
			]);
			for (const input of checks) {
				expect(input.sourceContext).toEqual(
					expect.arrayContaining([instructions]),
				);
			}
			expect(activityLogText()).not.toContain("scanners");
			expect(activityLogText()).not.toContain("Make sure the proposal");
		});

		it("still refuses wording only the answer holds when the run has instructions of its own", async () => {
			const instructions =
				"Keep the tone formal and open with the business outcome the client cares about most.";
			agentStreams([finalValues(ECHOING_DOCUMENT)]);
			mocks.buildSettledDecisionsBlock.mockResolvedValue(settledBlock());

			const failure = (await failureOf(
				generateArtifactWith({ prompt: instructions }),
			)) as ApplicationFailure;

			expect(failure.type).toBe(RESPONSE_ECHOED);
			expect(echoChecks()).toContainEqual(
				expect.objectContaining({
					sourceContext: expect.arrayContaining([instructions]),
				}),
			);
			expect(activityLogText()).not.toContain("Keep the tone formal");
		});

		it("adds no instructions to what Main may repeat when the run has none", async () => {
			agentStreams([finalValues(FINAL_DOCUMENT)]);
			mocks.buildSettledDecisionsBlock.mockResolvedValue(settledBlock());

			await generateArtifactWith({ prompt: "   " });

			expect(echoChecks()).toContainEqual(
				expect.objectContaining({
					sourceContext: [
						SUPPLIED_CONTEXT,
						"Warehouse modernization",
						"Replace paper-based picking.",
						"React",
					],
				}),
			);
		});

		it("lets a short factual answer through, even when Main states it", async () => {
			agentStreams([finalValues(FINAL_DOCUMENT)]);
			mocks.buildSettledDecisionsBlock.mockResolvedValue(
				settledBlock({
					responseTexts: ["Twelve weeks end to end."],
					findingTitles: ["Timeline"],
				}),
			);

			const result = await generateArtifactWith();

			expect(result.content).toBe(FINAL_DOCUMENT);
		});

		it("does not run without a block, whatever Main says", async () => {
			agentStreams([finalValues(ECHOING_DOCUMENT)]);

			const result = await generateArtifactWith();

			expect(result.content).toBe(ECHOING_DOCUMENT);
		});
	});

	describe("with the real builder", () => {
		const CURRENT_MAP = buildSectionMap(FINAL_DOCUMENT);
		const CURRENT_SCOPE = CURRENT_MAP.sections.find(
			(section) => section.headingText === "Scope",
		);
		/** The Scope section as it read before someone edited it. */
		const EARLIER_SCOPE = buildSectionMap(
			FINAL_DOCUMENT.replace("Three warehouses", "Two warehouses"),
		).sections.find((section) => section.headingText === "Scope");

		function answerRow(
			overrides: Partial<{
				kind: "CONFIRMED" | "RESPONDED";
				sectionHash: string;
				updatedAt: Date;
			}> = {},
		) {
			return {
				id: "response-1",
				documentId: "doc-1",
				stableKey: "k1:scanners",
				kind: "RESPONDED" as const,
				text: SETTLED_ANSWER,
				findingTitle: SETTLED_TITLE,
				answeredRunId: "analysis-1",
				sectionKey: CURRENT_SCOPE?.key ?? "",
				sectionHash: CURRENT_SCOPE?.proseHash ?? "",
				authorId: "user-editor",
				version: 1,
				createdAt: new Date("2026-10-01T10:00:00Z"),
				updatedAt: new Date("2026-10-01T10:00:00Z"),
				...overrides,
			};
		}

		const MEMBERS = new Set(["user-1", "user-editor"]);
		let loggerSpies: Array<ReturnType<typeof vi.spyOn>> = [];

		beforeEach(async () => {
			const actual = await vi.importActual<
				typeof import("../../lib/proposal-artifact/settled-decisions")
			>("../../lib/proposal-artifact/settled-decisions");
			mocks.buildSettledDecisionsBlock.mockImplementation(
				actual.buildSettledDecisionsBlock,
			);
			agentStreams([finalValues(FINAL_DOCUMENT)]);
			mocks.projectDocument.findFirst.mockResolvedValue({
				type: "PROPOSAL",
				content: FINAL_DOCUMENT,
				project: { organizationId: "org-1", deletedAt: null },
			});
			mocks.isFeatureEnabled.mockResolvedValue(true);
			mocks.isOrganizationMember.mockImplementation(
				async (userId: string, organizationId: string) =>
					organizationId === "org-1" && MEMBERS.has(userId),
			);
			mocks.authorMaySettleDecisions.mockImplementation(
				async (
					userId: string,
					_projectId: string,
					organizationId: string,
				) => organizationId === "org-1" && MEMBERS.has(userId),
			);
			mocks.listResponsesForDocument.mockResolvedValue([answerRow()]);
			mocks.getAnalysisForCurrentContent.mockResolvedValue({
				run: {
					id: "analysis-1",
					createdAt: new Date("2026-09-30T09:00:00Z"),
					findings: [],
				},
				isStale: false,
				newerRun: null,
			});
			loggerSpies = (["info", "warn", "error", "debug"] as const).map(
				(level) => vi.spyOn(logger, level).mockImplementation(() => {}),
			);
		});

		afterEach(() => {
			// Neither the builder nor the activity logged an answer or a title.
			const logged = JSON.stringify(
				loggerSpies.map((spy) => spy.mock.calls),
			);
			expect(logged).not.toContain("scanners");
			expect(activityLogText()).not.toContain("scanners");
			for (const spy of loggerSpies) {
				spy.mockRestore();
			}
		});

		it("carries a member's standing answer into the prompt", async () => {
			await generateArtifactWith();

			const message = userMessage();
			expect(message.startsWith(`${BOUND_PROMPT_MESSAGE}\n\n`)).toBe(
				true,
			);
			expect(message).toContain(SETTLED_DECISIONS_OPEN);
			expect(message).toContain(SETTLED_ANSWER);
		});

		it("puts no answer and no marker in the prompt a project guest starts", async () => {
			mocks.isOrganizationMember.mockImplementation(
				async (userId: string) => userId !== "user-1",
			);

			const result = await generateArtifactWith();

			expect(userMessage()).toBe(BOUND_PROMPT_MESSAGE);
			expect(userMessage()).not.toContain(SETTLED_DECISIONS_MARKER);
			expect(userMessage()).not.toContain("scanners");
			expect(mocks.listResponsesForDocument).not.toHaveBeenCalled();
			expect(result.content).toBe(FINAL_DOCUMENT);
		});

		it("leaves out an answer whose section changed until a member confirms it again", async () => {
			mocks.listResponsesForDocument.mockResolvedValue([
				answerRow({ sectionHash: EARLIER_SCOPE?.proseHash ?? "" }),
			]);

			await generateArtifactWith();

			expect(userMessage()).toBe(BOUND_PROMPT_MESSAGE);

			// Confirmed again against the section as it reads now.
			mocks.listResponsesForDocument.mockResolvedValue([
				answerRow({
					kind: "CONFIRMED",
					sectionHash: CURRENT_SCOPE?.proseHash ?? "",
					updatedAt: new Date("2026-10-02T09:00:00Z"),
				}),
			]);

			await generateArtifactWith();

			expect(userMessage(1)).toContain(SETTLED_ANSWER);
		});

		it("generates as today when the builder cannot read the document", async () => {
			mocks.projectDocument.findFirst.mockRejectedValue(
				Object.assign(new Error("Connection pool timeout"), {
					code: "P2024",
				}),
			);

			const result = await generateArtifactWith();

			expect(userMessage()).toBe(BOUND_PROMPT_MESSAGE);
			expect(result.content).toBe(FINAL_DOCUMENT);
		});
	});
});

// -----------------------------------------------------------------------------
// Artifact mode: live sections while the agent streams
// -----------------------------------------------------------------------------

/** A preview cut mid-way through the second section. */
const PREVIEW_ONE = `${SECTION_ONE}\n\n## Scope\n\nThree ware`;
/** A preview cut mid-way through the third section. */
const PREVIEW_TWO = `${SECTION_ONE}\n\n${SECTION_TWO}\n\n## Timeline\n\nTwel`;
const SECTIONS_ONE = SECTION_ONE;
const SECTIONS_TWO = `${SECTION_ONE}\n\n${SECTION_TWO}`;
/** The final write once the stream has ended: every section, trimmed. */
const SECTIONS_ALL = `${SECTIONS_TWO}\n\n${SECTION_THREE}`;

/**
 * An agent stream whose chunks arrive at the given offsets, in milliseconds
 * of wall-clock time from the start. Only `Date` is faked: the stream
 * timeout and heartbeat timers stay real.
 */
function agentStreamsAt(chunks: Array<[number, StreamChunk]>) {
	vi.useFakeTimers({ toFake: ["Date"] });
	const start = Date.now();
	mocks.runsStream.mockImplementation(() =>
		(async function* () {
			for (const [at, chunk] of chunks) {
				vi.setSystemTime(start + at);
				yield chunk;
			}
		})(),
	);
}

/** The `content` of every live write, in order. */
function liveWrites(): string[] {
	return mocks.writeLiveSections.mock.calls.map(
		([input]) => (input as { content: string }).content,
	);
}

describe("artifact mode — live sections", () => {
	beforeEach(() => {
		promptLibraryRenders();
	});

	it("asks the agent for `values` and `updates` and passes an abort signal", async () => {
		agentStreams([finalValues(FINAL_DOCUMENT)]);

		await generateArtifact();

		const payload = streamPayload();
		expect(payload.streamMode).toEqual(["values", "updates"]);
		expect(payload.signal).toBeInstanceOf(AbortSignal);
	});

	it("claims the run for this attempt on entry", async () => {
		mocks.activityContext.mockReturnValue({
			info: { attempt: 2 },
			cancellationSignal: new AbortController().signal,
		});
		agentStreamsAt([
			[0, preview(PREVIEW_ONE)],
			[2_000, finalValues(FINAL_DOCUMENT)],
		]);

		await generateArtifact();

		expect(mocks.claimLiveAttempt).toHaveBeenCalledWith({
			documentId: "doc-1",
			runId: "run-2",
			attempt: 2,
		});
		expect(mocks.claimLiveAttempt.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.runsStream.mock.invocationCallOrder[0] ?? 0,
		);
		expect(mocks.writeLiveSections).toHaveBeenCalledWith({
			documentId: "doc-1",
			runId: "run-2",
			attempt: 2,
			content: SECTIONS_ONE,
		});
	});

	it("writes once per completed section: three previews across two headings make two writes, each a prefix of the final document, then the whole document once the stream ends", async () => {
		agentStreamsAt([
			[0, preview("## Executive Summary\n\nThe client")],
			[2_000, preview(PREVIEW_ONE)],
			[4_000, preview(PREVIEW_TWO)],
			[6_000, finalValues(FINAL_DOCUMENT)],
		]);

		const result = await generateArtifact();

		expect(liveWrites()).toEqual([
			SECTIONS_ONE,
			SECTIONS_TWO,
			SECTIONS_ALL,
		]);
		for (const written of liveWrites()) {
			expect(FINAL_DOCUMENT.startsWith(written)).toBe(true);
		}
		expect(result.content).toBe(FINAL_DOCUMENT);
	});

	it("shows the last section once the stream ends, though no heading follows it, with the same guards", async () => {
		agentStreamsAt([
			[0, preview(PREVIEW_TWO)],
			[2_000, finalValues(FINAL_DOCUMENT)],
		]);

		await generateArtifact();

		expect(liveWrites().at(-1)).toBe(SECTIONS_ALL);
		expect(mocks.writeLiveSections).toHaveBeenLastCalledWith({
			documentId: "doc-1",
			runId: "run-2",
			attempt: 1,
			content: SECTIONS_ALL,
		});
		// The page is nudged for it like for any live write.
		expect(mocks.emitDocumentChange).toHaveBeenCalledTimes(2);
	});

	it("writes the ended document even when the last preview was written moments before", async () => {
		agentStreamsAt([
			[0, preview(PREVIEW_TWO)],
			[200, finalValues(FINAL_DOCUMENT)],
		]);

		await generateArtifact();

		expect(liveWrites()).toEqual([SECTIONS_TWO, SECTIONS_ALL]);
	});

	it("writes the ended document as the save will store it, with an open fence closed", async () => {
		const unclosed =
			"## Executive Summary\n\nThe client.\n\n## Timeline\n\n```mermaid\ntimeline\n  Week 1 : Kickoff";
		agentStreams([finalValues(unclosed)]);

		await generateArtifact();

		expect(liveWrites()).toEqual([asSaved(`${unclosed}\n\`\`\``)]);
		expect(liveWrites()[0]?.endsWith("\n```")).toBe(true);
	});

	it("writes nothing more once the stream ends when the whole document is already written", async () => {
		agentStreamsAt([
			[0, preview(`${SECTIONS_ALL}\n\n## Next`)],
			[2_000, finalValues(`${SECTIONS_ALL}\n`)],
		]);

		await generateArtifact();

		expect(liveWrites()).toEqual([SECTIONS_ALL]);
	});

	it("writes at most once per 1.5 s window, then the newest finished sections", async () => {
		const writtenAt: number[] = [];
		mocks.writeLiveSections.mockImplementation(async () => {
			writtenAt.push(Date.now());
			return "written";
		});
		agentStreamsAt([
			[0, preview(PREVIEW_ONE)],
			[500, preview(PREVIEW_TWO)],
			[1_000, preview(`${PREVIEW_TWO}ve weeks`)],
			[1_400, preview(`${SECTIONS_TWO}\n\n${SECTION_THREE}\n\n## Team`)],
			[1_600, preview(PREVIEW_TWO)],
			[1_700, finalValues(FINAL_DOCUMENT)],
		]);

		await generateArtifact();

		// Two previews in their windows, then the ended document, which the
		// throttle does not hold back.
		expect(liveWrites()).toEqual([
			SECTIONS_ONE,
			SECTIONS_TWO,
			SECTIONS_ALL,
		]);
		expect(
			(writtenAt[1] ?? 0) - (writtenAt[0] ?? 0),
		).toBeGreaterThanOrEqual(1_500);
	});

	it("writes a preview that shrank", async () => {
		agentStreamsAt([
			[0, preview(PREVIEW_TWO)],
			[2_000, preview(PREVIEW_ONE)],
			[4_000, finalValues(FINAL_DOCUMENT)],
		]);

		await generateArtifact();

		expect(liveWrites()).toEqual([
			SECTIONS_TWO,
			SECTIONS_ONE,
			SECTIONS_ALL,
		]);
	});

	it("does not write a preview that did not change", async () => {
		agentStreamsAt([
			[0, preview(PREVIEW_ONE)],
			[2_000, preview(`${PREVIEW_ONE}houses`)],
			[4_000, finalValues(FINAL_DOCUMENT)],
		]);

		await generateArtifact();

		expect(liveWrites()).toEqual([SECTIONS_ONE, SECTIONS_ALL]);
	});

	it("writes the sections as the save will store them", async () => {
		// Doubled tilde-quote runs: an artifact the save repairs.
		const damaged =
			"## Executive Summary\n\nThe client asked to ~“~“modernize~”~” picking.";
		expect(asSaved(damaged)).not.toBe(damaged);
		agentStreamsAt([
			[0, preview(`${damaged}\n\n## Scope\n\nThree`)],
			[2_000, finalValues(FINAL_DOCUMENT)],
		]);

		await generateArtifact();

		expect(liveWrites()).toEqual([asSaved(damaged), SECTIONS_ALL]);
	});

	it("nudges the page after each write, shaped like any document update", async () => {
		agentStreamsAt([
			[0, preview(PREVIEW_ONE)],
			[2_000, finalValues(FINAL_DOCUMENT)],
		]);

		await generateArtifact();

		// One for the preview, one for the ended document.
		expect(mocks.emitDocumentChange).toHaveBeenCalledTimes(2);
		const [payload] = mocks.emitDocumentChange.mock.calls[0] ?? [];
		expect(payload).toEqual({
			projectId: "project-1",
			documentId: "doc-1",
			action: "updated",
			userId: "user-1",
			userName: "Fabric",
			documentType: "PROPOSAL",
		});
		expect(mocks.emitDocumentChange.mock.calls[1]?.[0]).toEqual(payload);
		const { documentChangeSchema } = await vi.importActual<
			typeof import("@repo/utils/realtime-emit")
		>("@repo/utils/realtime-emit");
		expect(documentChangeSchema.safeParse(payload).success).toBe(true);
		for (const [
			index,
			nudgedAt,
		] of mocks.emitDocumentChange.mock.invocationCallOrder.entries()) {
			expect(nudgedAt).toBeGreaterThan(
				mocks.writeLiveSections.mock.invocationCallOrder[index] ?? 0,
			);
		}
	});

	it("stops writing after a superseded write and still returns the final content", async () => {
		mocks.writeLiveSections.mockResolvedValueOnce("superseded");
		agentStreamsAt([
			[0, preview(PREVIEW_ONE)],
			[2_000, preview(PREVIEW_TWO)],
			[4_000, finalValues(FINAL_DOCUMENT)],
		]);

		const result = await generateArtifact();

		// Not even the ended document: a newer owner has the preview.
		expect(mocks.writeLiveSections).toHaveBeenCalledTimes(1);
		expect(mocks.emitDocumentChange).not.toHaveBeenCalled();
		expect(result.content).toBe(FINAL_DOCUMENT);
	});

	it("writes nothing live when a later attempt already claimed the run", async () => {
		mocks.claimLiveAttempt.mockResolvedValue("superseded");
		agentStreamsAt([
			[0, preview(PREVIEW_ONE)],
			[2_000, preview(PREVIEW_TWO)],
			[4_000, finalValues(FINAL_DOCUMENT)],
		]);

		const result = await generateArtifact();

		expect(mocks.writeLiveSections).not.toHaveBeenCalled();
		expect(result.content).toBe(FINAL_DOCUMENT);
	});

	it("generates without live sections when the claim fails", async () => {
		mocks.claimLiveAttempt.mockRejectedValue(
			Object.assign(new Error("Can't reach database server"), {
				code: "P1001",
			}),
		);
		agentStreamsAt([
			[0, preview(PREVIEW_ONE)],
			[2_000, finalValues(FINAL_DOCUMENT)],
		]);

		const result = await generateArtifact();

		expect(mocks.writeLiveSections).not.toHaveBeenCalled();
		expect(result.content).toBe(FINAL_DOCUMENT);
	});

	it("generates without live sections outside an activity", async () => {
		mocks.activityContext.mockImplementation(() => {
			throw new Error("Activity context not initialized");
		});
		agentStreamsAt([
			[0, preview(PREVIEW_ONE)],
			[2_000, finalValues(FINAL_DOCUMENT)],
		]);

		const result = await generateArtifact();

		expect(mocks.claimLiveAttempt).not.toHaveBeenCalled();
		expect(mocks.writeLiveSections).not.toHaveBeenCalled();
		expect(result.content).toBe(FINAL_DOCUMENT);
	});

	it("never fails the generation over a live write, logs only ids and a code, and tries again in the next window", async () => {
		mocks.writeLiveSections.mockRejectedValueOnce(
			Object.assign(
				new Error(
					"deadlock while writing: The client modernizes picking.",
				),
				{ code: "P2034" },
			),
		);
		agentStreamsAt([
			[0, preview(PREVIEW_ONE)],
			[2_000, preview(PREVIEW_TWO)],
			[4_000, finalValues(FINAL_DOCUMENT)],
		]);

		const result = await generateArtifact();

		expect(result.content).toBe(FINAL_DOCUMENT);
		expect(liveWrites()).toEqual([
			SECTIONS_ONE,
			SECTIONS_TWO,
			SECTIONS_ALL,
		]);
		expect(activityLogger.warn).toHaveBeenCalledWith(
			"Could not write live sections",
			{
				projectId: "project-1",
				documentId: "doc-1",
				liveRunId: "run-2",
				attempt: 1,
				error: "P2034",
			},
		);
		expect(
			JSON.stringify(vi.mocked(activityLogger.warn).mock.calls),
		).not.toContain("modernizes");
	});
});

// -----------------------------------------------------------------------------
// Artifact mode: a live preview checked against settled decisions (Fizzy #2946)
// -----------------------------------------------------------------------------

/** A finished Scope section that repeats the settled answer. */
const ECHOING_SCOPE = `## Scope\n\nThree warehouses in the first phase. ${SETTLED_ANSWER}.`;
/** A preview cut in the third section, after the echoing Scope finished. */
const ECHOING_PREVIEW = `${SECTION_ONE}\n\n${ECHOING_SCOPE}\n\n## Timeline\n\nTwel`;
const ECHOING_SECTIONS = `${SECTION_ONE}\n\n${ECHOING_SCOPE}`;
const ECHOING_MAIN = `${ECHOING_SECTIONS}\n\n${SECTION_THREE}\n`;

/** The texts the echo check was asked about, in order. */
function echoChecked(): string[] {
	return echoChecks().map((input) => input.mainText);
}

describe("artifact mode — a live preview that repeats a settled decision", () => {
	beforeEach(() => {
		promptLibraryRenders();
		projectOwnedBy("org-1");
	});

	it("never writes it: the preview is cleared, the stream aborted, and the run fails non-retryably with a text-free message", async () => {
		mocks.buildSettledDecisionsBlock.mockResolvedValue(settledBlock());
		agentStreamsAt([
			[0, preview(PREVIEW_ONE)],
			[2_000, preview(ECHOING_PREVIEW)],
			[4_000, finalValues(ECHOING_MAIN)],
		]);

		const error = await failureOf(generateArtifactWith());

		expect(error).toBeInstanceOf(ApplicationFailure);
		const failure = error as ApplicationFailure;
		expect(failure.type).toBe(RESPONSE_ECHOED);
		expect(failure.nonRetryable).toBe(true);
		expect(failure.message).toBe(RESPONSE_ECHOED_MESSAGE);
		expect(failure.message).not.toContain("scanners");
		// Only the clean first section was ever written live.
		expect(liveWrites()).toEqual([SECTIONS_ONE]);
		expect(echoChecked()).toContain(ECHOING_SECTIONS);
		// Then the preview is dropped, and nothing is written after it.
		expect(mocks.clearLiveContent).toHaveBeenCalledTimes(1);
		expect(mocks.clearLiveContent).toHaveBeenCalledWith({
			documentId: "doc-1",
			runId: "run-2",
			attempt: 1,
		});
		expect(
			mocks.clearLiveContent.mock.invocationCallOrder[0],
		).toBeGreaterThan(
			mocks.writeLiveSections.mock.invocationCallOrder[0] ?? 0,
		);
		expect((streamPayload().signal as AbortSignal).aborted).toBe(true);
		// No fallback stands in for the refused run.
		expect(mocks.streamText).not.toHaveBeenCalled();
		// Ids, counts and the code only.
		expect(activityLogger.warn).toHaveBeenCalledWith(
			"Live preview repeated a settled answer's wording; not writing it",
			{
				projectId: "project-1",
				documentId: "doc-1",
				liveRunId: "run-2",
				attempt: 1,
				step: "offer",
				echoedResponses: 1,
				echoedTitles: 0,
				echoedKeys: [SETTLED_KEY],
				error: RESPONSE_ECHOED,
			},
		);
		expect(activityLogText()).not.toContain("scanners");
		expect(activityLogText()).not.toContain("Three warehouses");
		expect(activityLogger.info).not.toHaveBeenCalledWith(
			"Document generation completed successfully",
			expect.anything(),
		);
	});

	it("writes clean previews exactly as a run that carried nothing, checking each before it is written", async () => {
		mocks.buildSettledDecisionsBlock.mockResolvedValue(settledBlock());
		agentStreamsAt([
			[0, preview(PREVIEW_ONE)],
			[2_000, preview(PREVIEW_TWO)],
			[4_000, finalValues(FINAL_DOCUMENT)],
		]);

		const result = await generateArtifactWith();

		expect(result.content).toBe(FINAL_DOCUMENT);
		expect(liveWrites()).toEqual([
			SECTIONS_ONE,
			SECTIONS_TWO,
			SECTIONS_ALL,
		]);
		// Each live write, then the final Main.
		expect(echoChecked()).toEqual([
			SECTIONS_ONE,
			SECTIONS_TWO,
			SECTIONS_ALL,
			FINAL_DOCUMENT,
		]);
		expect(mocks.clearLiveContent).not.toHaveBeenCalled();
		expect(activityLogger.info).toHaveBeenCalledWith(
			"Document generation completed successfully",
			expect.objectContaining({ projectId: "project-1" }),
		);
	});

	it("writes a preview whose wording the supplied context also holds", async () => {
		mocks.buildSettledDecisionsBlock.mockResolvedValue(settledBlock());
		agentStreamsAt([
			[0, preview(ECHOING_PREVIEW)],
			[2_000, finalValues(ECHOING_MAIN)],
		]);

		const result = await generateArtifactWith({
			contexts: [`Site survey notes. ${SETTLED_ANSWER}.`],
		});

		expect(result.content).toBe(ECHOING_MAIN);
		expect(liveWrites()).toEqual([
			ECHOING_SECTIONS,
			`${ECHOING_SECTIONS}\n\n${SECTION_THREE}`,
		]);
	});

	it("writes a preview whose wording the project's description also holds", async () => {
		projectOwnedBy("org-1", {
			description: `Pilot terms. ${SETTLED_ANSWER}.`,
		});
		mocks.buildSettledDecisionsBlock.mockResolvedValue(settledBlock());
		agentStreamsAt([
			[0, preview(ECHOING_PREVIEW)],
			[2_000, finalValues(ECHOING_MAIN)],
		]);

		const result = await generateArtifactWith();

		expect(result.content).toBe(ECHOING_MAIN);
		expect(liveWrites()).toEqual([
			ECHOING_SECTIONS,
			`${ECHOING_SECTIONS}\n\n${SECTION_THREE}`,
		]);
		// Every preview and the final Main were checked against it.
		for (const input of echoChecks()) {
			expect(input.sourceContext).toEqual(
				expect.arrayContaining([
					SUPPLIED_CONTEXT,
					`Pilot terms. ${SETTLED_ANSWER}.`,
				]),
			);
		}
		expect(echoChecked()).toEqual([
			ECHOING_SECTIONS,
			`${ECHOING_SECTIONS}\n\n${SECTION_THREE}`,
			ECHOING_MAIN,
		]);
	});

	it("writes a preview whose wording the run's own instructions also hold", async () => {
		const instructions = `Make sure the proposal says plainly that ${SETTLED_ANSWER}.`;
		mocks.buildSettledDecisionsBlock.mockResolvedValue(settledBlock());
		agentStreamsAt([
			[0, preview(ECHOING_PREVIEW)],
			[2_000, finalValues(ECHOING_MAIN)],
		]);

		const result = await generateArtifactWith({ prompt: instructions });

		expect(result.content).toBe(ECHOING_MAIN);
		expect(liveWrites()).toEqual([
			ECHOING_SECTIONS,
			`${ECHOING_SECTIONS}\n\n${SECTION_THREE}`,
		]);
		expect(echoChecked()).toEqual([
			ECHOING_SECTIONS,
			`${ECHOING_SECTIONS}\n\n${SECTION_THREE}`,
			ECHOING_MAIN,
		]);
		expect(mocks.clearLiveContent).not.toHaveBeenCalled();
		expect(activityLogText()).not.toContain("scanners");
	});

	it("writes every preview as today and checks none when nothing was carried", async () => {
		agentStreamsAt([
			[0, preview(PREVIEW_ONE)],
			[2_000, preview(ECHOING_PREVIEW)],
			[4_000, finalValues(ECHOING_MAIN)],
		]);

		const result = await generateArtifactWith();

		expect(result.content).toBe(ECHOING_MAIN);
		expect(liveWrites()).toEqual([
			SECTIONS_ONE,
			ECHOING_SECTIONS,
			`${ECHOING_SECTIONS}\n\n${SECTION_THREE}`,
		]);
		expect(buildEchoGuard).not.toHaveBeenCalled();
		expect(checkEcho).not.toHaveBeenCalled();
	});
});

// -----------------------------------------------------------------------------
// Artifact mode: timeout, cancellation and the gateway fallback
// -----------------------------------------------------------------------------

/** The gateway fallback produces `text` and finishes normally. */
function fallbackProduces(text: string) {
	mocks.streamText.mockImplementation(() => ({
		textStream: (async function* () {
			yield text;
		})(),
		finishReason: Promise.resolve("stop"),
		usage: Promise.resolve({ outputTokens: 100 }),
	}));
}

/** Resolves when `signal` aborts; rejects the way a fetch body does. */
function abortOf(signal: AbortSignal): Promise<never> {
	return new Promise((_, reject) => {
		const fail = () =>
			reject(
				new DOMException("This operation was aborted", "AbortError"),
			);
		if (signal.aborted) {
			fail();
		} else {
			signal.addEventListener("abort", fail, { once: true });
		}
	});
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const FALLBACK_DOCUMENT = "## Executive Summary\n\nWritten by the fallback.";

/** The agent stream timeout these tests run with, in real milliseconds. */
const STREAM_TIMEOUT_MS = 100;
/** Comfortably past {@link STREAM_TIMEOUT_MS}, so the order never races. */
const WELL_PAST_TIMEOUT_MS = 250;

describe("artifact mode — timeout, cancellation and fallback", () => {
	const previousTimeout = process.env.AGENT_STREAM_TIMEOUT_MS;

	beforeEach(() => {
		promptLibraryRenders();
		fallbackProduces(FALLBACK_DOCUMENT);
		process.env.AGENT_STREAM_TIMEOUT_MS = String(STREAM_TIMEOUT_MS);
	});

	afterEach(() => {
		if (previousTimeout === undefined) {
			delete process.env.AGENT_STREAM_TIMEOUT_MS;
		} else {
			process.env.AGENT_STREAM_TIMEOUT_MS = previousTimeout;
		}
	});

	it("on a stream timeout aborts the stream, clears the preview, and falls back without writing live", async () => {
		let streamSignal: AbortSignal | undefined;
		mocks.runsStream.mockImplementation(
			(
				_thread: unknown,
				_assistant: unknown,
				payload: { signal: AbortSignal },
			) => {
				streamSignal = payload.signal;
				return (async function* () {
					yield preview(PREVIEW_ONE);
					await abortOf(payload.signal);
				})();
			},
		);

		const result = await generateArtifact();

		expect(streamSignal?.aborted).toBe(true);
		expect(liveWrites()).toEqual([SECTIONS_ONE]);
		expect(mocks.clearLiveContent).toHaveBeenCalledTimes(1);
		// Scoped to this attempt: an attempt Temporal gave up on, finishing
		// late, must not erase the preview its retry is writing.
		expect(mocks.clearLiveContent).toHaveBeenCalledWith({
			documentId: "doc-1",
			runId: "run-2",
			attempt: 1,
		});
		expect(
			mocks.clearLiveContent.mock.invocationCallOrder[0],
		).toBeGreaterThan(
			mocks.writeLiveSections.mock.invocationCallOrder[0] ?? 0,
		);
		expect(mocks.streamText).toHaveBeenCalledTimes(1);
		expect(result.content).toBe(FALLBACK_DOCUMENT);
		// The page is told the preview is gone.
		expect(mocks.emitDocumentChange).toHaveBeenCalledTimes(2);
	});

	it("writes no preview that arrives after the timeout", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const start = Date.now();
		mocks.runsStream.mockImplementation(() =>
			(async function* () {
				yield preview(PREVIEW_ONE);
				// A stream that ignores the abort and keeps sending.
				await sleep(WELL_PAST_TIMEOUT_MS);
				vi.setSystemTime(start + 5_000);
				yield preview(PREVIEW_TWO);
				yield finalValues(FINAL_DOCUMENT);
			})(),
		);

		const result = await generateArtifact();
		await sleep(WELL_PAST_TIMEOUT_MS + STREAM_TIMEOUT_MS);

		expect(result.content).toBe(FALLBACK_DOCUMENT);
		expect(liveWrites()).toEqual([SECTIONS_ONE]);
		expect(mocks.clearLiveContent).toHaveBeenCalledTimes(1);
	});

	it("clears the preview only after a write in flight at the timeout has settled", async () => {
		const order: string[] = [];
		mocks.writeLiveSections.mockImplementation(async () => {
			order.push("write started");
			await sleep(WELL_PAST_TIMEOUT_MS);
			order.push("write settled");
			return "written";
		});
		mocks.clearLiveContent.mockImplementation(async () => {
			order.push("cleared");
			return "written";
		});
		mocks.runsStream.mockImplementation(
			(
				_thread: unknown,
				_assistant: unknown,
				payload: { signal: AbortSignal },
			) =>
				(async function* () {
					yield preview(PREVIEW_ONE);
					await abortOf(payload.signal);
				})(),
		);

		await generateArtifact();

		expect(order).toEqual(["write started", "write settled", "cleared"]);
	});

	it("clears the preview when the stream fails and the gateway takes over", async () => {
		process.env.AGENT_STREAM_TIMEOUT_MS = "300000";
		mocks.runsStream.mockImplementation(() =>
			(async function* () {
				yield preview(PREVIEW_ONE);
				throw new Error("socket hang up");
			})(),
		);

		const result = await generateArtifact();

		expect(liveWrites()).toEqual([SECTIONS_ONE]);
		expect(mocks.clearLiveContent).toHaveBeenCalledTimes(1);
		expect(mocks.clearLiveContent.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.streamText.mock.invocationCallOrder[0] ?? 0,
		);
		expect(result.content).toBe(FALLBACK_DOCUMENT);
	});

	it("clears the preview when the agent ends without a document", async () => {
		process.env.AGENT_STREAM_TIMEOUT_MS = "300000";
		agentStreams([preview(PREVIEW_ONE)]);

		const result = await generateArtifact();

		expect(liveWrites()).toEqual([SECTIONS_ONE]);
		expect(mocks.clearLiveContent).toHaveBeenCalledTimes(1);
		expect(result.content).toBe(FALLBACK_DOCUMENT);
	});

	it("leaves the preview to a newer owner when this attempt was superseded", async () => {
		mocks.claimLiveAttempt.mockResolvedValue("superseded");
		mocks.runsStream.mockImplementation(
			(
				_thread: unknown,
				_assistant: unknown,
				payload: { signal: AbortSignal },
			) =>
				(async function* () {
					yield preview(PREVIEW_ONE);
					await abortOf(payload.signal);
				})(),
		);

		await generateArtifact();

		expect(mocks.writeLiveSections).not.toHaveBeenCalled();
		expect(mocks.clearLiveContent).not.toHaveBeenCalled();
	});

	it("on cancellation aborts the stream, writes nothing more, and does not fall back", async () => {
		process.env.AGENT_STREAM_TIMEOUT_MS = "300000";
		const cancellation = new AbortController();
		mocks.activityContext.mockReturnValue({
			info: { attempt: 1 },
			cancellationSignal: cancellation.signal,
		});
		let streamSignal: AbortSignal | undefined;
		mocks.runsStream.mockImplementation(
			(
				_thread: unknown,
				_assistant: unknown,
				payload: { signal: AbortSignal },
			) => {
				streamSignal = payload.signal;
				return (async function* () {
					yield preview(PREVIEW_ONE);
					cancellation.abort();
					await abortOf(payload.signal);
					yield preview(PREVIEW_TWO);
				})();
			},
		);

		const error = await failureOf(generateArtifact());

		expect(error).toBeInstanceOf(Error);
		expect(streamSignal?.aborted).toBe(true);
		expect(liveWrites()).toEqual([SECTIONS_ONE]);
		expect(mocks.streamText).not.toHaveBeenCalled();
		expect(mocks.recordAuditDurable).not.toHaveBeenCalled();
	});
});

// -----------------------------------------------------------------------------
// Artifact mode: a stalled database or realtime call never holds the run up
// -----------------------------------------------------------------------------

/** How long the run waits for the live preview to settle. */
const SETTLE_TIMEOUT_MS = 10_000;

/** A call that never settles: a stalled database or realtime connection. */
function stalls(): Promise<never> {
	return new Promise<never>(() => {});
}

function expectSettleTimeout(step: "clear" | "stop" | "finish") {
	expect(activityLogger.warn).toHaveBeenCalledWith(
		"Live sections did not settle in time; carrying on without them",
		{
			projectId: "project-1",
			documentId: "doc-1",
			liveRunId: "run-2",
			attempt: 1,
			step,
			error: "TIMEOUT",
		},
	);
}

describe("artifact mode — a stalled preview never holds the run up", () => {
	const previousTimeout = process.env.AGENT_STREAM_TIMEOUT_MS;

	beforeEach(() => {
		promptLibraryRenders();
		fallbackProduces(FALLBACK_DOCUMENT);
		process.env.AGENT_STREAM_TIMEOUT_MS = "300000";
		vi.useFakeTimers();
	});

	afterEach(() => {
		if (previousTimeout === undefined) {
			delete process.env.AGENT_STREAM_TIMEOUT_MS;
		} else {
			process.env.AGENT_STREAM_TIMEOUT_MS = previousTimeout;
		}
	});

	it("falls back after a bounded wait when clearing the preview stalls, heartbeating meanwhile", async () => {
		mocks.clearLiveContent.mockImplementation(stalls);
		mocks.runsStream.mockImplementation(() =>
			(async function* () {
				yield preview(PREVIEW_ONE);
				throw new Error("socket hang up");
			})(),
		);

		const pending = generateArtifact();
		await vi.advanceTimersByTimeAsync(SETTLE_TIMEOUT_MS);
		const result = await pending;

		expect(result.content).toBe(FALLBACK_DOCUMENT);
		expect(mocks.clearLiveContent).toHaveBeenCalledTimes(1);
		expect(mocks.streamText).toHaveBeenCalledTimes(1);
		expect(heartbeat).toHaveBeenCalledWith(
			expect.objectContaining({ phase: "live_sections" }),
		);
		expectSettleTimeout("clear");
	});

	it("fails a cancelled attempt after a bounded wait for a write that stalled", async () => {
		process.env.AGENT_STREAM_TIMEOUT_MS = "1000";
		const cancellation = new AbortController();
		mocks.activityContext.mockReturnValue({
			info: { attempt: 1 },
			cancellationSignal: cancellation.signal,
		});
		mocks.writeLiveSections.mockImplementation(() => {
			cancellation.abort();
			return stalls();
		});
		agentStreams([preview(PREVIEW_ONE), finalValues(FINAL_DOCUMENT)]);

		const pending = failureOf(generateArtifact());
		await vi.advanceTimersByTimeAsync(1_000 + SETTLE_TIMEOUT_MS);
		const error = await pending;

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toMatch(/timeout/);
		expect(mocks.streamText).not.toHaveBeenCalled();
		expectSettleTimeout("stop");
	});

	it("returns the document after a bounded wait when the final write stalls", async () => {
		mocks.writeLiveSections.mockImplementation(stalls);
		agentStreams([finalValues(FINAL_DOCUMENT)]);

		const pending = generateArtifact();
		await vi.advanceTimersByTimeAsync(SETTLE_TIMEOUT_MS);
		const result = await pending;

		expect(result.content).toBe(FINAL_DOCUMENT);
		expect(liveWrites()).toEqual([SECTIONS_ALL]);
		expectSettleTimeout("finish");
	});

	it("keeps streaming past a nudge that stalls", async () => {
		mocks.emitDocumentChange.mockImplementation(stalls);
		agentStreams([preview(PREVIEW_ONE), finalValues(FINAL_DOCUMENT)]);

		const pending = generateArtifact();
		await vi.advanceTimersByTimeAsync(3 * SETTLE_TIMEOUT_MS);
		const result = await pending;

		expect(result.content).toBe(FINAL_DOCUMENT);
		expect(liveWrites()).toEqual([SECTIONS_ONE, SECTIONS_ALL]);
		expect(activityLogger.warn).toHaveBeenCalledWith(
			"Could not nudge the page about live sections",
			{
				projectId: "project-1",
				documentId: "doc-1",
				liveRunId: "run-2",
				attempt: 1,
				error: "TIMEOUT",
			},
		);
	});
});

// -----------------------------------------------------------------------------
// Artifact mode: the run-guarded save, version and status writes, against an
// in-memory document
// -----------------------------------------------------------------------------

type LiveDocument = {
	status: string;
	content: string;
	version: number;
	liveRunId: string | null;
	liveContent: string | null;
	[column: string]: unknown;
};

type LiveVersionRow = {
	id: string;
	version: number;
	content: string;
	changeDescription: string | null;
	changedBy: string | null;
	promptVersionId: string | null;
};

type LiveState = { document: LiveDocument; versions: LiveVersionRow[] };

type LiveStore = LiveState & {
	/**
	 * A writer that commits, in its own transaction, between this
	 * transaction's read and its conditional update: a rollback here does not
	 * undo it.
	 */
	beforeConditionalUpdate?: (state: LiveState) => void;
};

const DOCUMENT_FILTER_KEYS = new Set([
	"id",
	"version",
	"content",
	"liveRunId",
	"status",
]);
const VERSION_FILTER_KEYS = new Set([
	"documentId",
	"version",
	"content",
	"changedBy",
	"promptVersionId",
	"changeDescription",
]);

function documentMatches(
	document: LiveDocument,
	where: Record<string, unknown>,
): boolean {
	return Object.entries(where).every(([key, value]) => {
		if (!DOCUMENT_FILTER_KEYS.has(key)) {
			throw new Error(`The fake store does not filter on ${key}`);
		}
		if (key === "id") {
			return value === "doc-1";
		}
		if (value !== null && typeof value === "object") {
			const { in: oneOf, ...unsupported } = value as { in?: unknown[] };
			if (oneOf === undefined || Object.keys(unsupported).length > 0) {
				throw new Error(
					`The fake store cannot apply that filter to ${key}`,
				);
			}
			return oneOf.includes(document[key as keyof LiveDocument]);
		}
		return document[key as keyof LiveDocument] === value;
	});
}

function versionMatches(
	row: LiveVersionRow,
	where: Record<string, unknown>,
): boolean {
	return Object.entries(where).every(([key, condition]) => {
		if (!VERSION_FILTER_KEYS.has(key)) {
			throw new Error(`The fake store does not filter on ${key}`);
		}
		if (key === "documentId") {
			return condition === "doc-1";
		}
		const value = row[key as keyof LiveVersionRow];
		if (condition !== null && typeof condition === "object") {
			const {
				gte,
				lte,
				in: oneOf,
				...unsupported
			} = condition as { gte?: number; lte?: number; in?: unknown[] };
			if (Object.keys(unsupported).length > 0) {
				throw new Error(
					`The fake store cannot apply that filter to ${key}`,
				);
			}
			return (
				(gte === undefined || (value as number) >= gte) &&
				(lte === undefined || (value as number) <= lte) &&
				(oneOf === undefined || oneOf.includes(value))
			);
		}
		return value === condition;
	});
}

/**
 * One document and its version history behind the transaction client.
 * `$transaction` restores both when its callback throws, as Postgres rolls
 * back, so "nothing written" is asserted on state rather than on calls.
 */
function installLiveStore(store: LiveStore): LiveStore {
	let rollbackTo: LiveState | undefined;
	mocks.transaction.mockImplementation(
		async (fn: (client: typeof mocks.tx) => unknown) => {
			rollbackTo = structuredClone({
				document: store.document,
				versions: store.versions,
			});
			try {
				return await fn(mocks.tx);
			} catch (error) {
				store.document = rollbackTo.document;
				store.versions = rollbackTo.versions;
				throw error;
			} finally {
				rollbackTo = undefined;
			}
		},
	);
	mocks.tx.projectDocument.findUnique.mockImplementation(async () => ({
		...store.document,
	}));
	mocks.tx.projectDocument.updateMany.mockImplementation(
		async ({
			where,
			data,
		}: {
			where: Record<string, unknown>;
			data: Partial<LiveDocument>;
		}) => {
			const concurrentWriter = store.beforeConditionalUpdate;
			store.beforeConditionalUpdate = undefined;
			if (concurrentWriter) {
				concurrentWriter(store);
				if (rollbackTo) {
					concurrentWriter(rollbackTo);
				}
			}
			if (!documentMatches(store.document, where)) {
				return { count: 0 };
			}
			store.document = { ...store.document, ...data };
			return { count: 1 };
		},
	);
	mocks.tx.documentVersion.findFirst.mockImplementation(
		async ({
			where,
			orderBy,
		}: {
			where: Record<string, unknown>;
			orderBy?: { version: "asc" | "desc" };
		}) => {
			const rows = store.versions.filter((row) =>
				versionMatches(row, where),
			);
			if (orderBy?.version === "desc") {
				rows.sort((a, b) => b.version - a.version);
			}
			return rows[0] ?? null;
		},
	);
	mocks.tx.documentVersion.findUnique.mockImplementation(
		async ({ where }: { where: { id: string } }) => {
			const row = store.versions.find(({ id }) => id === where.id);
			return row ? { ...row } : null;
		},
	);
	mocks.tx.documentVersion.create.mockImplementation(
		async ({
			data,
		}: {
			data: Omit<LiveVersionRow, "id"> & { id?: string };
		}) => {
			if (
				data.id !== undefined &&
				store.versions.some(({ id }) => id === data.id)
			) {
				throw Object.assign(
					new Error("Unique constraint failed on the fields: (`id`)"),
					{ code: "P2002" },
				);
			}
			const row: LiveVersionRow = {
				id: data.id ?? `version-row-${data.version}`,
				version: data.version,
				content: data.content,
				changeDescription: data.changeDescription ?? null,
				changedBy: data.changedBy ?? null,
				promptVersionId: data.promptVersionId ?? null,
			};
			store.versions.push(row);
			return row;
		},
	);
	return store;
}

const OLD_MAIN = "## Executive Summary\n\nThe previous Main.";
const NEWER_MAIN = "## Executive Summary\n\nA newer run's Main.";

/** The document while run-2 generates over an earlier Main at version 3. */
function whileRunTwoGenerates(): LiveStore {
	return {
		document: {
			status: "GENERATING",
			content: OLD_MAIN,
			version: 3,
			liveRunId: "run-2",
			liveContent: SECTIONS_ONE,
		},
		versions: [
			{
				id: "version-row-1",
				version: 1,
				content: "## Executive Summary\n\nThe first Main.",
				changeDescription: "Initial version",
				changedBy: "user-1",
				promptVersionId: null,
			},
		],
	};
}

/** The same document after run-3 took it over and finished. */
function afterRunThreeFinished(): LiveStore {
	return {
		document: {
			status: "COMPLETE",
			content: NEWER_MAIN,
			version: 4,
			liveRunId: "run-3",
			liveContent: null,
		},
		versions: [],
	};
}

function saveForRunTwo(content: string = FINAL_DOCUMENT) {
	return saveProjectDocument("doc-1", content, "user-1", {
		liveRunId: "run-2",
	});
}

function versionForRunTwo(content: string = FINAL_DOCUMENT) {
	return createDocumentVersion("doc-1", content, "user-1", "pv-3", {
		liveRunId: "run-2",
	});
}

function expectStale(error: unknown) {
	expect(error).toBeInstanceOf(ApplicationFailure);
	const failure = error as ApplicationFailure;
	expect(failure.type).toBe("DOCUMENT_GENERATION_STALE");
	expect(failure.nonRetryable).toBe(true);
}

/** Nothing reached the unguarded client. */
function expectNoUnguardedWrites() {
	expect(mocks.projectDocument.update).not.toHaveBeenCalled();
	expect(mocks.documentVersion.create).not.toHaveBeenCalled();
}

describe("saveProjectDocument — guarded by the live run", () => {
	it("writes the body, completes the document and drops the preview, keeping the run token", async () => {
		const store = installLiveStore(whileRunTwoGenerates());

		await saveForRunTwo();

		expect(store.document).toMatchObject({
			content: asSaved(FINAL_DOCUMENT),
			status: "COMPLETE",
			version: 3,
			liveRunId: "run-2",
			liveContent: null,
		});
		// The pre-regeneration snapshot, inside the same transaction.
		expect(store.versions).toContainEqual(
			expect.objectContaining({
				version: 3,
				content: OLD_MAIN,
				changeDescription: "Pre-regeneration snapshot (auto)",
			}),
		);
		expect(mocks.transaction).toHaveBeenCalledTimes(1);
		expect(mocks.tx.projectDocument.updateMany).toHaveBeenCalledWith({
			where: { id: "doc-1", liveRunId: "run-2" },
			data: expect.objectContaining({ liveContent: null }),
		});
		expectNoUnguardedWrites();
	});

	it("refuses a superseded run's save as stale and leaves the newer Main", async () => {
		const store = installLiveStore(afterRunThreeFinished());
		const before = structuredClone({
			document: store.document,
			versions: store.versions,
		});

		expectStale(await failureOf(saveForRunTwo()));

		expect(store.document).toEqual(before.document);
		expect(store.versions).toEqual(before.versions);
		expect(mocks.tx.documentVersion.create).not.toHaveBeenCalled();
		expect(mocks.tx.projectDocument.updateMany).not.toHaveBeenCalled();
		expectNoUnguardedWrites();
	});

	it("rolls the snapshot back when a newer run takes over between the read and the update", async () => {
		const store = installLiveStore(whileRunTwoGenerates());
		const versionsBefore = structuredClone(store.versions);
		store.beforeConditionalUpdate = (state) => {
			state.document = {
				...state.document,
				liveRunId: "run-3",
				liveContent: null,
			};
		};

		expectStale(await failureOf(saveForRunTwo()));

		expect(mocks.tx.documentVersion.create).toHaveBeenCalledTimes(1);
		expect(store.versions).toEqual(versionsBefore);
		expect(store.document).toMatchObject({
			content: OLD_MAIN,
			liveRunId: "run-3",
		});
		expectNoUnguardedWrites();
	});

	it("succeeds without a second write when retried after its own commit", async () => {
		const store = installLiveStore(whileRunTwoGenerates());
		await saveForRunTwo();
		const committed = structuredClone({
			document: store.document,
			versions: store.versions,
		});
		vi.mocked(mocks.tx.projectDocument.updateMany).mockClear();

		await expect(saveForRunTwo()).resolves.toBeUndefined();

		expect(mocks.tx.projectDocument.updateMany).not.toHaveBeenCalled();
		expect(store.document).toEqual(committed.document);
		expect(store.versions).toEqual(committed.versions);
	});

	it("still completes the document when the regenerated text equals the text it replaces", async () => {
		const store = whileRunTwoGenerates();
		store.document = {
			...store.document,
			content: asSaved(FINAL_DOCUMENT),
			liveContent: null,
		};
		installLiveStore(store);

		await saveForRunTwo();

		expect(mocks.tx.projectDocument.updateMany).toHaveBeenCalledTimes(1);
		expect(store.document.status).toBe("COMPLETE");
	});

	it("applies the visual-slot baseline as well when both guards are given", async () => {
		const store = installLiveStore(whileRunTwoGenerates());

		await saveProjectDocument("doc-1", FINAL_DOCUMENT, "user-1", {
			baselineVersion: 3,
			liveRunId: "run-2",
		});

		expect(mocks.tx.projectDocument.updateMany).toHaveBeenCalledWith({
			where: { id: "doc-1", version: 3, liveRunId: "run-2" },
			data: expect.objectContaining({ liveContent: null }),
		});
		expect(store.document.content).toBe(asSaved(FINAL_DOCUMENT));
	});

	it("refuses as stale when the baseline moved, even though the run still owns the document", async () => {
		const store = whileRunTwoGenerates();
		store.document = { ...store.document, version: 4 };
		installLiveStore(store);
		const before = structuredClone(store.document);

		const error = await failureOf(
			saveProjectDocument("doc-1", FINAL_DOCUMENT, "user-1", {
				baselineVersion: 3,
				liveRunId: "run-2",
			}),
		);

		expectStale(error);
		expect((error as ApplicationFailure).message).toMatch(
			/changed while it was being regenerated/,
		);
		expect(store.document).toEqual(before);
	});

	it("keeps a person's save that lands during a slot-free run, between the read and the update", async () => {
		const store = installLiveStore(whileRunTwoGenerates());
		const personsEdit =
			"# Proposal\n\nA person's edit made while the run generated.";
		store.beforeConditionalUpdate = (state) => {
			// An ordinary editor save: new content, version moved on, and the
			// run token untouched, since only a run writes it.
			state.document = {
				...state.document,
				content: personsEdit,
				version: 4,
			};
		};

		expectStale(
			await failureOf(
				saveProjectDocument("doc-1", FINAL_DOCUMENT, "user-1", {
					baselineVersion: 3,
					liveRunId: "run-2",
				}),
			),
		);

		expect(store.document).toMatchObject({
			content: personsEdit,
			version: 4,
			liveRunId: "run-2",
		});
		expectNoUnguardedWrites();
	});

	describe("against the body it was planned against", () => {
		const PLANNED = {
			baselineVersion: 3,
			liveRunId: "run-2",
			baselineContentHash: contentIdentity(OLD_MAIN),
		};

		it("saves, with the body it read in the WHERE clause", async () => {
			const store = installLiveStore(whileRunTwoGenerates());

			await saveProjectDocument(
				"doc-1",
				FINAL_DOCUMENT,
				"user-1",
				PLANNED,
			);

			expect(mocks.tx.projectDocument.updateMany).toHaveBeenCalledWith({
				where: {
					id: "doc-1",
					version: 3,
					liveRunId: "run-2",
					content: OLD_MAIN,
				},
				data: expect.objectContaining({ liveContent: null }),
			});
			expect(store.document.content).toBe(asSaved(FINAL_DOCUMENT));
		});

		it("refuses as stale when the body changed without the version moving", async () => {
			// A rejected regeneration's fallback: the body rewritten in place,
			// the version left where it was.
			const store = whileRunTwoGenerates();
			const rewound =
				"# Proposal\n\nThe body a rejected regeneration put back.";
			store.document = { ...store.document, content: rewound };
			installLiveStore(store);
			const before = structuredClone(store.document);

			expectStale(
				await failureOf(
					saveProjectDocument(
						"doc-1",
						FINAL_DOCUMENT,
						"user-1",
						PLANNED,
					),
				),
			);

			expect(store.document).toEqual(before);
			expect(mocks.tx.projectDocument.updateMany).not.toHaveBeenCalled();
			expectNoUnguardedWrites();
		});

		it("keeps a same-version edit that lands between the read and the update", async () => {
			const store = installLiveStore(whileRunTwoGenerates());
			const versionsBefore = structuredClone(store.versions);
			const sameVersionEdit =
				"# Proposal\n\nAn edit that left the version number as it was.";
			store.beforeConditionalUpdate = (state) => {
				state.document = {
					...state.document,
					content: sameVersionEdit,
				};
			};

			expectStale(
				await failureOf(
					saveProjectDocument(
						"doc-1",
						FINAL_DOCUMENT,
						"user-1",
						PLANNED,
					),
				),
			);

			expect(store.document).toMatchObject({
				content: sameVersionEdit,
				version: 3,
				liveRunId: "run-2",
			});
			// The snapshot written before the update rolls back with it.
			expect(store.versions).toEqual(versionsBefore);
			expectNoUnguardedWrites();
		});
	});
});

describe("createDocumentVersion — guarded by the live run", () => {
	/** Right after run-2's save: its body is live, still at version 3. */
	function afterRunTwoSaved(): LiveStore {
		const store = whileRunTwoGenerates();
		store.document = {
			...store.document,
			status: "COMPLETE",
			content: asSaved(FINAL_DOCUMENT),
			liveContent: null,
		};
		store.versions.push({
			id: "version-row-3",
			version: 3,
			content: OLD_MAIN,
			changeDescription: "Pre-regeneration snapshot (auto)",
			changedBy: "user-1",
			promptVersionId: null,
		});
		return store;
	}

	/** The row id a run's version step writes: one row per run. */
	const RUN_TWO_ROW_ID = "proposal-run-run-2";

	/** A person's edit, saved through the editor after run-2's save. */
	const EDITED_MAIN = "## Executive Summary\n\nEdited by a person.";

	it("returns the version number and row id it wrote", async () => {
		const store = installLiveStore(afterRunTwoSaved());

		const created = await versionForRunTwo();

		expect(created).toEqual({ version: 4, versionId: RUN_TWO_ROW_ID });
		expect(store.document.version).toBe(4);
		expect(store.versions.at(-1)).toEqual({
			id: RUN_TWO_ROW_ID,
			version: 4,
			content: asSaved(FINAL_DOCUMENT),
			changeDescription: "Regenerated version",
			changedBy: "user-1",
			promptVersionId: "pv-3",
		});
		// The bump also requires the body this run saved.
		expect(mocks.tx.projectDocument.updateMany).toHaveBeenCalledWith({
			where: {
				id: "doc-1",
				content: asSaved(FINAL_DOCUMENT),
				liveRunId: "run-2",
			},
			data: { version: 4 },
		});
		expectNoUnguardedWrites();
	});

	it("versions this run's body though an older row holds the same body, author and prompt", async () => {
		const store = afterRunTwoSaved();
		store.versions.push({
			id: "version-row-2",
			version: 2,
			content: asSaved(FINAL_DOCUMENT),
			changeDescription: "Regenerated version",
			changedBy: "user-1",
			promptVersionId: "pv-3",
		});
		installLiveStore(store);

		const created = await versionForRunTwo();

		expect(created).toEqual({ version: 4, versionId: RUN_TWO_ROW_ID });
		expect(store.document.version).toBe(4);
		expect(store.versions.filter((row) => row.version === 4)).toEqual([
			expect.objectContaining({
				id: RUN_TWO_ROW_ID,
				content: asSaved(FINAL_DOCUMENT),
			}),
		]);
	});

	it("versions this run's body though the row at the live version holds the same body, author and prompt", async () => {
		// An earlier run wrote this exact text as version 3, and run-2
		// regenerated it word for word.
		const store = afterRunTwoSaved();
		store.versions = store.versions.map((row) =>
			row.version === 3
				? {
						...row,
						content: asSaved(FINAL_DOCUMENT),
						changeDescription: "Regenerated version",
						promptVersionId: "pv-3",
					}
				: row,
		);
		installLiveStore(store);

		const created = await versionForRunTwo();

		expect(created).toEqual({ version: 4, versionId: RUN_TWO_ROW_ID });
		expect(store.document.version).toBe(4);
	});

	it("still reports its committed row when a person edited after it, before the retry", async () => {
		const store = installLiveStore(afterRunTwoSaved());
		const first = await versionForRunTwo();
		store.document = {
			...store.document,
			content: EDITED_MAIN,
			version: 5,
		};

		await expect(versionForRunTwo()).resolves.toEqual(first);
		expect(
			store.versions.filter((row) => row.id === RUN_TWO_ROW_ID),
		).toHaveLength(1);
	});

	it("lets a racing attempt's duplicate row fail as an ordinary, retryable error", async () => {
		const store = installLiveStore(afterRunTwoSaved());
		// Another attempt of this run commits its row after this one looked.
		mocks.tx.documentVersion.findUnique.mockResolvedValueOnce(null);
		store.document = { ...store.document, version: 4 };
		store.versions.push({
			id: RUN_TWO_ROW_ID,
			version: 4,
			content: asSaved(FINAL_DOCUMENT),
			changeDescription: "Regenerated version",
			changedBy: "user-1",
			promptVersionId: "pv-3",
		});

		const error = await failureOf(versionForRunTwo());

		expect(error).not.toBeInstanceOf(ApplicationFailure);
		expect(error).toMatchObject({ code: "P2002" });
		// The retry finds that attempt's row.
		await expect(versionForRunTwo()).resolves.toEqual({
			version: 4,
			versionId: RUN_TWO_ROW_ID,
		});
	});

	describe("when Main changed after this run's save", () => {
		function expectSkipLogged() {
			expect(activityLogger.info).toHaveBeenCalledWith(
				"Document version skipped: the document changed after this run's save",
				{
					documentId: "doc-1",
					liveRunId: "run-2",
					code: "VERSION_SKIPPED_CONTENT_CHANGED",
				},
			);
			expect(activityLogger.error).not.toHaveBeenCalled();
			expect(
				JSON.stringify(vi.mocked(activityLogger.info).mock.calls),
			).not.toContain("Edited by a person");
		}

		it("skips the version without failing when a person edited and bumped the version", async () => {
			const store = afterRunTwoSaved();
			store.document = {
				...store.document,
				content: EDITED_MAIN,
				version: 4,
			};
			installLiveStore(store);
			const before = structuredClone({
				document: store.document,
				versions: store.versions,
			});

			await expect(versionForRunTwo()).resolves.toBeUndefined();

			expect(store.document).toEqual(before.document);
			expect(store.versions).toEqual(before.versions);
			expectSkipLogged();
			expectNoUnguardedWrites();
		});

		it("skips the version when the regeneration was rejected without a version bump", async () => {
			const store = afterRunTwoSaved();
			store.document = { ...store.document, content: OLD_MAIN };
			installLiveStore(store);
			const before = structuredClone({
				document: store.document,
				versions: store.versions,
			});

			await expect(versionForRunTwo()).resolves.toBeUndefined();

			expect(store.document).toEqual(before.document);
			expect(store.versions).toEqual(before.versions);
			expectSkipLogged();
		});

		it("rolls the row back and skips when the edit lands between the check and the bump", async () => {
			const store = installLiveStore(afterRunTwoSaved());
			const versionsBefore = structuredClone(store.versions);
			store.beforeConditionalUpdate = (state) => {
				state.document = { ...state.document, content: EDITED_MAIN };
			};

			await expect(versionForRunTwo()).resolves.toBeUndefined();

			expect(mocks.tx.documentVersion.create).toHaveBeenCalledTimes(1);
			expect(store.versions).toEqual(versionsBefore);
			expect(store.document).toMatchObject({
				content: EDITED_MAIN,
				version: 3,
			});
			expectSkipLogged();
		});

		it("skips rather than failing the run when the visual-slot baseline is given as well", async () => {
			const store = afterRunTwoSaved();
			store.document = {
				...store.document,
				content: EDITED_MAIN,
				version: 4,
			};
			installLiveStore(store);

			await expect(
				createDocumentVersion(
					"doc-1",
					FINAL_DOCUMENT,
					"user-1",
					"pv-3",
					{
						baselineVersion: 3,
						liveRunId: "run-2",
					},
				),
			).resolves.toBeUndefined();

			expect(store.document.content).toBe(EDITED_MAIN);
			expectSkipLogged();
		});

		it("still refuses a superseded run as stale rather than skipping", async () => {
			const store = installLiveStore(afterRunThreeFinished());

			expectStale(await failureOf(versionForRunTwo()));

			expect(store.document.content).toBe(NEWER_MAIN);
		});
	});

	it("still refuses as stale when the baseline moved under an unchanged body", async () => {
		const store = afterRunTwoSaved();
		store.document = { ...store.document, version: 4 };
		installLiveStore(store);
		const before = structuredClone(store.versions);

		expectStale(
			await failureOf(
				createDocumentVersion(
					"doc-1",
					FINAL_DOCUMENT,
					"user-1",
					"pv-3",
					{
						baselineVersion: 3,
						liveRunId: "run-2",
					},
				),
			),
		);

		expect(store.versions).toEqual(before);
	});

	it("refuses a superseded run's version as stale and writes nothing", async () => {
		const store = installLiveStore(afterRunThreeFinished());
		const before = structuredClone({
			document: store.document,
			versions: store.versions,
		});

		expectStale(await failureOf(versionForRunTwo()));

		expect(store.document).toEqual(before.document);
		expect(store.versions).toEqual(before.versions);
		expectNoUnguardedWrites();
	});

	it("rolls the row back when a newer run takes over between the check and the bump", async () => {
		const store = installLiveStore(afterRunTwoSaved());
		const versionsBefore = structuredClone(store.versions);
		store.beforeConditionalUpdate = (state) => {
			state.document = { ...state.document, liveRunId: "run-3" };
		};

		expectStale(await failureOf(versionForRunTwo()));

		expect(store.versions).toEqual(versionsBefore);
		expect(store.document.version).toBe(3);
	});

	it("reports its committed row without a second one when retried", async () => {
		const store = installLiveStore(afterRunTwoSaved());
		const first = await versionForRunTwo();
		const committed = structuredClone({
			document: store.document,
			versions: store.versions,
		});

		const retried = await versionForRunTwo();

		expect(retried).toEqual(first);
		expect(store.document).toEqual(committed.document);
		expect(store.versions).toEqual(committed.versions);
	});

	it("still reports its committed row when a newer run took over before the retry", async () => {
		const store = installLiveStore(afterRunTwoSaved());
		const first = await versionForRunTwo();
		store.document = { ...store.document, liveRunId: "run-3" };

		await expect(versionForRunTwo()).resolves.toEqual(first);
		expect(store.versions.filter((row) => row.version === 4)).toHaveLength(
			1,
		);
	});
});

describe("updateProjectDocumentStatus — guarded by the live run", () => {
	/** The row behind the unguarded client's `updateMany`. */
	function installStatusRow(row: LiveDocument): LiveDocument {
		mocks.projectDocument.updateMany.mockImplementation(
			async ({
				where,
				data,
			}: {
				where: Record<string, unknown>;
				data: Partial<LiveDocument>;
			}) => {
				if (!documentMatches(row, where)) {
					return { count: 0 };
				}
				Object.assign(row, data);
				return { count: 1 };
			},
		);
		return row;
	}

	it("is a no-op, not an error, for a run a newer one superseded", async () => {
		const row = installStatusRow(afterRunThreeFinished().document);
		const before = structuredClone(row);

		await expect(
			updateProjectDocumentStatus({
				documentId: "doc-1",
				status: "FAILED",
				progress: 0,
				error: "The agent could not be reached.",
				liveRunId: "run-2",
			}),
		).resolves.toBeUndefined();

		expect(row).toEqual(before);
		expect(mocks.projectDocument.update).not.toHaveBeenCalled();
	});

	it("marks the run's own document FAILED and drops its preview", async () => {
		const row = installStatusRow(whileRunTwoGenerates().document);

		await updateProjectDocumentStatus({
			documentId: "doc-1",
			status: "FAILED",
			progress: 0,
			error: "The agent could not be reached.",
			liveRunId: "run-2",
		});

		expect(row).toMatchObject({
			status: "FAILED",
			generationProgress: 0,
			generationError: "The agent could not be reached.",
			liveContent: null,
			liveRunId: "run-2",
			content: OLD_MAIN,
		});
		expect(mocks.projectDocument.update).not.toHaveBeenCalled();
	});

	it("also keeps a superseded run's progress write off the newer run's document", async () => {
		const row = installStatusRow(afterRunThreeFinished().document);

		await updateProjectDocumentStatus({
			documentId: "doc-1",
			status: "GENERATING",
			progress: 80,
			liveRunId: "run-2",
		});

		expect(row.status).toBe("COMPLETE");
	});

	it("a parent starting a new attempt ends the previous run's ownership and gets the attempt's identity", async () => {
		mocks.projectDocument.update.mockResolvedValue({});

		const attempt = await updateProjectDocumentStatus({
			documentId: "doc-1",
			status: "GENERATING",
			progress: 0,
		});

		expect(mocks.projectDocument.update).toHaveBeenCalledWith({
			where: { id: "doc-1" },
			data: expect.objectContaining({
				status: "GENERATING",
				generationStartedAt: expect.any(Date),
				liveRunId: null,
				liveAttempt: null,
				liveContent: null,
			}),
		});
		// The identity returned is exactly the one written, so the child's
		// plan can scope its takeover to it.
		const [{ data }] = mocks.projectDocument.update.mock.calls[0] as [
			{ data: { generationStartedAt: Date } },
		];
		expect(attempt).toEqual({
			generationStartedAt: data.generationStartedAt.toISOString(),
		});
	});

	it("starts an attempt elsewhere on the bar when the parent says so", async () => {
		mocks.projectDocument.update.mockResolvedValue({});

		const attempt = await updateProjectDocumentStatus({
			documentId: "doc-1",
			status: "GENERATING",
			progress: 5,
			startsAttempt: true,
		});

		expect(mocks.projectDocument.update).toHaveBeenCalledWith({
			where: { id: "doc-1" },
			data: expect.objectContaining({
				generationProgress: 5,
				generationStartedAt: expect.any(Date),
				liveRunId: null,
			}),
		});
		expect(attempt?.generationStartedAt).toEqual(expect.any(String));
	});

	it("a progress write that commits after the save does not reopen the finished document", async () => {
		// The save completed the document and kept the run's token.
		const row = installStatusRow({
			...whileRunTwoGenerates().document,
			status: "COMPLETE",
			liveContent: null,
		});

		await expect(
			updateProjectDocumentStatus({
				documentId: "doc-1",
				status: "GENERATING",
				progress: 80,
				liveRunId: "run-2",
			}),
		).resolves.toBeUndefined();

		expect(row.status).toBe("COMPLETE");
	});

	it("a progress write lands while the run's document is QUEUED or GENERATING", async () => {
		for (const status of ["QUEUED", "GENERATING"] as const) {
			const row = installStatusRow({
				...whileRunTwoGenerates().document,
				status,
			});

			await updateProjectDocumentStatus({
				documentId: "doc-1",
				status: "GENERATING",
				progress: 30,
				liveRunId: "run-2",
			});

			expect(row).toMatchObject({
				status: "GENERATING",
				generationProgress: 30,
			});
		}
	});

	it("any other unguarded write leaves the live columns alone", async () => {
		mocks.projectDocument.update.mockResolvedValue({});

		await updateProjectDocumentStatus({
			documentId: "doc-1",
			status: "COMPLETE",
			progress: 100,
		});
		await updateProjectDocumentStatus({
			documentId: "doc-1",
			status: "GENERATING",
			progress: 30,
		});

		for (const [args] of mocks.projectDocument.update.mock.calls) {
			const { data } = args as { data: Record<string, unknown> };
			expect(data).not.toHaveProperty("liveRunId");
			expect(data).not.toHaveProperty("liveAttempt");
			expect(data).not.toHaveProperty("liveContent");
		}
	});
});
