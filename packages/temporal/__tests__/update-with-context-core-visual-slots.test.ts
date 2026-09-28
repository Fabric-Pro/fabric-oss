/**
 * Visual slots through `runContextUpdate` (Fizzy #2589, KTD17, R39, AE5).
 *
 * The engine hands the model the whole body and takes a whole body back, so a
 * slot the editor placed is only as safe as the model's attention to one HTML
 * tag. `runContextUpdate` splices the caller's slots back itself, once, before
 * the no-op relevance gate — which is what every caller relies on: the
 * interactive document button, the scheduled refresh, and the work-item paths.
 *
 * What is pinned here:
 *   - a slot the model dropped comes back under the same heading (AE5), or at
 *     the end with `data-orphaned-from` when its heading is gone;
 *   - a rewrite whose ONLY difference is the dropped slot is not a change;
 *   - with no slot on either side the model's string is returned untouched —
 *     byte for byte, for a document and for a story body alike;
 *   - a slot the model invented is not kept.
 *
 * Mocks mirror the sibling `update-with-context-core.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	generateObject: vi.fn(),
	getAIModelWithMetadata: vi.fn(),
	logModelUsageAsync: vi.fn(),
	getProjectFunctionTagClause: vi.fn(),
}));

vi.mock("@repo/ai", async () => {
	const actualAi = await vi.importActual<typeof import("ai")>("ai");
	return {
		AIProviderNotConfiguredError: class extends Error {},
		generateObject: mocks.generateObject,
		getAIModelWithMetadata: mocks.getAIModelWithMetadata,
		logModelUsageAsync: mocks.logModelUsageAsync,
		NoObjectGeneratedError: actualAi.NoObjectGeneratedError,
		zodSchema: (s: unknown) => s,
	};
});
vi.mock("@repo/rag", () => ({ retrieveRelevantContextsForSpec: vi.fn() }));
vi.mock("@repo/rag/lib/project-contexts/live-integration-context", () => ({
	fetchLiveIntegrationContext: vi.fn(),
}));
vi.mock("@repo/ai/lib/function-tag-context", () => ({
	getProjectFunctionTagClause: mocks.getProjectFunctionTagClause,
}));

const { runContextUpdate } = await import(
	"../src/lib/update-with-context-core"
);

const SLOT =
	'<visual-slot data-slot-id="slot-a" data-kind="timeline" data-hint="Phase dates"></visual-slot>';

/** A Proposal with one slot under "Implementation Phases". */
const WITH_SLOT = `# Proposal

## Overview

We propose a rollout.

## Implementation Phases

Phase one covers discovery.

${SLOT}

Phase two covers delivery.

## Risks

Vendor delay.
`;

/** The same body as the model tends to return it: the slot gone. */
const SLOT_DROPPED = WITH_SLOT.replace(`${SLOT}\n\n`, "");

const baseArgs = {
	title: "Proposal",
	baselineDate: new Date("2026-01-01T00:00:00Z"),
	contextItems: [
		{
			sourceLabel: "DSU",
			sourceType: "transcript",
			sourceDate: "2026-01-02",
			sourceLinkOrId: "id-1",
			content: "Discovery now includes design.",
		},
	],
	userId: "u1",
	organizationId: "org-1",
	projectId: "p1",
};

function modelReturns(updatedDocument: string, hasRelevantContext = true) {
	mocks.generateObject.mockResolvedValue({
		object: {
			hasRelevantContext,
			updatedDocument,
			needsHumanResolution: false,
			summary: "Folded design into discovery.",
		},
		usage: {},
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getAIModelWithMetadata.mockResolvedValue({
		model: {},
		metadata: {},
		trackUsage: vi.fn(),
	});
	mocks.getProjectFunctionTagClause.mockResolvedValue("");
});

describe("runContextUpdate — visual slots", () => {
	it("puts a slot the model dropped back under the same heading (AE5)", async () => {
		modelReturns(
			SLOT_DROPPED.replace(
				"Phase one covers discovery.",
				"Phase one covers discovery and design.",
			),
		);

		const result = await runContextUpdate({
			...baseArgs,
			documentMarkdown: WITH_SLOT,
		});

		expect(result?.hasRelevantContext).toBe(true);
		expect(result?.updatedDocument).toBe(
			WITH_SLOT.replace(
				"Phase one covers discovery.",
				"Phase one covers discovery and design.",
			),
		);
	});

	it("moves the slot to the end, naming its section, when the heading did not survive (AE5)", async () => {
		modelReturns(
			"# Proposal\n\n## Overview\n\nWe propose a phased rollout.\n\n## Risks\n\nVendor delay.\n",
		);

		const result = await runContextUpdate({
			...baseArgs,
			documentMarkdown: WITH_SLOT,
		});

		expect(result?.updatedDocument).toBe(
			'# Proposal\n\n## Overview\n\nWe propose a phased rollout.\n\n## Risks\n\nVendor delay.\n\n<visual-slot data-slot-id="slot-a" data-kind="timeline" data-hint="Phase dates" data-orphaned-from="Implementation Phases"></visual-slot>\n',
		);
	});

	it("does not report a rewrite whose only difference is a dropped slot as a change", async () => {
		// Before the splice ran ahead of the gate, this compared unequal and the
		// person was offered a Confirm whose only effect was deleting their slot.
		modelReturns(SLOT_DROPPED);

		const result = await runContextUpdate({
			...baseArgs,
			documentMarkdown: WITH_SLOT,
		});

		expect(result?.hasRelevantContext).toBe(false);
		expect(result?.updatedDocument).toBe(WITH_SLOT);
		expect(result?.summary).toBe("Folded design into discovery.");
	});

	it("keeps one copy when the model echoed the slot twice", async () => {
		modelReturns(`${SLOT}\n\n${WITH_SLOT}`);

		const result = await runContextUpdate({
			...baseArgs,
			documentMarkdown: WITH_SLOT,
		});

		// Echoing the slot is not a change either.
		expect(result?.hasRelevantContext).toBe(false);
		expect(result?.updatedDocument).toBe(WITH_SLOT);
	});

	it("does not keep a slot the model invented", async () => {
		const body = "# Proposal\n\n## Overview\n\nWe propose a rollout.\n";
		modelReturns(
			`# Proposal\n\n## Overview\n\nWe propose a phased rollout.\n\n${SLOT}\n`,
		);

		const result = await runContextUpdate({
			...baseArgs,
			documentMarkdown: body,
		});

		expect(result?.updatedDocument).toBe(
			"# Proposal\n\n## Overview\n\nWe propose a phased rollout.\n",
		);
	});
});

describe("runContextUpdate — no slot on either side is byte-identical", () => {
	it("returns the model's document string untouched, whitespace and all", async () => {
		// Trailing spaces, CRLF, and a triple newline: anything the splice might
		// be tempted to tidy. None of it may move.
		const body = "# PRD\r\n\r\nOld body.  \n";
		const proposed = "# PRD\r\n\r\nNew body.  \n\n\n| a | b |\n|---|---|\n";
		modelReturns(proposed);

		const result = await runContextUpdate({
			...baseArgs,
			documentMarkdown: body,
		});

		expect(result).toEqual({
			hasRelevantContext: true,
			updatedDocument: proposed,
			needsHumanResolution: false,
			summary: "Folded design into discovery.",
		});
		expect(result?.updatedDocument).toBe(proposed);
	});

	it("returns a story body untouched through the work-item path", async () => {
		// The shape the story procedure builds (description + acceptance
		// criteria) with a kind addendum, as a work-item caller passes it.
		const story =
			"## Description\n\nAs a buyer I want to pay by invoice.\n\n## Acceptance Criteria\n\n- [ ] Invoice option shows at checkout";
		const proposed =
			"## Description\n\nAs a buyer I want to pay by invoice or card.\n\n## Acceptance Criteria\n\n- [ ] Invoice option shows at checkout\n- [ ] Card option shows at checkout\n";
		modelReturns(proposed);

		const result = await runContextUpdate({
			...baseArgs,
			title: "Pay by invoice",
			documentMarkdown: story,
			instructionAddendum: "Keep the acceptance criteria as a checklist.",
		});

		expect(result?.hasRelevantContext).toBe(true);
		expect(result?.updatedDocument).toBe(proposed);
	});

	it("leaves a slot tag inside a fenced code block alone — it is code, not a slot", async () => {
		const fenced = `# Spec\n\n\`\`\`html\n${SLOT}\n\`\`\`\n`;
		const proposed = `# Spec\n\nIntro.\n\n\`\`\`html\n${SLOT}\n\`\`\`\n`;
		modelReturns(proposed);

		const result = await runContextUpdate({
			...baseArgs,
			documentMarkdown: fenced,
		});

		expect(result?.updatedDocument).toBe(proposed);
	});
});
