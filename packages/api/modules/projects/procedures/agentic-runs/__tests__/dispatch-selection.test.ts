/**
 * `dispatchAgenticRun` — which cases a run actually covers.
 *
 * The handler had no test of its own: its cost and production guards were
 * covered, and the procedure that calls them was not. That gap is why "Select
 * all N matching" could leave the Run button dead for as long as it did — the
 * selection arrived as a predicate, the handler only understood ids, and nothing
 * asserted the two agreed.
 *
 * The assertions here are about the SET, not the run: that a filter resolves
 * server-side, that the cap applies to what the filter matched rather than to
 * the size of the request, and that the refusal says how many were matched.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockResolveIds = vi.fn();
const mockListCases = vi.fn();
const mockSettings = vi.fn();
const mockCreateRun = vi.fn();
const mockEnvFindFirst = vi.fn();
const mockProjectFindUnique = vi.fn();

vi.mock("@repo/database", () => ({
	db: {
		project: {
			findUnique: (...a: unknown[]) => mockProjectFindUnique(...a),
		},
		projectEnvironment: {
			findFirst: (...a: unknown[]) => mockEnvFindFirst(...a),
		},
	},
	listTestCaseIdsForSelection: (...a: unknown[]) => mockResolveIds(...a),
	listCasesForAgenticRun: (...a: unknown[]) => mockListCases(...a),
	getProjectQaSettings: (...a: unknown[]) => mockSettings(...a),
	createAgenticRun: (...a: unknown[]) => mockCreateRun(...a),
	cancelAgenticRun: vi.fn(),
	getAgenticRun: vi.fn(),
	getProjectPipelineRunDetail: vi.fn(),
	listAgenticRuns: vi.fn(),
	listAgenticRunsPage: vi.fn(),
	listAgenticStepLogs: vi.fn(),
	TEST_CASE_STATES: ["DRAFT", "READY", "PROPOSED", "ARCHIVED"],
}));

vi.mock("@repo/logs", () => ({ logger: { error: vi.fn(), warn: vi.fn() } }));
vi.mock("@repo/storage", () => ({
	getSignedUrl: vi.fn(),
	isTenantOwnedKey: () => true,
}));
vi.mock("@repo/config", () => ({
	config: { storage: { bucketNames: { qaRunEvidence: "evidence" } } },
}));
vi.mock("@repo/permissions", () => ({ hasPermission: () => true }));

vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: vi.fn(),
}));
vi.mock("../../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: () => ({ source: "owner" }),
}));
vi.mock("../../../lib/pipeline-results-feature", () => ({
	assertPipelineResultsEnabled: () => undefined,
}));

vi.mock("../../../../../orpc/procedures", () => {
	const builder: Record<string, unknown> = {};
	builder.use = () => builder;
	builder.route = () => builder;
	builder.input = () => builder;
	builder.output = () => builder;
	builder.handler = (fn: unknown) => ({ handler: fn });
	return {
		tenantProtectedProcedure: builder,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireProjectPermission: () => (c: unknown) => c,
	};
});

const { dispatchAgenticRunProcedure } = await import("../runs");
const { MAX_CASES_PER_RUN } = await import("../../../lib/agentic-run-cost");

type Handler = {
	handler: (a: { input: unknown; context: unknown }) => Promise<unknown>;
};

const ENVIRONMENT = {
	id: "env-1",
	name: "Staging",
	type: "STAGING",
	baseUrl: "https://example.com",
	signInUrl: null,
	authKind: "NONE",
	authUsername: null,
	authHeaderName: null,
};

function run(selection: unknown) {
	return (dispatchAgenticRunProcedure as unknown as Handler).handler({
		input: { projectId: "proj-1", selection, runMode: "MODE_A" },
		context: { user: { id: "user-1" }, session: {} },
	});
}

const idsOf = (n: number) => Array.from({ length: n }, (_, i) => `case-${i}`);

beforeEach(() => {
	vi.clearAllMocks();
	mockProjectFindUnique.mockResolvedValue({
		organizationId: "org-1",
		userId: null,
	});
	mockSettings.mockResolvedValue({
		defaultEnvironmentId: "env-1",
		browsers: ["chromium"],
		resolutions: ["1920x1080"],
		evidencePolicy: "REQUIRED",
	});
	mockEnvFindFirst.mockResolvedValue(ENVIRONMENT);
});

describe("dispatchAgenticRun — resolving the selection", () => {
	it("resolves a FILTER selection server-side instead of refusing it", async () => {
		// The regression this whole change exists for: a predicate carries no
		// ids, and the handler must ask the database which cases it names.
		mockResolveIds.mockResolvedValue(["case-1", "case-2"]);
		mockListCases.mockResolvedValue([]);

		await run({ mode: "filter", filter: { state: "READY" } }).catch(
			() => undefined,
		);

		expect(mockResolveIds).toHaveBeenCalledWith({
			projectId: "proj-1",
			selection: { mode: "filter", filter: { state: "READY" } },
		});
	});

	it("refuses a filter that matches nothing, and says so", async () => {
		mockResolveIds.mockResolvedValue([]);

		await expect(
			run({ mode: "filter", filter: { state: "ARCHIVED" } }),
		).rejects.toThrow(/No cases match the current filters/i);
	});

	it("refuses an empty id selection with the selection wording, not the filter wording", async () => {
		mockResolveIds.mockResolvedValue([]);

		await expect(run({ mode: "ids", ids: ["gone"] })).rejects.toThrow(
			/Select at least one case to run/i,
		);
	});

	it("applies the cap to what the filter MATCHED, and names the number", async () => {
		// A filter is allowed to name thousands; what cannot happen is a run
		// holding thousands of browser sessions open. The refusal has to state
		// the matched count, because the reader never typed it.
		const matched = MAX_CASES_PER_RUN + 25;
		mockResolveIds.mockResolvedValue(idsOf(matched));

		await expect(run({ mode: "filter", filter: {} })).rejects.toThrow(
			new RegExp(
				`matches ${matched} cases.*at most ${MAX_CASES_PER_RUN}`,
				"i",
			),
		);
	});

	it("passes the resolved ids to the case lookup, not the raw selection", async () => {
		mockResolveIds.mockResolvedValue(["case-7", "case-9"]);
		mockListCases.mockResolvedValue([]);

		await run({ mode: "filter", filter: { priority: "HIGH" } }).catch(
			() => undefined,
		);

		expect(mockListCases).toHaveBeenCalledWith(
			expect.objectContaining({ testCaseIds: ["case-7", "case-9"] }),
		);
	});
});
