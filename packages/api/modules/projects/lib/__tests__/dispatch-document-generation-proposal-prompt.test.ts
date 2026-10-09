/**
 * The early refusal of an unbound Proposal (Fizzy #2801).
 *
 * With the Proposal artifact rollout gate on for the project's owning
 * organization, a Proposal's Main Document is rendered only from the prompt
 * bound to the client-only Main action, and the run fails closed when nothing
 * is bound. This pins the door-side copy of that rule: the request is refused
 * with PRECONDITION_FAILED and the actionable message before a token is
 * issued, a workflow is started or the row is marked queued — both from the
 * dispatcher and from `assertDocumentGenerationAvailable`, which the create
 * route runs before its write.
 *
 * With the gate off, for every other type, and for a project with no
 * organization nothing changes and the binding is never read.
 */

import { PROPOSAL_PROMPT_NOT_BOUND } from "@repo/temporal/proposal-artifact-types";
import { PROPOSAL_CLIENT_MAIN_AGENT_KEY } from "@repo/utils/prompt-action-catalog";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		isFeatureEnabled: vi.fn(),
		findBoundProposalPrompt: vi.fn(),
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

// The real message, a stand-in for the binding read.
vi.mock("@repo/temporal/proposal-artifact-prompts", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@repo/temporal/proposal-artifact-prompts")
	>()),
	findBoundProposalPrompt: mocks.findBoundProposalPrompt,
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

import { proposalPromptNotBoundMessage } from "@repo/temporal/proposal-artifact-prompts";
import {
	assertDocumentGenerationAvailable,
	dispatchDocumentGeneration,
	proposalPromptRefusal,
} from "../dispatch-document-generation";

const OWNING_ORG = "org-example";
const PROJECT = "project-example";
const DOCUMENT = "document-example";
const USER = "user-example";

const NOT_BOUND_MESSAGE = proposalPromptNotBoundMessage(
	PROPOSAL_CLIENT_MAIN_AGENT_KEY,
);

/** The PROPOSAL_ARTIFACT gate, per organization. */
let gateOn: Set<string>;

function dispatch(overrides: Record<string, unknown> = {}) {
	return dispatchDocumentGeneration({
		documentId: DOCUMENT,
		projectId: PROJECT,
		documentType: "PROPOSAL",
		userId: USER,
		organizationId: OWNING_ORG,
		...overrides,
	});
}

function proposalArtifactGateReads() {
	return mocks.isFeatureEnabled.mock.calls.filter(
		([flag]) => flag === "PROPOSAL_ARTIFACT",
	);
}

function nothingStarted() {
	expect(mocks.issueAIToken).not.toHaveBeenCalled();
	expect(mocks.workflowStart).not.toHaveBeenCalled();
	expect(mocks.markDocumentGenerationQueued).not.toHaveBeenCalled();
	expect(mocks.markDocumentGenerationFailed).not.toHaveBeenCalled();
}

beforeEach(() => {
	vi.clearAllMocks();
	gateOn = new Set([OWNING_ORG]);
	mocks.isFeatureEnabled.mockImplementation(
		async (flag: string, organizationId?: string) =>
			flag === "PROPOSAL_ARTIFACT" &&
			organizationId !== undefined &&
			gateOn.has(organizationId),
	);
	mocks.findBoundProposalPrompt.mockResolvedValue(null);
	mocks.issueAIToken.mockResolvedValue("token");
	mocks.workflowStart.mockResolvedValue({
		workflowId: "workflow-example",
		firstExecutionRunId: "run-example",
	});
	mocks.markDocumentGenerationQueued.mockResolvedValue({ applied: true });
});

describe("dispatchDocumentGeneration — an unbound Proposal with the gate on", () => {
	it("is refused before a run is queued, with the actionable message", async () => {
		const error = await dispatch().catch((caught: unknown) => caught);

		expect(error).toMatchObject({
			code: "PRECONDITION_FAILED",
			message: NOT_BOUND_MESSAGE,
			data: { code: PROPOSAL_PROMPT_NOT_BOUND },
		});
		nothingStarted();
	});

	it("asks for the requesting user's binding in the owning organization and project", async () => {
		await dispatch().catch(() => undefined);

		expect(mocks.isFeatureEnabled).toHaveBeenCalledWith(
			"PROPOSAL_ARTIFACT",
			OWNING_ORG,
		);
		expect(mocks.findBoundProposalPrompt).toHaveBeenCalledWith({
			userId: USER,
			organizationId: OWNING_ORG,
			projectId: PROJECT,
			action: PROPOSAL_CLIENT_MAIN_AGENT_KEY,
		});
	});

	it("propagates a failed binding read rather than letting the run through", async () => {
		mocks.findBoundProposalPrompt.mockRejectedValue(
			new Error("database unavailable"),
		);

		await expect(dispatch()).rejects.toThrow("database unavailable");
		nothingStarted();
	});
});

describe("dispatchDocumentGeneration — everything else is unchanged", () => {
	it("starts a Proposal whose Main prompt is bound", async () => {
		mocks.findBoundProposalPrompt.mockResolvedValue({
			promptId: "prompt-example",
			versionNumber: 2,
			promptVersionId: "prompt-version-example",
		});

		await expect(dispatch()).resolves.toMatchObject({
			outcome: "started",
		});
		expect(mocks.workflowStart).toHaveBeenCalledTimes(1);
	});

	it("starts a Proposal with the gate off, without reading the binding", async () => {
		gateOn.clear();

		await expect(dispatch()).resolves.toMatchObject({
			outcome: "started",
		});
		expect(mocks.findBoundProposalPrompt).not.toHaveBeenCalled();
	});

	it("reads the gate of the owning organization only", async () => {
		// Another organization's gate being on does not apply here.
		gateOn = new Set(["org-other"]);

		await expect(dispatch()).resolves.toMatchObject({
			outcome: "started",
		});
		expect(proposalArtifactGateReads()).toEqual([
			["PROPOSAL_ARTIFACT", OWNING_ORG],
		]);
	});

	it.each(["BUSINESS_CASE", "PRD", "GENERAL"])(
		"starts a %s with the gate on, without reading the gate or the binding",
		async (documentType) => {
			await expect(dispatch({ documentType })).resolves.toMatchObject({
				outcome: "started",
			});
			expect(proposalArtifactGateReads()).toEqual([]);
			expect(mocks.findBoundProposalPrompt).not.toHaveBeenCalled();
		},
	);

	it("starts a Proposal in a project with no organization, reading nothing", async () => {
		await expect(
			dispatch({ organizationId: undefined }),
		).resolves.toMatchObject({ outcome: "started" });
		expect(proposalArtifactGateReads()).toEqual([]);
		expect(mocks.findBoundProposalPrompt).not.toHaveBeenCalled();
	});
});

describe("the create route's pre-write assert", () => {
	it("refuses an unbound Proposal before the row is written", async () => {
		const error = await assertDocumentGenerationAvailable({
			documentType: "PROPOSAL",
			projectId: PROJECT,
			userId: USER,
			organizationId: OWNING_ORG,
		}).catch((caught: unknown) => caught);

		expect(error).toMatchObject({
			code: "PRECONDITION_FAILED",
			message: NOT_BOUND_MESSAGE,
		});
	});

	it("is not asked a second time by a dispatcher told it already ran", async () => {
		await expect(
			dispatch({ capabilityAlreadyAsserted: true }),
		).resolves.toMatchObject({ outcome: "started" });
		expect(mocks.findBoundProposalPrompt).not.toHaveBeenCalled();
	});
});

describe("proposalPromptRefusal", () => {
	it("answers the message for an unbound Proposal and null otherwise", async () => {
		const ask = (documentType: string, organizationId: string | null) =>
			proposalPromptRefusal({
				documentType,
				projectId: PROJECT,
				userId: USER,
				organizationId,
			});

		expect(await ask("PROPOSAL", OWNING_ORG)).toBe(NOT_BOUND_MESSAGE);
		expect(await ask("PROPOSAL", null)).toBeNull();
		expect(await ask("BUSINESS_CASE", OWNING_ORG)).toBeNull();

		mocks.findBoundProposalPrompt.mockResolvedValue({
			promptId: "prompt-example",
			versionNumber: 1,
			promptVersionId: "prompt-version-example",
		});
		expect(await ask("PROPOSAL", OWNING_ORG)).toBeNull();
	});
});
