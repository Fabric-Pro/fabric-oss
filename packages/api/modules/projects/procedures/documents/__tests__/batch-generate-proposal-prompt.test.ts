/**
 * The wizard batch's early refusal of an unbound Proposal (Fizzy #2801).
 *
 * With the Proposal artifact rollout gate on for the project's owning
 * organization and nothing bound to the client-only Main prompt, a Proposal
 * in the batch is refused the way a type the capability gate refuses is:
 * skipped and reported with the actionable message before anything is
 * written, while the rest of the batch runs — and when nothing is left, the
 * whole request is refused with PRECONDITION_FAILED.
 *
 * The batch door and the refusal helper run for real; the flag, the binding
 * read, the database and Temporal are stood in for.
 */

import { PROPOSAL_CLIENT_MAIN_AGENT_KEY } from "@repo/utils/prompt-action-catalog";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		isFeatureEnabled: vi.fn(),
		findBoundProposalPrompt: vi.fn(),
		documentCreate: vi.fn(),
		workflowStart: vi.fn(),
	},
}));

vi.mock("@repo/database", () => ({
	isFeatureEnabled: mocks.isFeatureEnabled,
	db: {
		project: {
			findUnique: async () => ({
				id: "project_example",
				name: "Example Project",
				organizationId: "organization_example",
				organization: null,
			}),
		},
		projectDocument: { create: mocks.documentCreate },
	},
}));

vi.mock("@repo/temporal/proposal-artifact-prompts", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@repo/temporal/proposal-artifact-prompts")
	>()),
	findBoundProposalPrompt: mocks.findBoundProposalPrompt,
}));

// No capability-gated type appears in these batches; the gate stays out of
// the way so only the Proposal rule is under test.
vi.mock("../../../../capabilities/flag", () => ({
	isCapabilityGatingEnabled: async () => false,
}));
vi.mock("@repo/ai-token", () => ({ issueAIToken: async () => "token" }));
vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({
		workflow: { start: mocks.workflowStart },
	}),
}));
vi.mock("../../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: <T>(args: T) => args,
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../../../../orpc/procedures", () => {
	const chain: Record<string, unknown> = {};
	Object.assign(chain, {
		use: () => chain,
		route: () => chain,
		input: () => chain,
		output: () => chain,
		handler: (fn: (...args: unknown[]) => unknown) => ({ _handler: fn }),
	});
	return {
		tenantProtectedProcedure: chain,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireProjectPermission: () => ({}),
	};
});

import { proposalPromptNotBoundMessage } from "@repo/temporal/proposal-artifact-prompts";
import { batchGenerateDocumentsProcedure } from "../batch-generate";

type Handler = (args: {
	input: Record<string, unknown>;
	context: { user: { id: string } };
}) => Promise<{
	documents: Array<{ type: string }>;
	skipped: Array<{
		type: string;
		reasonKey: string | null;
		message: string;
	}>;
}>;

const handler = (
	batchGenerateDocumentsProcedure as unknown as { _handler: Handler }
)._handler;

const NOT_BOUND_MESSAGE = proposalPromptNotBoundMessage(
	PROPOSAL_CLIENT_MAIN_AGENT_KEY,
);

let gateOn: boolean;

function batch(types: string[]) {
	return handler({
		input: {
			projectId: "project_example",
			documents: types.map((type) => ({ type, title: type, prompt: "" })),
		},
		context: { user: { id: "user_example" } },
	});
}

/** The document types the started workflow was handed. */
function startedTypes(): string[] {
	const args = mocks.workflowStart.mock.calls[0]?.[1].args[0] as {
		documents: Array<{ type: string }>;
	};
	return args.documents.map((doc) => doc.type);
}

beforeEach(() => {
	vi.clearAllMocks();
	gateOn = true;
	mocks.isFeatureEnabled.mockImplementation(
		async (flag: string, organizationId?: string) =>
			flag === "PROPOSAL_ARTIFACT" &&
			organizationId === "organization_example" &&
			gateOn,
	);
	mocks.findBoundProposalPrompt.mockResolvedValue(null);
	mocks.documentCreate.mockImplementation(
		async ({ data }: { data: { type: string; title: string } }) => ({
			id: `document_${data.type}`,
			type: data.type,
			title: data.title,
			status: "DRAFT",
		}),
	);
	mocks.workflowStart.mockResolvedValue({
		workflowId: "workflow_example",
		firstExecutionRunId: "run_example",
	});
});

describe("batchGenerate — an unbound Proposal with the gate on", () => {
	it("refuses a Proposal-only batch outright, writing nothing", async () => {
		const error = await batch(["PROPOSAL"]).catch(
			(caught: unknown) => caught,
		);

		expect(error).toMatchObject({
			code: "PRECONDITION_FAILED",
			message: NOT_BOUND_MESSAGE,
			data: {
				gate: null,
				skipped: [
					{
						type: "PROPOSAL",
						reasonKey: "documents.proposal-prompt-not-bound",
						message: NOT_BOUND_MESSAGE,
					},
				],
			},
		});
		expect(mocks.documentCreate).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("skips and reports the Proposal and still runs the rest", async () => {
		const result = await batch(["PRD", "PROPOSAL", "BUSINESS_CASE"]);

		expect(result.skipped).toEqual([
			{
				type: "PROPOSAL",
				reasonKey: "documents.proposal-prompt-not-bound",
				message: NOT_BOUND_MESSAGE,
			},
		]);
		expect(result.documents.map((doc) => doc.type)).toEqual([
			"PRD",
			"BUSINESS_CASE",
		]);
		// No empty draft for the skipped Proposal.
		expect(mocks.documentCreate).toHaveBeenCalledTimes(2);
		expect(startedTypes()).toEqual(["PRD", "BUSINESS_CASE"]);
	});

	it("asks once for the requesting user in the project's own organization", async () => {
		await batch(["PROPOSAL", "PRD", "PROPOSAL"]);

		expect(mocks.findBoundProposalPrompt).toHaveBeenCalledTimes(1);
		expect(mocks.findBoundProposalPrompt).toHaveBeenCalledWith({
			userId: "user_example",
			organizationId: "organization_example",
			projectId: "project_example",
			action: PROPOSAL_CLIENT_MAIN_AGENT_KEY,
		});
	});
});

describe("batchGenerate — everything else is unchanged", () => {
	it("runs a Proposal whose Main prompt is bound", async () => {
		mocks.findBoundProposalPrompt.mockResolvedValue({
			promptId: "prompt_example",
			versionNumber: 3,
			promptVersionId: "prompt_version_example",
		});

		const result = await batch(["PROPOSAL"]);

		expect(result.skipped).toEqual([]);
		expect(startedTypes()).toEqual(["PROPOSAL"]);
	});

	it("runs a Proposal with the gate off, without reading the binding", async () => {
		gateOn = false;

		const result = await batch(["PROPOSAL"]);

		expect(result.skipped).toEqual([]);
		expect(startedTypes()).toEqual(["PROPOSAL"]);
		expect(mocks.findBoundProposalPrompt).not.toHaveBeenCalled();
	});

	it("reads neither the gate nor the binding for a batch without a Proposal", async () => {
		const result = await batch(["PRD", "BUSINESS_CASE"]);

		expect(result.skipped).toEqual([]);
		expect(mocks.isFeatureEnabled).not.toHaveBeenCalledWith(
			"PROPOSAL_ARTIFACT",
			expect.anything(),
		);
		expect(mocks.findBoundProposalPrompt).not.toHaveBeenCalled();
	});
});
