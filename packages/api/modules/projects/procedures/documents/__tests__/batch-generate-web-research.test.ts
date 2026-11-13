/**
 * Batch generation never researches the web. Web research is a per-action
 * consent given for one document; a batch launches many at once with no such
 * consent and multiplies the cost, so the batch route takes no
 * `allowWebResearch` input, issues its token without `webResearch`, and starts
 * its workflow without the field. A request that sends the key anyway gets it
 * stripped at the schema, and the handler forwards nothing even if the key
 * slips past.
 *
 * The procedure chain is stood in for, as in `batch-generate-plan.test.ts`,
 * which means the real oRPC procedure (and its `["~orpc"].inputSchema`) does
 * not exist here. The schema is therefore captured where the procedure hands
 * it to `.input()`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks, captured } = vi.hoisted(() => ({
	mocks: {
		issueAIToken: vi.fn(),
		workflowStart: vi.fn(),
	},
	captured: { inputSchema: undefined as unknown },
}));

vi.mock("@repo/database", () => ({
	isFeatureEnabled: async () => false,
	db: {
		project: {
			findUnique: async () => ({
				id: "project_example",
				name: "Example Project",
				organizationId: "organization_example",
				organization: null,
			}),
		},
		projectDocument: {
			create: async ({
				data,
			}: {
				data: { type: string; title: string };
			}) => ({
				id: `document_${data.type}`,
				type: data.type,
				title: data.title,
				status: "DRAFT",
			}),
		},
	},
}));
vi.mock("../../../../capabilities/flag", () => ({
	isCapabilityGatingEnabled: async () => false,
}));
vi.mock("@repo/ai-token", () => ({ issueAIToken: mocks.issueAIToken }));
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
		input: (schema: unknown) => {
			captured.inputSchema = schema;
			return chain;
		},
		output: () => chain,
		handler: (fn: (...args: unknown[]) => unknown) => ({ _handler: fn }),
	});
	return {
		tenantProtectedProcedure: chain,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireProjectPermission: () => ({}),
	};
});

import { batchGenerateDocumentsProcedure } from "../batch-generate";

type Handler = (args: {
	input: Record<string, unknown>;
	context: { user: { id: string } };
}) => Promise<unknown>;

const handler = (
	batchGenerateDocumentsProcedure as unknown as { _handler: Handler }
)._handler;

const inputSchema = () =>
	captured.inputSchema as {
		parse: (value: unknown) => Record<string, unknown>;
	};

/** A batch request that asks for research at both levels it could. */
const askingForResearch = () => ({
	projectId: "project_example",
	allowWebResearch: true,
	documents: [
		{
			type: "BUSINESS_CASE",
			title: "Business Case",
			prompt: "",
			allowWebResearch: true,
		},
		{ type: "PRD", title: "PRD", prompt: "" },
	],
});

function expectNoResearchReachedTheRun() {
	expect(mocks.issueAIToken).toHaveBeenCalledTimes(1);
	expect(mocks.issueAIToken.mock.calls[0]?.[0]?.webResearch).toBeFalsy();

	expect(mocks.workflowStart).toHaveBeenCalledTimes(1);
	const [workflowName, startOptions] =
		mocks.workflowStart.mock.calls[0] ?? [];
	expect(workflowName).toBe("batchDocumentGenerationWorkflow");
	expect(startOptions.args[0]).not.toHaveProperty("allowWebResearch");
	// Nowhere in the start options either: not on a document, not nested.
	expect(JSON.stringify(startOptions)).not.toMatch(/webresearch/i);
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.issueAIToken.mockResolvedValue("token");
	mocks.workflowStart.mockResolvedValue({
		workflowId: "workflow_example",
		firstExecutionRunId: "run_example",
	});
});

describe("batchGenerate never authorizes web research", () => {
	it("strips a requested permission at the input schema, at both levels", () => {
		expect(inputSchema()).toBeDefined();

		const parsed = inputSchema().parse(askingForResearch());

		expect(parsed).not.toHaveProperty("allowWebResearch");
		const documents = parsed.documents as Array<Record<string, unknown>>;
		expect(documents).toHaveLength(2);
		for (const document of documents) {
			expect(document).not.toHaveProperty("allowWebResearch");
		}
	});

	it("starts an unauthorized run from a parsed request that asked for research", async () => {
		await handler({
			input: inputSchema().parse(askingForResearch()),
			context: { user: { id: "user_example" } },
		});

		expectNoResearchReachedTheRun();
	});

	it("forwards nothing even when the key reaches the handler", async () => {
		await handler({
			input: askingForResearch(),
			context: { user: { id: "user_example" } },
		});

		expectNoResearchReachedTheRun();
	});
});
