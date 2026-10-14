/**
 * A batch is bulk work (Fizzy #2770): it never runs on the clicker's own
 * ChatGPT plan, and runs on the organization's shared plans instead. The run
 * carries the batch job type, so every model call in it resolves as that job,
 * and the token handed to the agents that write each document carries the
 * same job, so the exchange resolves them on the shared plans too. Both
 * halves are needed — agents holding a job-less token would bill the
 * organization's provider for every document.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		issueAIToken: vi.fn(),
		workflowStart: vi.fn(),
	},
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

import { batchGenerateDocumentsProcedure } from "../batch-generate";

type Handler = (args: {
	input: Record<string, unknown>;
	context: { user: { id: string } };
}) => Promise<unknown>;

const handler = (
	batchGenerateDocumentsProcedure as unknown as { _handler: Handler }
)._handler;

beforeEach(() => {
	vi.clearAllMocks();
	mocks.issueAIToken.mockResolvedValue("token");
	mocks.workflowStart.mockResolvedValue({
		workflowId: "workflow_example",
		firstExecutionRunId: "run_example",
	});
});

describe("batchGenerate on the organization's shared ChatGPT plans", () => {
	it("runs as the batch job, naming who started it, never on their own plan", async () => {
		await handler({
			input: {
				projectId: "project_example",
				documents: [{ type: "PRD", title: "PRD", prompt: "" }],
			},
			context: { user: { id: "user_example" } },
		});

		const args = mocks.workflowStart.mock.calls[0]?.[1].args[0];
		expect(args).toMatchObject({
			userId: "user_example",
			jobType: "batch-document-generation",
			aiToken: "token",
		});
		expect(args).not.toHaveProperty("planEligible");
	});

	it("hands the document agents a token carrying the batch job, not the plan claim", async () => {
		await handler({
			input: {
				projectId: "project_example",
				documents: [{ type: "PRD", title: "PRD", prompt: "" }],
			},
			context: { user: { id: "user_example" } },
		});

		expect(mocks.issueAIToken).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user_example",
				organizationId: "organization_example",
				jobType: "batch-document-generation",
			}),
		);
		expect(mocks.issueAIToken.mock.calls[0]?.[0]).not.toHaveProperty(
			"planEligible",
		);
	});
});
