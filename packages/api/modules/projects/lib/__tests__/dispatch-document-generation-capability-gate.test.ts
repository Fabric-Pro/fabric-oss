/**
 * The capability gate on starting a document generation run (Fizzy #1930).
 *
 * The assert sits in the dispatcher rather than on either procedure for the
 * same reason everything else in that file does: both dispatch paths funnel
 * through here, and a second copy of the rule would drift. It also catches the
 * callers that never rendered a button — the public API, MCP tools, agents.
 *
 * Two behaviours are pinned that a "did we call the guard" test would miss:
 *
 *   - the key follows the DOCUMENT TYPE, so the four generators that can
 *     actually be refused each name their own missing source;
 *   - a type outside that set asserts NOTHING. Three of the seven registered
 *     document rules can only ever warn, and the rest are not registered at
 *     all — passing their type to the guard would throw on an unknown key.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		isFeatureEnabled: vi.fn(),
		gatherCapabilityEvidence: vi.fn(),
		markDocumentGenerationQueued: vi.fn(),
		markDocumentGenerationFailed: vi.fn(),
		issueAIToken: vi.fn(),
		workflowStart: vi.fn(),
	},
}));

vi.mock("@repo/database", () => ({
	isFeatureEnabled: mocks.isFeatureEnabled,
}));

vi.mock("@repo/database/prisma/queries/projects/documents", () => ({
	markDocumentGenerationQueued: mocks.markDocumentGenerationQueued,
	markDocumentGenerationFailed: mocks.markDocumentGenerationFailed,
}));

vi.mock("../../../capabilities/evidence", () => ({
	gatherCapabilityEvidence: mocks.gatherCapabilityEvidence,
}));

vi.mock("@repo/ai-token", () => ({ issueAIToken: mocks.issueAIToken }));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({
		workflow: {
			start: mocks.workflowStart,
			getHandle: () => ({ describe: vi.fn() }),
		},
	}),
}));

vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: <T>(args: T) => args,
}));

import {
	evidenceWith,
	healthyEvidence,
} from "../../../capabilities/__tests__/evidence-fixture";
import { dispatchDocumentGeneration } from "../dispatch-document-generation";

/** A project with no technical, product or architectural grounding at all. */
function barrenEvidence() {
	return evidenceWith({
		codebase: { connected: false, usable: false, healthy: false },
		context: { total: 0, technical: 0, product: 0 },
		documents: { usableTypes: new Set<string>() },
		descriptionLength: 0,
	});
}

function dispatch(documentType: string) {
	return dispatchDocumentGeneration({
		documentId: "document_example",
		projectId: "project_example",
		documentType,
		userId: "user_example",
		organizationId: "organization_example",
	});
}

async function errorFrom(promise: Promise<unknown>) {
	try {
		await promise;
	} catch (err) {
		return err as { code?: string; message?: string };
	}
	throw new Error("expected the dispatcher to throw");
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.isFeatureEnabled.mockResolvedValue(true);
	mocks.gatherCapabilityEvidence.mockResolvedValue(healthyEvidence());
	mocks.issueAIToken.mockResolvedValue("token_example");
	mocks.markDocumentGenerationQueued.mockResolvedValue({ applied: true });
	mocks.workflowStart.mockResolvedValue({
		workflowId: "workflow_example",
		firstExecutionRunId: "run_example",
	});
});

describe("dispatchDocumentGeneration — the capability door", () => {
	it("refuses with PRECONDITION_FAILED naming the missing source", async () => {
		mocks.gatherCapabilityEvidence.mockResolvedValue(barrenEvidence());

		const err = await errorFrom(dispatch("TECHNICAL_SPEC"));

		expect(err.code).toBe("PRECONDITION_FAILED");
		expect(err.message).toContain(
			"a PRD, architecture document or indexed codebase",
		);
	});

	it("refuses before a token is minted or a workflow started", async () => {
		mocks.gatherCapabilityEvidence.mockResolvedValue(barrenEvidence());

		await errorFrom(dispatch("TECHNICAL_SPEC"));

		expect(mocks.issueAIToken).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
		expect(mocks.markDocumentGenerationQueued).not.toHaveBeenCalled();
	});

	it("names each gated type's own missing source", async () => {
		// The mapping, not a single hardcoded key. A regression to one key
		// would keep every other assertion in this file green.
		mocks.gatherCapabilityEvidence.mockResolvedValue(barrenEvidence());

		const architecture = await errorFrom(dispatch("ARCHITECTURE"));
		const apiSpec = await errorFrom(dispatch("API_SPEC"));
		const qaStrategy = await errorFrom(dispatch("QA_STRATEGY"));

		expect(architecture.message).toContain(
			"a product or architecture source",
		);
		expect(apiSpec.message).toContain("an API-relevant source");
		expect(qaStrategy.message).toContain(
			"a PRD or equivalent requirements context",
		);
	});

	it("proceeds when the project holds the source the type needs", async () => {
		await expect(dispatch("TECHNICAL_SPEC")).resolves.toMatchObject({
			outcome: "started",
		});
		expect(mocks.workflowStart).toHaveBeenCalledTimes(1);
	});

	it("asserts nothing for a type outside the gated set", async () => {
		// PRD can only ever warn, and GENERAL has no rule at all — handing
		// either to the guard would throw on an unregistered key.
		mocks.gatherCapabilityEvidence.mockResolvedValue(barrenEvidence());

		await expect(dispatch("PRD")).resolves.toMatchObject({
			outcome: "started",
		});
		await expect(dispatch("GENERAL")).resolves.toMatchObject({
			outcome: "started",
		});
		expect(mocks.gatherCapabilityEvidence).not.toHaveBeenCalled();
	});

	it("is inert with the flag off — no evidence read, no refusal", async () => {
		mocks.isFeatureEnabled.mockResolvedValue(false);
		mocks.gatherCapabilityEvidence.mockResolvedValue(barrenEvidence());

		await expect(dispatch("TECHNICAL_SPEC")).resolves.toMatchObject({
			outcome: "started",
		});
		expect(mocks.gatherCapabilityEvidence).not.toHaveBeenCalled();
	});

	it("resolves the gate against the tenant the caller already resolved", async () => {
		await dispatch("TECHNICAL_SPEC");

		expect(mocks.gatherCapabilityEvidence).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "project_example",
				userId: "user_example",
				organizationId: "organization_example",
			}),
		);
	});
});
