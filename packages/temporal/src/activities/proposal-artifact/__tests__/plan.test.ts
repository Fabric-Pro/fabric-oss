/**
 * `planProposalArtifact` (Fizzy #2801): the rollout gate first, for the
 * project's owning organization; then the guest check, the fail-closed Main
 * prompt, the optional analysis prompt, and the live columns taken over last,
 * under the workflow's run token and, when the run has one, only while the
 * document still carries the generation attempt's identity.
 *
 * The prompt resolver is the real one; only the binding read beneath it is
 * mocked, so the refusal is the resolver's own.
 */

import { ApplicationFailure } from "@temporalio/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
	db: {
		project: { findUnique: vi.fn() },
		projectDocument: { findFirst: vi.fn() },
	},
	isFeatureEnabled: vi.fn(),
	isOrganizationMember: vi.fn(),
	getBoundPromptForAgent: vi.fn(),
	resetLiveSections: vi.fn(),
	clearLiveContent: vi.fn(),
}));

vi.mock("@repo/database", () => database);

import { contentIdentity } from "../../../lib/proposal-artifact/content-identity";
import { clearProposalLiveContent, planProposalArtifact } from "../plan";

const PLANNED_MAIN = "# Proposal\n\nThe body the run is planned against.";

const INPUT = {
	projectId: "project-1",
	documentId: "doc-1",
	documentType: "PROPOSAL",
	userId: "user-1",
	organizationId: "org-1",
	liveRunId: "child-run-1",
};

/** The attempt identity the dispatch stamped, as the workflow carries it. */
const STARTED_AT = "2026-10-07T09:00:00.123Z";

function bound(promptId: string, version: number) {
	return {
		id: promptId,
		version: { id: `${promptId}-v${version}`, version },
	};
}

/** The binding read, answering per action. */
function bindings(byAction: Record<string, ReturnType<typeof bound> | null>) {
	database.getBoundPromptForAgent.mockImplementation(
		async ({ agentName }: { agentName: string }) =>
			byAction[agentName] ?? null,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	database.db.project.findUnique.mockResolvedValue({
		organizationId: "org-1",
	});
	database.db.projectDocument.findFirst.mockResolvedValue({
		id: "doc-1",
		version: 5,
		content: PLANNED_MAIN,
	});
	database.isFeatureEnabled.mockResolvedValue(true);
	database.isOrganizationMember.mockResolvedValue(true);
	database.resetLiveSections.mockResolvedValue("written");
	bindings({
		proposal_client_main: bound("prompt-main", 4),
		proposal_internal_analysis: bound("prompt-analysis", 2),
	});
});

describe("planProposalArtifact — the gate comes first", () => {
	it("returns null for any other document type without reading anything", async () => {
		const plan = await planProposalArtifact({
			...INPUT,
			documentType: "BUSINESS_CASE",
		});

		expect(plan).toBeNull();
		expect(database.db.project.findUnique).not.toHaveBeenCalled();
		expect(database.isFeatureEnabled).not.toHaveBeenCalled();
	});

	it("returns null with the gate off, before any prompt is resolved or anything is written", async () => {
		database.isFeatureEnabled.mockResolvedValue(false);
		// Nothing is bound to the new actions: a gate-off organization must
		// not depend on them.
		bindings({});

		const plan = await planProposalArtifact(INPUT);

		expect(plan).toBeNull();
		expect(database.isFeatureEnabled).toHaveBeenCalledWith(
			"PROPOSAL_ARTIFACT",
			"org-1",
		);
		expect(database.isOrganizationMember).not.toHaveBeenCalled();
		expect(database.getBoundPromptForAgent).not.toHaveBeenCalled();
		expect(database.resetLiveSections).not.toHaveBeenCalled();
	});

	it("reads the gate for the project's owning organization, not the caller's", async () => {
		database.db.project.findUnique.mockResolvedValue({
			organizationId: "org-owner",
		});

		await planProposalArtifact({ ...INPUT, organizationId: "org-session" });

		expect(database.isFeatureEnabled).toHaveBeenCalledWith(
			"PROPOSAL_ARTIFACT",
			"org-owner",
		);
		expect(database.isOrganizationMember).toHaveBeenCalledWith(
			"user-1",
			"org-owner",
		);
		expect(database.getBoundPromptForAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: "org-owner",
				projectId: "project-1",
			}),
		);
	});

	it("returns null when the project has no organization", async () => {
		database.db.project.findUnique.mockResolvedValue({
			organizationId: null,
		});

		expect(await planProposalArtifact(INPUT)).toBeNull();
		expect(database.isFeatureEnabled).not.toHaveBeenCalled();
	});
});

describe("planProposalArtifact — a member's run", () => {
	it("pins both bound prompts and resets the live columns under the workflow's run token", async () => {
		const plan = await planProposalArtifact(INPUT);

		expect(plan).toEqual({
			liveRunId: "child-run-1",
			// The version the save will require: a person's save during the
			// run moves it on, and the run is refused instead of overwriting.
			baselineVersion: 5,
			// The body's identity, which catches the edits that leave the
			// version where it was.
			baselineContentHash: contentIdentity(PLANNED_MAIN),
			mainPrompt: {
				promptId: "prompt-main",
				versionNumber: 4,
				promptVersionId: "prompt-main-v4",
			},
			analysisPrompt: {
				promptId: "prompt-analysis",
				versionNumber: 2,
				promptVersionId: "prompt-analysis-v2",
			},
			analysisSkipReason: null,
			triggeredByGuest: false,
		});
		// No attempt identity: today's unconditional takeover.
		expect(database.resetLiveSections).toHaveBeenCalledWith({
			documentId: "doc-1",
			runId: "child-run-1",
		});
	});

	it("resolves the Main prompt through the client-only action, at the Proposal type, without the personal tier", async () => {
		await planProposalArtifact(INPUT);

		expect(database.getBoundPromptForAgent).toHaveBeenCalledWith({
			agentName: "proposal_client_main",
			documentType: "PROPOSAL",
			storyKind: null,
			userId: undefined,
			organizationId: "org-1",
			projectId: "project-1",
		});
	});

	it("claims with the token it is given, so a retried plan takes the document with the same one", async () => {
		const first = await planProposalArtifact(INPUT);
		const retried = await planProposalArtifact(INPUT);

		expect(first).not.toBeNull();
		expect(retried).toEqual(first);
		const runIds = database.resetLiveSections.mock.calls.map(
			([call]) => (call as { runId: string }).runId,
		);
		expect(runIds).toEqual(["child-run-1", "child-run-1"]);
	});

	it("records an unbound analysis prompt as the reason the analysis will not run", async () => {
		bindings({ proposal_client_main: bound("prompt-main", 4) });

		const plan = await planProposalArtifact(INPUT);

		expect(plan).toMatchObject({
			analysisPrompt: null,
			analysisSkipReason: "PROMPT_NOT_BOUND",
		});
		expect(database.resetLiveSections).toHaveBeenCalledTimes(1);
	});
});

describe("planProposalArtifact — refusals", () => {
	it("fails closed, before the live columns are touched, when the Main prompt is unbound", async () => {
		bindings({ proposal_internal_analysis: bound("prompt-analysis", 2) });

		const error = await planProposalArtifact(INPUT).catch(
			(caught: unknown) => caught,
		);

		expect(error).toBeInstanceOf(ApplicationFailure);
		expect((error as ApplicationFailure).type).toBe(
			"PROPOSAL_PROMPT_NOT_BOUND",
		);
		expect((error as ApplicationFailure).nonRetryable).toBe(true);
		expect((error as ApplicationFailure).message).toContain(
			"Prompt Library",
		);
		expect(database.resetLiveSections).not.toHaveBeenCalled();
	});

	it("fails non-retryably when the document is not in the project", async () => {
		database.db.projectDocument.findFirst.mockResolvedValue(null);

		const error = await planProposalArtifact(INPUT).catch(
			(caught: unknown) => caught,
		);

		expect((error as ApplicationFailure).type).toBe(
			"PROPOSAL_DOCUMENT_NOT_FOUND",
		);
		expect((error as ApplicationFailure).nonRetryable).toBe(true);
		expect(database.getBoundPromptForAgent).not.toHaveBeenCalled();
		expect(database.resetLiveSections).not.toHaveBeenCalled();
	});

	it("fails non-retryably when the document is deleted before the reset", async () => {
		database.resetLiveSections.mockRejectedValue(
			Object.assign(new Error("Record to update not found."), {
				code: "P2025",
			}),
		);

		const error = await planProposalArtifact(INPUT).catch(
			(caught: unknown) => caught,
		);

		expect((error as ApplicationFailure).type).toBe(
			"PROPOSAL_DOCUMENT_NOT_FOUND",
		);
	});

	it("lets any other database error through, so the activity retries it", async () => {
		const outage = new Error("connection reset");
		database.resetLiveSections.mockRejectedValue(outage);

		await expect(planProposalArtifact(INPUT)).rejects.toBe(outage);
	});
});

describe("planProposalArtifact — the generation attempt's identity", () => {
	beforeEach(() => {
		database.db.projectDocument.findFirst.mockResolvedValue({
			id: "doc-1",
			generationStartedAt: new Date(STARTED_AT),
			version: 5,
			content: PLANNED_MAIN,
		});
	});

	it("takes the live columns over only while the document still carries the attempt's identity", async () => {
		const plan = await planProposalArtifact({
			...INPUT,
			generationStartedAt: STARTED_AT,
		});

		expect(plan).toMatchObject({ liveRunId: "child-run-1" });
		expect(database.resetLiveSections).toHaveBeenCalledWith({
			documentId: "doc-1",
			runId: "child-run-1",
			generationStartedAt: new Date(STARTED_AT),
		});
	});

	it("is superseded, resolving nothing and writing nothing, when a newer request owns the document", async () => {
		database.db.projectDocument.findFirst.mockResolvedValue({
			id: "doc-1",
			generationStartedAt: new Date("2026-10-07T09:05:00.000Z"),
		});
		// Even an unbound Main prompt does not fail a run that is no longer
		// the document's: its FAILED write would land on the newer run.
		bindings({});

		const plan = await planProposalArtifact({
			...INPUT,
			generationStartedAt: STARTED_AT,
		});

		expect(plan).toEqual({ superseded: true });
		expect(database.getBoundPromptForAgent).not.toHaveBeenCalled();
		expect(database.resetLiveSections).not.toHaveBeenCalled();
	});

	it("is superseded when a newer request takes the document between the read and the claim", async () => {
		database.resetLiveSections.mockResolvedValue("superseded");

		const plan = await planProposalArtifact({
			...INPUT,
			generationStartedAt: STARTED_AT,
		});

		expect(plan).toEqual({ superseded: true });
	});

	it("is superseded, writing nothing, when the identity cannot be read", async () => {
		const plan = await planProposalArtifact({
			...INPUT,
			generationStartedAt: "not-a-timestamp",
		});

		expect(plan).toEqual({ superseded: true });
		expect(database.resetLiveSections).not.toHaveBeenCalled();
	});

	it("still reads the gate first: gate off is today's flow, whatever the identity", async () => {
		database.isFeatureEnabled.mockResolvedValue(false);

		const plan = await planProposalArtifact({
			...INPUT,
			generationStartedAt: "not-a-timestamp",
		});

		expect(plan).toBeNull();
	});
});

describe("planProposalArtifact — a project guest's run", () => {
	beforeEach(() => {
		database.isOrganizationMember.mockResolvedValue(false);
	});

	it("is marked as a guest's, and its analysis is never resolved", async () => {
		const plan = await planProposalArtifact(INPUT);

		expect(plan).toMatchObject({
			triggeredByGuest: true,
			analysisPrompt: null,
			analysisSkipReason: "GUEST_TRIGGERED",
		});
		const actions = database.getBoundPromptForAgent.mock.calls.map(
			([lookup]) => (lookup as { agentName: string }).agentName,
		);
		expect(actions).toEqual(["proposal_client_main"]);
	});

	it("is a guest's even when the analysis prompt is bound", async () => {
		const plan = await planProposalArtifact(INPUT);

		expect(plan).toMatchObject({ analysisSkipReason: "GUEST_TRIGGERED" });
	});
});

describe("clearProposalLiveContent", () => {
	it("clears the preview of its own run only", async () => {
		database.clearLiveContent.mockResolvedValue("superseded");

		const result = await clearProposalLiveContent({
			documentId: "doc-1",
			liveRunId: "live-run-1",
		});

		expect(database.clearLiveContent).toHaveBeenCalledWith({
			documentId: "doc-1",
			runId: "live-run-1",
		});
		expect(result).toEqual({ outcome: "superseded" });
	});
});
