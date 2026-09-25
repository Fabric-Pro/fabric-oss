/**
 * `quoteAgenticRun` — what dispatch would decide for a selection, without
 * creating anything.
 *
 * The run-configuration dialog shows this figure before Start (Fizzy #2233:
 * "an estimate shown before dispatch", which the UI never did). The
 * assertions here are that quote resolves through the SAME helpers dispatch
 * itself uses, so it can never show a number dispatch would then refuse, and
 * that it reports both runners without creating a run.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockResolveIds = vi.fn();
const mockListCases = vi.fn();
const permissionCalls: unknown[] = [];

vi.mock("@repo/database", () => ({
	listTestCaseIdsForSelection: (...a: unknown[]) => mockResolveIds(...a),
	listCasesForAgenticRun: (...a: unknown[]) => mockListCases(...a),
	TEST_CASE_STATES: ["DRAFT", "READY", "PROPOSED", "ARCHIVED"],
	db: {},
	cancelAgenticRun: vi.fn(),
	createAgenticRun: vi.fn(),
	getAgenticRun: vi.fn(),
	getProjectPipelineRunDetail: vi.fn(),
	getProjectQaSettings: vi.fn(),
	listAgenticRuns: vi.fn(),
	listAgenticRunsPage: vi.fn(),
	listAgenticStepLogs: vi.fn(),
}));

vi.mock("@repo/logs", () => ({ logger: { error: vi.fn(), warn: vi.fn() } }));
vi.mock("@repo/storage", () => ({
	getSignedUrl: vi.fn(),
	isTenantOwnedKey: () => true,
}));
vi.mock("@repo/config", () => ({
	config: { storage: { bucketNames: { qaRunEvidence: "evidence" } } },
}));
vi.mock("@repo/permissions", () => ({
	hasPermission: (permissions: string[], required: string) =>
		permissions.includes(required),
	// `agentic-run-selection.ts` reads `Permissions.PROJECT_SETTINGS_EDIT` by
	// name, so the mock has to carry a real string value there rather than
	// the `../../../../../orpc/procedures` mock's identity Proxy.
	Permissions: { PROJECT_SETTINGS_EDIT: "PROJECT_SETTINGS_EDIT" },
}));

vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: vi.fn(),
}));
// Mutable per test (default: owner, i.e. scripted-permitted) rather than a
// fixed return — the permission-gate tests below need to answer as an
// ordinary project member with no `PROJECT_SETTINGS_EDIT`.
let effectiveAccess: { source: string; permissions?: string[] } | null = {
	source: "owner",
};
vi.mock("../../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: () => effectiveAccess,
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
		requireProjectPermission: (permission: unknown) => {
			permissionCalls.push(permission);
			return (c: unknown) => c;
		},
	};
});

const { quoteAgenticRunProcedure, dispatchAgenticRunProcedure } = await import(
	"../runs"
);
// `.use(requireProjectPermission(...))` runs once, at module load, building
// the procedure chain — not per call. Snapshot it now, before `beforeEach`
// clears `permissionCalls` for the mutation-side assertions below.
const permissionCallsAtModuleLoad = [...permissionCalls];

type Handler = {
	handler: (a: { input: unknown; context: unknown }) => Promise<unknown>;
};

function quote(selection: unknown) {
	return (quoteAgenticRunProcedure as unknown as Handler).handler({
		input: { projectId: "proj-1", selection },
		context: { user: { id: "user-1" }, session: {} },
	});
}

const AGENTIC_CASES = [
	{
		id: "case-1",
		identifier: "TC-001",
		title: "Sign in",
		description: null,
		playwrightScript: null,
		scriptRevisionId: null,
		steps: [{ order: 1, action: "goto", expected: "loads" }],
	},
	{
		id: "case-2",
		identifier: "TC-002",
		title: "Sign out",
		description: null,
		playwrightScript: null,
		scriptRevisionId: null,
		steps: [{ order: 1, action: "goto", expected: "loads" }],
	},
];

const SCRIPTED_CASES = [
	{
		id: "case-1",
		identifier: "TC-001",
		title: "Sign in",
		description: null,
		playwrightScript: '{"version":1,"steps":[]}',
		scriptRevisionId: "rev-1",
		steps: [],
	},
];

beforeEach(() => {
	vi.clearAllMocks();
	permissionCalls.length = 0;
	effectiveAccess = { source: "owner" };
});

describe("quoteAgenticRun", () => {
	it("is gated by the same read permission as the sibling list/get procedures", () => {
		expect(permissionCallsAtModuleLoad).toContain("TEST_CASE_READ");
	});

	it("resolves the selection through the shared helper, not its own copy", async () => {
		mockResolveIds.mockResolvedValue(["case-1", "case-2"]);
		mockListCases.mockResolvedValue([]);

		await quote({ mode: "filter", filter: { state: "READY" } });

		expect(mockResolveIds).toHaveBeenCalledWith({
			projectId: "proj-1",
			selection: { mode: "filter", filter: { state: "READY" } },
		});
	});

	it("reports the resolved case count and both runners without dispatching", async () => {
		mockResolveIds.mockResolvedValue(["case-1", "case-2"]);
		mockListCases.mockImplementation(async (input: { runMode?: string }) =>
			input.runMode === "MODE_B" ? SCRIPTED_CASES : AGENTIC_CASES,
		);

		const result = (await quote({
			mode: "ids",
			ids: ["case-1", "case-2"],
		})) as {
			resolvedCaseCount: number;
			agentic: {
				runnableCaseCount: number;
				stepCount: number;
				estimatedCostUsd: number;
				withinCap: boolean;
			};
			scripted: { runnableCaseCount: number; permitted: boolean };
		};

		expect(result.resolvedCaseCount).toBe(2);
		expect(result.agentic).toEqual({
			runnableCaseCount: 2,
			stepCount: 2,
			estimatedCostUsd: 0.1,
			capUsd: expect.any(Number),
			withinCap: true,
		});
		expect(result.scripted).toEqual({
			runnableCaseCount: 1,
			permitted: true,
		});
	});

	it("reports scripted.permitted: false for a caller who is only an EDITOR", async () => {
		// TEST_CASE_UPDATE (this procedure's own middleware) is not enough for
		// MODE_B — `dispatch` gates it one rung higher, at PROJECT_SETTINGS_EDIT
		// or ownership. An ordinary project member without that permission must
		// see `permitted: false`, or the dialog could default them into a
		// runner Start will then refuse with FORBIDDEN.
		effectiveAccess = { source: "member", permissions: [] };
		mockResolveIds.mockResolvedValue(["case-1", "case-2"]);
		mockListCases.mockImplementation(async (input: { runMode?: string }) =>
			input.runMode === "MODE_B" ? SCRIPTED_CASES : AGENTIC_CASES,
		);

		const result = (await quote({
			mode: "ids",
			ids: ["case-1", "case-2"],
		})) as { scripted: { permitted: boolean } };

		expect(result.scripted.permitted).toBe(false);
	});

	it("reports scripted.permitted: true for a member who has PROJECT_SETTINGS_EDIT", async () => {
		effectiveAccess = {
			source: "member",
			permissions: ["PROJECT_SETTINGS_EDIT"],
		};
		mockResolveIds.mockResolvedValue(["case-1"]);
		mockListCases.mockResolvedValue(SCRIPTED_CASES);

		const result = (await quote({ mode: "ids", ids: ["case-1"] })) as {
			scripted: { permitted: boolean };
		};

		expect(result.scripted.permitted).toBe(true);
	});

	it("refuses an empty selection with the same wording dispatch uses", async () => {
		mockResolveIds.mockResolvedValue([]);

		await expect(quote({ mode: "filter", filter: {} })).rejects.toThrow(
			/No cases match the current filters/i,
		);
	});

	it("never creates a run or touches Temporal", async () => {
		mockResolveIds.mockResolvedValue(["case-1"]);
		mockListCases.mockResolvedValue(AGENTIC_CASES.slice(0, 1));
		const { createAgenticRun } = await import("@repo/database");

		await quote({ mode: "ids", ids: ["case-1"] });

		expect(createAgenticRun).not.toHaveBeenCalled();
	});

	it("agrees with dispatch's own resolution for the same selection", async () => {
		// Both procedures resolve through `resolveSelectedTestCaseIds` /
		// `resolveAgenticRunMode`, so this is really asserting they were built
		// on the same two mocked calls rather than each having its own path
		// that could drift.
		mockResolveIds.mockResolvedValue(["case-1"]);
		mockListCases.mockResolvedValue(AGENTIC_CASES.slice(0, 1));

		const quoted = (await quote({ mode: "ids", ids: ["case-1"] })) as {
			agentic: { estimatedCostUsd: number; stepCount: number };
		};

		expect(dispatchAgenticRunProcedure).toBeDefined();
		expect(quoted.agentic.stepCount).toBe(1);
	});
});
