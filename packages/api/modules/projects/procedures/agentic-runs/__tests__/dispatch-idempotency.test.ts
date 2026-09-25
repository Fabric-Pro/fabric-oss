/**
 * `dispatchAgenticRun` — the idempotency key (Fizzy #2233 follow-up).
 *
 * The run id used to be a fresh `cuid()` on every dispatch, so a same-tick
 * double click or a network retry created a second run — and a second bill —
 * for one Start press. The client now sends a key that stays stable across
 * retries of the SAME attempt; the server turns it into the run's own id
 * (`deriveIdempotentRunId`), so a retried dispatch collides on the primary
 * key (P2002) instead of racing a second insert. These assertions are about
 * that collapse: the SAME key returns the SAME run, a DIFFERENT user's same
 * key does not, an absent key changes nothing, and a deduplicated dispatch
 * writes no second audit row.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockResolveIds = vi.fn();
const mockListCases = vi.fn();
const mockSettings = vi.fn();
const mockCreateRun = vi.fn();
const mockGetRun = vi.fn();
const mockEnvFindFirst = vi.fn();
const mockProjectFindUnique = vi.fn();
const mockAudit = vi.fn();
const mockWorkflowStart = vi.fn();
const mockGetTemporalClient = vi.fn();

/** A minimal stand-in for Prisma's own error class — real enough that
 * `err instanceof Prisma.PrismaClientKnownRequestError` narrows on it. */
class FakePrismaKnownRequestError extends Error {
	code: string;
	constructor(message: string, code: string) {
		super(message);
		this.code = code;
	}
}

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
	getAgenticRun: (...a: unknown[]) => mockGetRun(...a),
	cancelAgenticRun: vi.fn(),
	getProjectPipelineRunDetail: vi.fn(),
	listAgenticRuns: vi.fn(),
	listAgenticRunsPage: vi.fn(),
	listAgenticStepLogs: vi.fn(),
	Prisma: { PrismaClientKnownRequestError: FakePrismaKnownRequestError },
	TEST_CASE_STATES: ["DRAFT", "READY", "PROPOSED", "ARCHIVED"],
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: (...a: unknown[]) => mockGetTemporalClient(...a),
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
	recordAuditFromRequest: (...a: unknown[]) => mockAudit(...a),
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

const CASE = {
	id: "case-1",
	identifier: "TC-001",
	title: "Sign in",
	description: null,
	playwrightScript: null,
	scriptRevisionId: null,
	steps: [{ order: 1, action: "click", expected: "It works" }],
};

function dispatch(input: {
	userId?: string;
	idempotencyKey?: string;
	stepsPerCase?: number;
}) {
	const cases = input.stepsPerCase
		? [
				{
					...CASE,
					steps: Array.from(
						{ length: input.stepsPerCase },
						(_, i) => ({
							order: i + 1,
							action: "click",
							expected: "It works",
						}),
					),
				},
			]
		: [CASE];
	mockListCases.mockResolvedValue(cases);
	return (dispatchAgenticRunProcedure as unknown as Handler).handler({
		input: {
			projectId: "proj-1",
			selection: { mode: "ids", ids: ["case-1"] },
			runMode: "MODE_A",
			idempotencyKey: input.idempotencyKey,
		},
		context: {
			user: { id: input.userId ?? "user-1" },
			session: {},
			ip: "127.0.0.1",
		},
	});
}

/** A tiny in-memory stand-in for the `TestAgenticRun` table, scoped by
 * primary key — enough to make `createAgenticRun` / `getAgenticRun` behave
 * exactly as their real P2002-then-lookup contract does. */
function installFakeRunTable() {
	const rows = new Map<string, Record<string, unknown>>();
	let counter = 0;
	mockCreateRun.mockImplementation(
		async (input: Record<string, unknown> & { id?: string }) => {
			const id = input.id ?? `generated-${++counter}`;
			if (rows.has(id)) {
				throw new FakePrismaKnownRequestError(
					"Unique constraint failed",
					"P2002",
				);
			}
			const refused = input.refusal != null;
			const row = {
				...input,
				id,
				status: refused ? "REFUSED" : "QUEUED",
				refusalReason: refused
					? (input.refusal as { reason: string }).reason
					: null,
			};
			rows.set(id, row);
			return row;
		},
	);
	mockGetRun.mockImplementation(
		async (input: { projectId: string; runId: string }) => {
			const row = rows.get(input.runId);
			return row && row.projectId === input.projectId ? row : null;
		},
	);
	return rows;
}

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
	mockResolveIds.mockResolvedValue(["case-1"]);
	mockAudit.mockResolvedValue(undefined);
	mockWorkflowStart.mockResolvedValue(undefined);
	mockGetTemporalClient.mockResolvedValue({
		workflow: { start: mockWorkflowStart },
	});
	installFakeRunTable();
});

const KEY_A = "11111111-1111-1111-1111-111111111111";

describe("dispatchAgenticRun — the same key collapses a retry", () => {
	it("returns the SAME run, deduplicated, on a second dispatch with the same key", async () => {
		const first = (await dispatch({ idempotencyKey: KEY_A })) as {
			run: { id: string };
			deduplicated: boolean;
		};
		const second = (await dispatch({ idempotencyKey: KEY_A })) as {
			run: { id: string };
			deduplicated: boolean;
			dispatched: boolean;
		};

		expect(first.deduplicated).toBe(false);
		expect(second.deduplicated).toBe(true);
		expect(second.dispatched).toBe(true);
		expect(second.run.id).toBe(first.run.id);
	});

	it("calls createAgenticRun with the SAME derived id on both attempts", async () => {
		await dispatch({ idempotencyKey: KEY_A });
		await dispatch({ idempotencyKey: KEY_A });

		const ids = mockCreateRun.mock.calls.map(
			(c) => (c[0] as { id?: string }).id,
		);
		expect(ids).toHaveLength(2);
		expect(ids[0]).toBeTruthy();
		expect(ids[0]).toBe(ids[1]);
	});

	it("starts the workflow with the SAME workflow id on both attempts", async () => {
		await dispatch({ idempotencyKey: KEY_A });
		await dispatch({ idempotencyKey: KEY_A });

		expect(mockWorkflowStart).toHaveBeenCalledTimes(2);
		const workflowIds = mockWorkflowStart.mock.calls.map(
			(c) => (c[1] as { workflowId: string }).workflowId,
		);
		expect(workflowIds[0]).toBe(workflowIds[1]);
	});

	it("does not restart the workflow once a worker has claimed the run", async () => {
		// A late retry of the same key, after the first run was picked up. A
		// completed workflow id may run again under ALLOW_DUPLICATE, and the
		// workflow does not stop when its start claim fails — so restarting
		// here would re-run and re-bill the cases.
		const rows = installFakeRunTable();
		const first = (await dispatch({ idempotencyKey: KEY_A })) as {
			run: { id: string };
		};
		const claimed = rows.get(first.run.id);
		if (!claimed) {
			throw new Error("first dispatch did not create a row");
		}
		claimed.status = "RUNNING";
		mockWorkflowStart.mockClear();

		const second = (await dispatch({ idempotencyKey: KEY_A })) as {
			dispatched: boolean;
			deduplicated: boolean;
			run: { id: string };
		};

		expect(second.dispatched).toBe(true);
		expect(second.deduplicated).toBe(true);
		expect(second.run.id).toBe(first.run.id);
		expect(mockWorkflowStart).not.toHaveBeenCalled();
	});

	it("writes only ONE success audit row across both attempts", async () => {
		await dispatch({ idempotencyKey: KEY_A });
		await dispatch({ idempotencyKey: KEY_A });

		const successCalls = mockAudit.mock.calls.filter(
			(c) => (c[1] as { outcome: string }).outcome === "success",
		);
		expect(successCalls).toHaveLength(1);
	});

	it("does not start a second workflow for, or audit, a dedup that lands on a REFUSED run", async () => {
		// 200 steps at $0.05/step = $10, over the $5 default cap.
		await dispatch({ idempotencyKey: KEY_A, stepsPerCase: 200 });
		mockWorkflowStart.mockClear();
		mockAudit.mockClear();

		const second = (await dispatch({
			idempotencyKey: KEY_A,
			stepsPerCase: 200,
		})) as { dispatched: boolean; deduplicated: boolean; reason: string };

		expect(second.dispatched).toBe(false);
		expect(second.deduplicated).toBe(true);
		expect(second.reason).toBeTruthy();
		expect(mockWorkflowStart).not.toHaveBeenCalled();
		expect(mockAudit).not.toHaveBeenCalled();
	});
});

describe("dispatchAgenticRun — the key is scoped to the caller", () => {
	it("gives two different users the SAME key two different runs", async () => {
		const asUserOne = (await dispatch({
			idempotencyKey: KEY_A,
			userId: "user-1",
		})) as { run: { id: string } };
		const asUserTwo = (await dispatch({
			idempotencyKey: KEY_A,
			userId: "user-2",
		})) as { run: { id: string }; deduplicated: boolean };

		expect(asUserTwo.deduplicated).toBe(false);
		expect(asUserTwo.run.id).not.toBe(asUserOne.run.id);
	});
});

describe("dispatchAgenticRun — no key means today's behavior", () => {
	it("passes no explicit id to createAgenticRun when the key is omitted", async () => {
		await dispatch({});

		const call = mockCreateRun.mock.calls[0]?.[0] as { id?: string };
		expect(call.id).toBeUndefined();
	});

	it("never dedupes two keyless dispatches — each is its own run", async () => {
		const first = (await dispatch({})) as { run: { id: string } };
		const second = (await dispatch({})) as {
			run: { id: string };
			deduplicated: boolean;
		};

		expect(second.deduplicated).toBe(false);
		expect(second.run.id).not.toBe(first.run.id);
	});
});
