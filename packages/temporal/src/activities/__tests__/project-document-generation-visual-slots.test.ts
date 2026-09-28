/**
 * Visual slots through the generation activity (Fizzy #2589, KTD17, R39, AE5).
 *
 * Regenerate rewrites the whole body, and the agent is deliberately NOT shown
 * the previous document on a regeneration — so a slot the editor placed cannot
 * survive on the model's attention. `generateDocumentWithAgent` splices the
 * slots of the body the run started from (`currentDocument`) back at the one
 * seam the content leaves the activity, before quote normalization. The
 * workflow is untouched: it saves and versions whatever this returns.
 *
 * Pinned here: a dropped slot returns under the same heading, or at the end
 * with `data-orphaned-from` when the heading is gone (AE5); with no slot on
 * either side the content is the agent's string byte for byte; a slot the
 * agent invented is not kept; and quote normalization still runs.
 *
 * The LangGraph client is stubbed to stream one `values` event, the way the
 * agent reports its document. Other mocks mirror the sibling
 * `project-document-generation-role-tag.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	runsStream: vi.fn(),
	hasProjectAccess: vi.fn(),
	projectFindUnique: vi.fn(),
	fetchAndRenderPrompt: vi.fn(),
}));

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
	},
	hasProjectAccess: (...args: unknown[]) => mocks.hasProjectAccess(...args),
	recordAuditDurable: vi.fn(),
	listEmbeddedDocumentsForSweep: vi.fn().mockResolvedValue([]),
}));

vi.mock("@repo/rag", () => ({
	buildDocumentRetrievalQuery: () => "build document retrieval query",
	searchSimilarProjectContexts: vi.fn(),
	extractBaseContextId: (id: string) => id,
	enrichContextsWithRoleTags: vi.fn(),
	applyContextSummary: vi.fn(),
	rerankContexts: vi.fn(),
	embedProjectDocument: vi.fn(),
	reembedProjectDocument: vi.fn(),
	deleteStaleDocumentEmbeddingChunks: vi.fn(),
	searchSimilarEpisodes: vi.fn().mockResolvedValue([]),
}));

vi.mock("@repo/ai", () => ({
	DEFAULT_BASE_URLS: {},
	getAIModelWithMetadata: vi.fn().mockResolvedValue({
		model: {},
		metadata: { modelString: "example-model", provider: "openai" },
		trackUsage: vi.fn(),
	}),
	logModelUsageAsync: vi.fn(),
	streamText: vi.fn(),
}));

vi.mock("@repo/ai/skills", () => ({
	isTextContentType: vi.fn(),
	loadSkillBundle: vi.fn(),
	readSkillFile: vi.fn(),
}));

vi.mock("../prompt-activities", () => ({
	fetchAndRenderPrompt: (...args: unknown[]) =>
		mocks.fetchAndRenderPrompt(...args),
	renderPromptWithContext: vi.fn(),
}));

vi.mock("@temporalio/activity", () => ({
	Context: { current: { heartbeat: vi.fn() } },
	heartbeat: vi.fn(),
	ApplicationFailure: { nonRetryable: (msg: string) => new Error(msg) },
}));

vi.mock("../lib/activity-logger", () => ({
	activityLogger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

// Import AFTER mocks
import { generateDocumentWithAgent } from "../project-document-generation";

const SLOT =
	'<visual-slot data-slot-id="slot-a" data-kind="timeline" data-hint="Phase dates"></visual-slot>';

/** The stored Proposal a regeneration starts from, one slot in its phases. */
const CURRENT = `# Proposal

## Overview

We propose a rollout.

## Implementation Phases

Phase one covers discovery.

${SLOT}

Phase two covers delivery.

## Risks

Vendor delay.
`;

/** What the agent returns: rewritten prose, same headings, the slot gone. */
const REGENERATED = `# Proposal

## Overview

We propose a phased rollout.

## Implementation Phases

Phase one covers discovery and design.

Phase two covers delivery.

## Risks

Vendor delay.
`;

function agentReturns(document: string) {
	mocks.runsStream.mockImplementation(() =>
		(async function* () {
			yield { event: "metadata", data: {} };
			yield { event: "values", data: { document } };
		})(),
	);
}

function generate(currentDocument?: string) {
	return generateDocumentWithAgent({
		projectId: "project-1",
		documentType: "PROPOSAL",
		prompt: "",
		contexts: [],
		userId: "user-1",
		organizationId: "org-1",
		aiToken: "token-1",
		currentDocument,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.hasProjectAccess.mockResolvedValue(true);
	mocks.projectFindUnique.mockResolvedValue({
		name: "Example project",
		description: "An example.",
		goals: null,
		techStack: [],
		features: [],
		projectTypes: [],
		qaStrategyLevel: null,
	});
	// No bound prompt: the activity builds its default prompt.
	mocks.fetchAndRenderPrompt.mockResolvedValue(null);
});

describe("generateDocumentWithAgent — visual slots", () => {
	it("puts a slot the regeneration dropped back under the same heading (AE5)", async () => {
		agentReturns(REGENERATED);

		const { content } = await generate(CURRENT);

		expect(content).toBe(`# Proposal

## Overview

We propose a phased rollout.

## Implementation Phases

Phase one covers discovery and design.

${SLOT}

Phase two covers delivery.

## Risks

Vendor delay.
`);
	});

	it("moves the slot to the end, naming its section, when the heading did not survive (AE5)", async () => {
		agentReturns(
			"# Proposal\n\n## Overview\n\nWe propose a phased rollout.\n\n## Risks\n\nVendor delay.\n",
		);

		const { content } = await generate(CURRENT);

		expect(content).toBe(
			'# Proposal\n\n## Overview\n\nWe propose a phased rollout.\n\n## Risks\n\nVendor delay.\n\n<visual-slot data-slot-id="slot-a" data-kind="timeline" data-hint="Phase dates" data-orphaned-from="Implementation Phases"></visual-slot>\n',
		);
	});

	it("still repairs quote artifacts after the splice", async () => {
		agentReturns(
			REGENERATED.replace("Vendor delay.", "Vendor ~“~“delay~”~”."),
		);

		const { content } = await generate(CURRENT);

		expect(content).toContain(SLOT);
		expect(content).toContain("Vendor “delay”.");
		expect(content).not.toContain("~");
	});

	it("does not keep a slot the agent invented", async () => {
		agentReturns(`${REGENERATED}\n${SLOT}\n`);

		const { content } = await generate(REGENERATED);

		expect(content).not.toContain("<visual-slot");
	});
});

describe("generateDocumentWithAgent — no slot on either side is byte-identical", () => {
	// Trailing spaces, CRLF and a triple newline — anything a splice might be
	// tempted to tidy. None of it may move.
	const AGENT_OUTPUT =
		"# Proposal\r\n\r\n## Overview  \n\n\n\nWe propose a rollout.\t\n\n| a | b |\n|---|---|\n| 1 | 2 |";

	it("returns the agent's content untouched on a first generation", async () => {
		agentReturns(AGENT_OUTPUT);

		const { content } = await generate(undefined);

		expect(content).toBe(AGENT_OUTPUT);
	});

	it("returns the agent's content untouched on a regeneration", async () => {
		agentReturns(AGENT_OUTPUT);

		const { content } = await generate(REGENERATED);

		expect(content).toBe(AGENT_OUTPUT);
	});
});
