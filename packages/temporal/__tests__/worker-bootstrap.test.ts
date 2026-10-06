/**
 * The worker process's bootstrap: which queues get a worker, which workers
 * the process runs and drains, and the database pool it sizes from the
 * activity slots.
 *
 * worker.ts runs `run()` on import, so this loads it once with every
 * external edge mocked — the Temporal connection, the bundler, `Worker`,
 * telemetry, the metrics server, and the activities barrel — and reads what
 * the bootstrap did. `process.on` and `process.exit` are stubbed so its
 * signal handlers and failure exits never reach the test process. Node's CJS
 * resolver cannot see `.ts` files, so its answer for worker.ts's one
 * `require.resolve("./workflows")` is supplied here; the bundler it feeds is
 * mocked anyway.
 *
 * Pins the Glossy edition registration (Fizzy #2589, KTD3): a worker polls
 * `glossy-edition` with four activity slots, the active-worker list that
 * startup, the run loop, and shutdown share includes it, and the pool grows
 * by the half-the-slots rule. The company context queue (Fizzy #2719) is
 * pinned the same way: its worker carries the shared workflows and
 * activities, since company ingestion runs the project pipeline's own code.
 *
 * Run with: pnpm --filter @repo/temporal test -- worker-bootstrap
 */

import Module from "node:module";
import { join, sep } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	create: vi.fn(async (options: Record<string, unknown>) => ({
		options,
		run: vi.fn(),
		shutdown: vi.fn(),
	})),
	// Never settles, so `run()` stays parked where a live worker would.
	startWorkerRuntime: vi.fn(() => new Promise<never>(() => {})),
}));

vi.mock("@temporalio/worker", () => ({
	Worker: { create: mocks.create },
	NativeConnection: { connect: vi.fn(async () => ({})) },
	bundleWorkflowCode: vi.fn(async () => ({ code: "" })),
}));
vi.mock("../src/activities", () => ({ exampleActivity: vi.fn() }));
vi.mock("../src/worker-startup", () => ({
	startWorkerRuntime: mocks.startWorkerRuntime,
}));
vi.mock("../src/schedules", () => ({
	PUBLISHING_RECONCILE_TASK_QUEUE: "publishing-reconcile",
}));
vi.mock("../src/telemetry", () => ({
	getTelemetryInterceptors: () => ({}),
	initTelemetry: vi.fn(),
	installTemporalRuntime: vi.fn(),
	isTelemetryEnabled: () => false,
	shutdownTelemetry: vi.fn(),
}));
vi.mock("../src/client", () => ({
	assertInsecureConnectionAllowed: vi.fn(),
	getTemporalConfig: () => ({
		address: "localhost:7233",
		namespace: "default",
	}),
}));
vi.mock("../src/lib/workflow-bundle-options", () => ({
	buildWorkflowBundleOptions: vi.fn(() => ({})),
}));
vi.mock("../src/lib/audit-log-env", () => ({
	validateAuditRetentionDays: vi.fn(),
}));
vi.mock("../src/lib/pm-sync-log-env", () => ({
	validatePmSyncLogRetentionDays: vi.fn(),
}));
vi.mock("../src/lib/correlation-interceptor", () => ({
	CorrelationActivityInboundInterceptor: class {},
}));
vi.mock("../src/lib/project-context-interceptor", () => ({
	ProjectContextActivityInboundInterceptor: class {},
}));
vi.mock("@repo/observability", () => ({
	createMetricsHttpServer: vi.fn(() => ({
		close: (done: () => void) => done(),
	})),
	initAppInsights: vi.fn(),
	shutdownAppInsights: vi.fn(),
}));
vi.mock("@repo/utils", () => ({
	describeEncryptionKeyMisconfiguration: () => null,
}));

type WorkerModule = typeof import("../src/worker");
type ResolveFilename = (
	request: string,
	parent: { filename?: string | null } | undefined,
	...rest: unknown[]
) => string;

const cjsLoader = Module as unknown as { _resolveFilename: ResolveFilename };
const realResolveFilename = cjsLoader._resolveFilename;

let worker: WorkerModule;
const savedPoolMax = process.env.DATABASE_POOL_MAX;

beforeAll(async () => {
	cjsLoader._resolveFilename = function (request, parent, ...rest) {
		if (
			request === "./workflows" &&
			parent?.filename?.endsWith(`${sep}src${sep}worker.ts`)
		) {
			return join(__dirname, "..", "src", "workflows", "index.ts");
		}
		return realResolveFilename.call(this, request, parent, ...rest);
	};
	delete process.env.DATABASE_POOL_MAX;
	vi.spyOn(process, "on").mockImplementation(() => process);
	vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	worker = await import("../src/worker");
	await vi.waitFor(() =>
		expect(mocks.startWorkerRuntime).toHaveBeenCalledTimes(1),
	);
});

afterAll(() => {
	cjsLoader._resolveFilename = realResolveFilename;
	vi.restoreAllMocks();
	if (savedPoolMax === undefined) {
		delete process.env.DATABASE_POOL_MAX;
	} else {
		process.env.DATABASE_POOL_MAX = savedPoolMax;
	}
});

function createdQueues(): string[] {
	return mocks.create.mock.calls.map(([options]) =>
		String(options.taskQueue),
	);
}

describe("worker bootstrap", () => {
	it("never exits during startup", () => {
		expect(process.exit).not.toHaveBeenCalled();
	});

	it("creates a worker polling glossy-edition with the Glossy activity slots", () => {
		const glossy = mocks.create.mock.calls.find(
			([options]) => options.taskQueue === "glossy-edition",
		);
		expect(glossy).toBeDefined();
		expect(glossy?.[0]).toMatchObject({
			namespace: "default",
			maxConcurrentActivityTaskExecutions: 4,
			reuseV8Context: true,
		});
		// Registered with the same activities and bundle as every other queue.
		expect(glossy?.[0].activities).toBe(
			mocks.create.mock.calls[0][0].activities,
		);
		expect(glossy?.[0].workflowBundle).toBe(
			mocks.create.mock.calls[0][0].workflowBundle,
		);
	});

	it("creates a worker polling company-context with the shared ingestion workflows and activities", () => {
		const company = mocks.create.mock.calls.find(
			([options]) => options.taskQueue === "company-context",
		);
		expect(company).toBeDefined();
		expect(company?.[0]).toMatchObject({
			namespace: "default",
			maxConcurrentActivityTaskExecutions: 3,
			reuseV8Context: true,
		});
		expect(company?.[0].activities).toBe(
			mocks.create.mock.calls[0][0].activities,
		);
		expect(company?.[0].workflowBundle).toBe(
			mocks.create.mock.calls[0][0].workflowBundle,
		);
	});

	it("keeps legacy commands draining while reserving separate generation and embedding slots", () => {
		for (const [taskQueue, slots] of [
			["project-documents", 5],
			["project-document-generation", 5],
			["project-embeddings", 3],
			["project-operations", 5],
		] as const) {
			const options = mocks.create.mock.calls.find(
				([options]) => options.taskQueue === taskQueue,
			)?.[0];
			expect(options).toMatchObject({
				maxConcurrentActivityTaskExecutions: slots,
			});
			expect(options?.activities).toBe(
				mocks.create.mock.calls[0][0].activities,
			);
		}
	});

	it("runs every created worker, the Glossy one included", async () => {
		const created = await Promise.all(
			mocks.create.mock.results.map((result) => result.value),
		);
		const [active] = mocks.startWorkerRuntime.mock.calls[0] as unknown as [
			Array<{ options: { taskQueue: string } }>,
		];
		expect(active).toHaveLength(created.length);
		expect(new Set(active)).toEqual(new Set(created));
		expect(active.map((entry) => entry.options.taskQueue)).toContain(
			"glossy-edition",
		);
		expect(active.map((entry) => entry.options.taskQueue)).toContain(
			"company-context",
		);
		expect(new Set(createdQueues()).size).toBe(createdQueues().length);
	});
});

describe("activity slots and the database pool", () => {
	const total = () =>
		Object.values(worker.ACTIVITY_SLOTS).reduce((sum, n) => sum + n, 0);

	it("gives Glossy edition builds four slots, the width of one build", () => {
		expect(worker.ACTIVITY_SLOTS.glossyEdition).toBe(4);
	});

	it("gives company context ingestion three slots", () => {
		expect(worker.ACTIVITY_SLOTS.companyContext).toBe(3);
	});

	it("sizes the pool at half the slot total, rounded up", () => {
		expect(total()).toBe(102);
		expect(process.env.DATABASE_POOL_MAX).toBe(
			String(Math.ceil(total() / 2)),
		);
		expect(process.env.DATABASE_POOL_MAX).toBe("51");
	});

	it("gives every slot entry to exactly one created worker", () => {
		const created = mocks.create.mock.calls.map(
			([options]) =>
				options.maxConcurrentActivityTaskExecutions as number,
		);
		expect(created.reduce((sum, n) => sum + n, 0)).toBe(total());
	});
});

describe("task queue selection (Fizzy #2730)", () => {
	const HEAVY = "atlas,code-indexing";
	const total = () =>
		Object.values(worker.ACTIVITY_SLOTS).reduce((sum, n) => sum + n, 0);

	it("polls every queue when no selection is set", () => {
		expect(createdQueues()).toHaveLength(19);
		expect(
			worker.selectTaskQueueWorkers({}).map((queue) => queue.taskQueue),
		).toEqual(createdQueues());
	});

	it("splits the queues into a heavy copy and a general copy with nothing lost", () => {
		const heavy = worker
			.selectTaskQueueWorkers({ WORKER_TASK_QUEUES: HEAVY })
			.map((queue) => queue.taskQueue);
		const general = worker
			.selectTaskQueueWorkers({ WORKER_EXCLUDED_TASK_QUEUES: HEAVY })
			.map((queue) => queue.taskQueue);
		expect(heavy).toEqual(["code-indexing", "atlas"]);
		expect(general).not.toContain("atlas");
		expect(general).not.toContain("code-indexing");
		expect([...heavy, ...general].sort()).toEqual(
			[...createdQueues()].sort(),
		);
	});

	it("sizes each copy's pool from its own queues' slots", () => {
		const heavy = worker.selectTaskQueueWorkers({
			WORKER_TASK_QUEUES: HEAVY,
		});
		const general = worker.selectTaskQueueWorkers({
			WORKER_EXCLUDED_TASK_QUEUES: HEAVY,
		});
		expect(worker.activitySlotTotal(heavy)).toBe(
			worker.ACTIVITY_SLOTS.atlas + worker.ACTIVITY_SLOTS.codeIndexing,
		);
		expect(
			worker.activitySlotTotal(heavy) + worker.activitySlotTotal(general),
		).toBe(total());
	});

	it("refuses a queue name the worker does not declare", () => {
		expect(() =>
			worker.selectTaskQueueWorkers({ WORKER_TASK_QUEUES: "atlass" }),
		).toThrow(/unknown task queue/);
	});
});

// Last on purpose: it reloads worker.ts, and the cases above read the calls
// the first load made. Loading with the selection set is what shows the
// process actually creates, runs and sizes its pool from the selected queues,
// rather than only that the selector returns them.
describe("booting the CPU-bound copy (WORKER_TASK_QUEUES=atlas,code-indexing)", () => {
	const savedSelection = process.env.WORKER_TASK_QUEUES;

	beforeAll(async () => {
		mocks.create.mockClear();
		mocks.startWorkerRuntime.mockClear();
		process.env.WORKER_TASK_QUEUES = "atlas,code-indexing";
		delete process.env.DATABASE_POOL_MAX;
		vi.resetModules();
		await import("../src/worker");
		await vi.waitFor(() =>
			expect(mocks.startWorkerRuntime).toHaveBeenCalledTimes(1),
		);
	});

	afterAll(() => {
		if (savedSelection === undefined) {
			delete process.env.WORKER_TASK_QUEUES;
		} else {
			process.env.WORKER_TASK_QUEUES = savedSelection;
		}
	});

	it("creates and runs workers for those two queues only", async () => {
		expect(createdQueues()).toEqual(["code-indexing", "atlas"]);
		const created = await Promise.all(
			mocks.create.mock.results.map((result) => result.value),
		);
		const [active] = mocks.startWorkerRuntime.mock.calls[0] as unknown as [
			unknown[],
		];
		expect(new Set(active)).toEqual(new Set(created));
	});

	it("sizes the pool from those queues' five slots", () => {
		expect(process.env.DATABASE_POOL_MAX).toBe("3");
	});

	it("never exits during startup", () => {
		expect(process.exit).not.toHaveBeenCalled();
	});
});
