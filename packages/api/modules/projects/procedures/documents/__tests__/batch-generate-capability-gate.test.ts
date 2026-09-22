/**
 * The capability gate on batch document generation (Fizzy #1930).
 *
 * The public batch route — used by the project pipeline and the creation
 * wizard — generated architecture, technical and API specifications with no
 * gate at all. It now resolves each type's gate before writing anything, skips
 * the types that cannot run and reports them, and counts the batch's own
 * earlier types as on their way (the workflow generates in dependency order).
 *
 * The rules, resolver and batch door run for real; the flag, the evidence
 * gather, the database and Temporal are stood in for.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		gatherCapabilityEvidence: vi.fn(),
		documentCreate: vi.fn(),
		workflowStart: vi.fn(),
	},
}));

vi.mock("@repo/database", () => ({
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

vi.mock("../../../../capabilities/flag", () => ({
	isCapabilityGatingEnabled: async () => true,
}));
vi.mock("../../../../capabilities/evidence", () => ({
	gatherCapabilityEvidence: mocks.gatherCapabilityEvidence,
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

import { evidenceWith } from "../../../../capabilities/__tests__/evidence-fixture";
import { batchGenerateDocumentsProcedure } from "../batch-generate";

type Handler = (args: {
	input: Record<string, unknown>;
	context: { user: { id: string } };
}) => Promise<{
	documents: Array<{ type: string }>;
	skipped: Array<{ type: string; reasonKey: string | null }>;
}>;

const handler = (
	batchGenerateDocumentsProcedure as unknown as { _handler: Handler }
)._handler;

function batch(types: string[]) {
	return handler({
		input: {
			projectId: "project_example",
			documents: types.map((type) => ({ type, title: type, prompt: "" })),
		},
		context: { user: { id: "user_example" } },
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	// A brand-new project: nothing to ground anything on, no repository.
	mocks.gatherCapabilityEvidence.mockResolvedValue(
		evidenceWith({
			codebase: {
				connected: false,
				integrationStatus: null,
				usable: false,
			},
			context: { total: 0, technical: 0, product: 0 },
			documents: { usableTypes: new Set<string>() },
			descriptionLength: 0,
		}),
	);
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

describe("batchGenerate — the capability door", () => {
	it("runs a wizard batch whose later types are grounded by its earlier ones", async () => {
		const result = await batch(["PRD", "ARCHITECTURE", "TECHNICAL_SPEC"]);

		expect(result.skipped).toEqual([]);
		expect(result.documents.map((doc) => doc.type)).toEqual([
			"PRD",
			"ARCHITECTURE",
			"TECHNICAL_SPEC",
		]);
	});

	it("skips and reports a type nothing grounds, and still runs the rest", async () => {
		const result = await batch(["PROPOSAL", "API_SPEC"]);

		expect(result.skipped).toMatchObject([
			{ type: "API_SPEC", reasonKey: "documents.no-api-source" },
		]);
		// No empty draft for the skipped type.
		expect(result.documents.map((doc) => doc.type)).toEqual(["PROPOSAL"]);
		expect(mocks.documentCreate).toHaveBeenCalledTimes(1);
		expect(mocks.workflowStart).toHaveBeenCalledTimes(1);
	});

	it("refuses outright, writing nothing, when every type is refused", async () => {
		await expect(batch(["API_SPEC"])).rejects.toMatchObject({
			code: "PRECONDITION_FAILED",
		});
		expect(mocks.documentCreate).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});
});
