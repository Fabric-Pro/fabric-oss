/**
 * The capability gate on starting Atlas analysis (Fizzy #1930).
 *
 * The gate is asserted at the procedure, not inferred from a disabled button,
 * because this route is reachable from the public API, MCP tools and agents. So
 * what is pinned here is the door itself: a project with no connected
 * repository is refused with PRECONDITION_FAILED naming the thing it is
 * missing, and — the half that is easy to lose — nothing downstream runs.
 *
 * The real `assert.ts`, `registry.ts` and `resolve.ts` run. Only the guard's two
 * inputs are mocked: the feature flag, and the evidence gather. Mocking the
 * assert itself would prove the call exists and nothing about the refusal.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks } = vi.hoisted(() => ({
	handlers: {} as Record<string, (...args: unknown[]) => unknown>,
	mocks: {
		isFeatureEnabled: vi.fn(),
		gatherCapabilityEvidence: vi.fn(),
		requestAnalysis: vi.fn(),
		markStatus: vi.fn(),
		workflowStart: vi.fn(),
	},
}));

vi.mock("@repo/database", () => ({
	isFeatureEnabled: mocks.isFeatureEnabled,
}));

vi.mock("../../../capabilities/evidence", () => ({
	gatherCapabilityEvidence: mocks.gatherCapabilityEvidence,
}));

vi.mock("@repo/atlas", () => {
	class AtlasError extends Error {
		readonly code: string;
		constructor(code: string, message: string) {
			super(message);
			this.code = code;
			this.name = "AtlasError";
		}
	}
	return {
		AtlasError,
		AtlasService: class {
			requestAnalysis = mocks.requestAnalysis;
			markStatus = mocks.markStatus;
		},
		analyzeInputSchema: {},
	};
});

vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({
		workflow: { start: mocks.workflowStart },
	}),
}));

vi.mock("../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: <T>(args: T) => args,
}));

vi.mock("../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.analyze = fn;
			return { _handler: fn };
		},
	});
	return {
		tenantProtectedProcedure: chainable,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => (c: unknown) => c,
		requireProjectPermission: () => (c: unknown) => c,
		resolveOrganizationId: (organizationId: string | null | undefined) =>
			organizationId ?? null,
	};
});

process.env.FABRIC_FEATURE_ATLAS = "true";

await import("../analyze");

import {
	evidenceWith,
	healthyEvidence,
} from "../../../capabilities/__tests__/evidence-fixture";

const ctx = {
	user: { id: "user_example" },
	session: { id: "session_example", activeOrganizationId: null },
};

function runAnalyze() {
	return handlers.analyze({
		input: {
			projectId: "project_example",
			organizationId: null,
			fresh: false,
		},
		context: ctx,
	}) as Promise<unknown>;
}

async function errorFrom(promise: Promise<unknown>) {
	try {
		await promise;
	} catch (err) {
		return err as { code?: string; message?: string };
	}
	throw new Error("expected the handler to throw");
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.isFeatureEnabled.mockResolvedValue(true);
	mocks.gatherCapabilityEvidence.mockResolvedValue(healthyEvidence());
	mocks.requestAnalysis.mockResolvedValue({
		analysisId: "analysis_example",
		status: "PENDING",
		workflowName: "atlasAnalysisWorkflow",
		taskQueue: "fabric-worker",
		workflowId: "atlas-analysis-example",
		workflowArgs: {},
	});
	mocks.workflowStart.mockResolvedValue({
		workflowId: "atlas-analysis-example",
	});
});

describe("analyzeProcedure — the capability door", () => {
	it("refuses with PRECONDITION_FAILED naming the repository it needs", async () => {
		mocks.gatherCapabilityEvidence.mockResolvedValue(
			evidenceWith({ codebase: { connected: false } }),
		);

		const err = await errorFrom(runAnalyze());

		expect(err.code).toBe("PRECONDITION_FAILED");
		// Naming the prerequisite is the requirement, not announcing a verdict.
		expect(err.message).toContain("a connected repository");
	});

	it("refuses BEFORE any analysis is requested or dispatched", async () => {
		mocks.gatherCapabilityEvidence.mockResolvedValue(
			evidenceWith({ codebase: { connected: false } }),
		);

		await errorFrom(runAnalyze());

		expect(mocks.requestAnalysis).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("proceeds when the repository is connected and indexed", async () => {
		await expect(runAnalyze()).resolves.toBe("PENDING");
		expect(mocks.requestAnalysis).toHaveBeenCalledTimes(1);
		expect(mocks.workflowStart).toHaveBeenCalledTimes(1);
	});

	it("is inert with the flag off — no evidence read, no refusal", async () => {
		mocks.isFeatureEnabled.mockResolvedValue(false);
		mocks.gatherCapabilityEvidence.mockResolvedValue(
			evidenceWith({ codebase: { connected: false } }),
		);

		await expect(runAnalyze()).resolves.toBe("PENDING");
		expect(mocks.gatherCapabilityEvidence).not.toHaveBeenCalled();
	});

	it("resolves the gate for this project and viewer, not the caller's input", async () => {
		await runAnalyze();

		expect(mocks.gatherCapabilityEvidence).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "project_example",
				userId: "user_example",
				organizationId: null,
			}),
		);
	});
});
