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
 * by the half-the-slots rule.
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
		expect(new Set(createdQueues()).size).toBe(createdQueues().length);
	});
});

describe("activity slots and the database pool", () => {
	const total = () =>
		Object.values(worker.ACTIVITY_SLOTS).reduce((sum, n) => sum + n, 0);

	it("gives Glossy edition builds four slots, the width of one build", () => {
		expect(worker.ACTIVITY_SLOTS.glossyEdition).toBe(4);
	});

	it("sizes the pool at half the slot total, rounded up", () => {
		expect(total()).toBe(86);
		expect(process.env.DATABASE_POOL_MAX).toBe(
			String(Math.ceil(total() / 2)),
		);
		expect(process.env.DATABASE_POOL_MAX).toBe("43");
	});
});
