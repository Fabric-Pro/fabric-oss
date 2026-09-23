/**
 * Create-with-AI is gated BEFORE the create write (Fizzy #1930).
 *
 * Creating a document stands down every active document of the same type. For
 * a generator grounded by an existing document of its own type — a second
 * architecture document, when the first is the project's only architecture
 * source — the gate re-read after that write no longer sees the source, and
 * refused a run it had just allowed: the real document demoted, an empty draft
 * in its place, and an error. Every refusal from the API left an orphan draft.
 *
 * So the gate is asserted before the write, and the dispatcher is told it was.
 * These tests run the real gate (rules, resolver, assert) and the real
 * dispatcher; the evidence the gate reads is stood in for by a stub that
 * DEMOTES the existing document when the create write runs — exactly what the
 * write does to the rows the gather reads.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks, state } = vi.hoisted(() => ({
	mocks: {
		projectFindUnique: vi.fn(),
		createDocumentWithContent: vi.fn(),
		gatherCapabilityEvidence: vi.fn(),
		workflowStart: vi.fn(),
		markDocumentGenerationQueued: vi.fn(),
	},
	state: { architectureActive: true },
}));

vi.mock("@repo/database", () => ({
	createDocument: vi.fn(),
	hasProjectAccess: vi.fn(),
	db: { project: { findUnique: mocks.projectFindUnique } },
}));

vi.mock("../../lib/create-document-with-content", () => ({
	createDocumentWithContent: mocks.createDocumentWithContent,
}));

vi.mock("@repo/database/prisma/queries/projects/documents", () => ({
	markDocumentGenerationQueued: mocks.markDocumentGenerationQueued,
	markDocumentGenerationFailed: vi.fn(),
}));

vi.mock("../../../capabilities/flag", () => ({
	isCapabilityGatingEnabled: async () => true,
}));

vi.mock("../../../capabilities/evidence", () => ({
	gatherCapabilityEvidence: mocks.gatherCapabilityEvidence,
}));

vi.mock("@repo/ai-token", () => ({ issueAIToken: async () => "token" }));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({
		workflow: {
			start: mocks.workflowStart,
			getHandle: () => ({ describe: vi.fn() }),
		},
	}),
}));

vi.mock("../../../../lib/realtime", () => ({
	emitDocumentChange: vi.fn(async () => undefined),
	emitActivity: vi.fn(async () => undefined),
}));

vi.mock("../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: <T>(args: T) => args,
}));

vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../../../orpc/procedures", () => {
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
		resolveOrganizationId: () => "organization_example",
	};
});

import { evidenceWith } from "../../../capabilities/__tests__/evidence-fixture";
import { createDocumentProcedure } from "../create-document";

type Handler = (args: {
	input: Record<string, unknown>;
	context: { user: { id: string }; session: Record<string, unknown> };
}) => Promise<unknown>;

const handler = (createDocumentProcedure as unknown as { _handler: Handler })
	._handler;

/** A project whose ONLY grounding for an architecture document is one. */
function evidenceNow() {
	return evidenceWith({
		codebase: { connected: false, integrationStatus: null, usable: false },
		context: { total: 0, technical: 0, product: 0 },
		documents: {
			usableTypes: new Set(
				state.architectureActive ? ["ARCHITECTURE"] : [],
			),
		},
		descriptionLength: 0,
	});
}

function createArchitectureWithAI() {
	return handler({
		input: {
			projectId: "project_example",
			type: "ARCHITECTURE",
			title: "Architecture",
			content: "",
			generateWithAi: true,
		},
		context: { user: { id: "user_example" }, session: {} },
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	state.architectureActive = true;
	mocks.projectFindUnique.mockResolvedValue({
		id: "project_example",
		name: "Example Project",
		organizationId: "organization_example",
	});
	mocks.gatherCapabilityEvidence.mockImplementation(async () =>
		evidenceNow(),
	);
	// The write stands down the existing active architecture document, which
	// is what takes the gate's source away.
	mocks.createDocumentWithContent.mockImplementation(async () => {
		state.architectureActive = false;
		return {
			document: { id: "document_new", type: "ARCHITECTURE" },
			context: null,
			displacedCount: 1,
		};
	});
	mocks.markDocumentGenerationQueued.mockResolvedValue({ applied: true });
	mocks.workflowStart.mockResolvedValue({
		workflowId: "workflow_example",
		firstExecutionRunId: "run_example",
	});
});

describe("createDocument with AI — the capability gate runs before the write", () => {
	it("generates when an existing document of the same type was the only source", async () => {
		await expect(createArchitectureWithAI()).resolves.toBeDefined();

		expect(mocks.createDocumentWithContent).toHaveBeenCalledTimes(1);
		expect(mocks.workflowStart).toHaveBeenCalledTimes(1);
		// Read once, before the write. A second read after it would see the
		// demoted document and refuse.
		expect(mocks.gatherCapabilityEvidence).toHaveBeenCalledTimes(1);
		expect(
			mocks.gatherCapabilityEvidence.mock.invocationCallOrder[0],
		).toBeLessThan(
			mocks.createDocumentWithContent.mock.invocationCallOrder[0],
		);
	});

	it("refuses with 412 and writes nothing when the project has no source", async () => {
		state.architectureActive = false;

		await expect(createArchitectureWithAI()).rejects.toMatchObject({
			code: "PRECONDITION_FAILED",
		});

		// Nothing demoted, no empty draft, no run.
		expect(mocks.createDocumentWithContent).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});
});

describe("createDocument with AI — pasted source on the default project shape", () => {
	it("generates an API specification from pasted text with code search off", async () => {
		// Repository connected, code search off, a PRD and nothing else: the
		// repository is the API specification's only possible source and it
		// is not ready. The pasted API docs are the source; the door lets the
		// request through (Fizzy #1930 D1).
		mocks.gatherCapabilityEvidence.mockResolvedValue(
			evidenceWith({
				codebase: {
					usable: false,
					indexingEnabled: false,
					lastIndexCompletedAt: null,
				},
				context: { total: 0, technical: 0, product: 0 },
				documents: { usableTypes: new Set(["PRD"]) },
			}),
		);
		mocks.createDocumentWithContent.mockResolvedValue({
			document: { id: "document_new", type: "API_SPEC" },
			context: { id: "context_new" },
			displacedCount: 0,
		});

		await expect(
			handler({
				input: {
					projectId: "project_example",
					type: "API_SPEC",
					title: "API",
					content: "",
					generateWithAi: true,
					sourceText: "GET /v1/orders returns the order list.",
					sourceUsage: "CONTEXT",
				},
				context: { user: { id: "user_example" }, session: {} },
			}),
		).resolves.toBeDefined();
		expect(mocks.workflowStart).toHaveBeenCalled();
	});
});
