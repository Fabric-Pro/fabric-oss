/**
 * Temporal Worker
 *
 * The worker polls the Temporal Server for workflow tasks and activity tasks,
 * executes them, and reports the results back to the server.
 *
 * Workers should be run as separate processes from the main application.
 * Multiple workers can run concurrently for horizontal scaling.
 *
 * Usage:
 *   pnpm --filter @repo/temporal worker
 *   pnpm --filter @repo/temporal worker:dev (with auto-reload)
 */

import type { Server } from "node:http";
import * as tls from "node:tls";
import {
	createMetricsHttpServer,
	initAppInsights,
	shutdownAppInsights,
} from "@repo/observability";
import { describeEncryptionKeyMisconfiguration } from "@repo/utils";
import {
	bundleWorkflowCode,
	NativeConnection,
	Worker,
	type WorkerOptions,
} from "@temporalio/worker";
import * as activities from "./activities";
import { assertInsecureConnectionAllowed, getTemporalConfig } from "./client";
import { validateAuditRetentionDays } from "./lib/audit-log-env";
import { CorrelationActivityInboundInterceptor } from "./lib/correlation-interceptor";
import { validatePmSyncLogRetentionDays } from "./lib/pm-sync-log-env";
import { ProjectContextActivityInboundInterceptor } from "./lib/project-context-interceptor";
import { selectTaskQueues } from "./lib/worker-task-queue-selection";
import { buildWorkflowBundleOptions } from "./lib/workflow-bundle-options";
import { PUBLISHING_RECONCILE_TASK_QUEUE } from "./schedules";
import {
	COMPANY_CONTEXT_TASK_QUEUE,
	GLOSSY_EDITION_TASK_QUEUE,
	ORCHESTRATOR_TASK_QUEUE,
} from "./task-queues";
import {
	getTelemetryInterceptors,
	initTelemetry,
	installTemporalRuntime,
	isTelemetryEnabled,
	shutdownTelemetry,
} from "./telemetry";
import { startWorkerRuntime } from "./worker-startup";

/**
 * Combine our correlation interceptors with whatever the OTEL telemetry
 * layer produces. Single registration, every worker gets:
 *   - activity inbound: correlation re-enters AsyncLocalStorage so the
 *     global logger + audit-write helpers auto-stamp correlationId
 *
 * The workflow half of the chain is deliberately NOT registered here.
 * The SDK ignores `interceptors.workflowModules` on any worker built
 * from a prebuilt `workflowBundle` — it only warns — so those modules
 * go to `bundleWorkflowCode` in getWorkflowBundle() instead. This
 * function strips the key rather than forwarding it so the discard
 * cannot silently come back.
 *
 * Covers every current AND every future workflow + activity with zero
 * per-callsite work.
 */
function getCombinedInterceptors(): Partial<
	Parameters<typeof Worker.create>[0]
> {
	const tele = getTelemetryInterceptors();
	const existingActivityInbound = tele.interceptors?.activityInbound ?? [];
	// Bundled in getWorkflowBundle() instead — see the note above.
	const { workflowModules: _bundledAtBuildTime, ...existingInterceptors } =
		tele.interceptors ?? {};
	return {
		...tele,
		interceptors: {
			...existingInterceptors,
			activityInbound: [
				...existingActivityInbound,
				() => new CorrelationActivityInboundInterceptor(),
				// Read-only mode: set ambient project context from
				// the activity input so the external-dispatch gate covers every
				// activity whose input object carries a top-level `projectId` —
				// defense-in-depth, NOT blanket coverage: an activity that nests
				// or renames the id gets no ambient context and must thread it
				// to the gate explicitly (post-ship review finding).
				() => new ProjectContextActivityInboundInterceptor(),
			],
		},
	};
}

/**
 * Prometheus scrape server for the Temporal worker. Bound to the loopback
 * port indicated by METRICS_PORT (or 9464 by default) so the Prometheus
 * scraper running on the same Container Apps environment can collect
 * worker-emitted metrics independently of the API server.
 */
/**
 * Activity concurrency per queue. Declared in one place because the sum is the
 * worker's real database-connection budget: every activity below shares the one
 * Prisma pool in this process. Exported for the worker bootstrap test.
 */
export const ACTIVITY_SLOTS = {
	aiChat: 10,
	documentProcessing: 5,
	projectDocument: 5,
	documentRefresh: 3,
	// Glossy edition builds (Fizzy #2589, KTD3). One build fans out at most
	// four concurrent model calls (`GLOSSY_BUILD_POOL_SIZE`), so four slots run
	// one build at full width and a second waits its turn instead of widening
	// the pool. More would enlarge the connection budget below without serving
	// the two-minute build target: the calls are provider-bound, not
	// slot-bound. Through the half-the-slots rule this adds two connections.
	glossyEdition: 4,
	// Company context ingestion (Fizzy #2719): an organization's uploaded
	// files, pasted text and crawled websites, on their own queue so no
	// worker without company support can take them. Background work nobody
	// waits on second by second — an administrator loads the material once —
	// so three slots drain a batch of uploads steadily. Through the
	// half-the-slots rule this adds two connections.
	companyContext: 3,
	// Coding-instructions snapshot validation. Deliberately tiny, and for a
	// different reason than most: these activities are the most I/O-bound
	// tenant of any queue here. One upload downloads and hashes every byte
	// of a snapshot (up to 50 MB) TWICE — once to gate it, once to promote
	// it — then lists and deletes up to 5000 staging keys, minutes of
	// wall clock holding one slot, with almost none of it CPU. Two is one
	// upload plus headroom for a second starting while the first drains;
	// more would buy throughput nobody is waiting on while enlarging the
	// connection budget below.
	projectInstructions: 2,
	workflowBuilder: 10,
	fabric: 5,
	fabricOrchestrator: 10,
	agents: 10,
	codeIndexing: 3,
	atlas: 2,
	triggerSystem: 10,
	// The reconciliation sweep. Deliberately tiny: the schedule is overlap:
	// "SKIP" and the workflow runs its activities sequentially, so the steady
	// state is one. The second slot is headroom for a manual trigger overlapping
	// a scheduled tick, not concurrency the sweep needs. 1C-2d-2b-1 added a
	// second activity to the same queue and 1C-2d-2b-2 a third, and this did not
	// move for either: the workflow AWAITS each before starting the next, so
	// three activities on one queue are still one occupied slot. The invariant
	// is the await chain, not the count — running any two concurrently would
	// double the reachable concurrency and invalidate the connection budget
	// below. Re-derived rather than assumed on both occasions, because the
	// arithmetic depends on a property of the workflow body rather than of this
	// file.
	publishingReconcile: 2,
	monitoringAlias: 5,
} as const;

/**
 * One worker per task queue, because each worker polls exactly one queue.
 * Everything that differs between queues lives here; what they share
 * (connection, namespace, workflow bundle, activities, interceptors) is added
 * where the workers are created in `run()`.
 *
 * Declared at module scope, not inside `run()`, because the database pool is
 * sized from the slots of the queues this process polls before anything can
 * open a connection.
 */
type TaskQueueWorkerOptions = Omit<
	WorkerOptions,
	"connection" | "namespace" | "workflowBundle" | "activities"
> & {
	taskQueue: string;
	maxConcurrentActivityTaskExecutions: number;
};

const TASK_QUEUE_WORKERS: readonly TaskQueueWorkerOptions[] = [
	{
		taskQueue: "ai-chat", // Task queue for chat title generation
		maxConcurrentActivityTaskExecutions: ACTIVITY_SLOTS.aiChat,
		maxConcurrentWorkflowTaskExecutions: 10,
	},
	{
		taskQueue: "document-processing", // Task queue for document processing (RAG)
		maxConcurrentActivityTaskExecutions: ACTIVITY_SLOTS.documentProcessing, // lower for resource-intensive tasks
		maxConcurrentWorkflowTaskExecutions: 5,
	},
	{
		taskQueue: "project-documents", // Task queue for project document generation
		maxConcurrentActivityTaskExecutions: ACTIVITY_SLOTS.projectDocument, // AI-intensive tasks
		maxConcurrentWorkflowTaskExecutions: 5,
	},
	// Living Documents auto-refresh gets its OWN queue and its own slots.
	//
	// It shared "project-documents" at first, and that was a real hazard rather
	// than a tidiness issue: the sweep is unattended and can go wide (every
	// enrolled document across every tenant becomes due at once the first time
	// the flag is switched on), while "project-documents" has 5 activity slots
	// and is what serves a human clicking "Update using context" and waiting.
	// A background feature nobody is watching must not be able to starve the
	// foreground feature someone is.
	{
		taskQueue: "document-refresh",
		// Deliberately small. These are long AI calls, the work is never urgent,
		// and a slow, steady drain is exactly the right shape for it.
		maxConcurrentActivityTaskExecutions: ACTIVITY_SLOTS.documentRefresh,
		maxConcurrentWorkflowTaskExecutions: 5,
	},
	// Glossy edition builds get their OWN queue and slots (KTD3), for the
	// same reason Living Documents did: a build holds up to four model calls
	// for minutes, and on "project-documents" it would take the slots a
	// member clicking "Update using context" is waiting on.
	{
		taskQueue: GLOSSY_EDITION_TASK_QUEUE,
		maxConcurrentActivityTaskExecutions: ACTIVITY_SLOTS.glossyEdition,
		maxConcurrentWorkflowTaskExecutions: 5,
	},
	// Company context ingestion gets its OWN queue (Fizzy #2719). The
	// workflows and activities are the shared ingestion ones, told apart by
	// the owner on their input; the queue is what guarantees that only a
	// worker which understands that owner ever runs a company job. A worker
	// from before company context polls the project queues alone, so it can
	// never mistake a company source for a project context, and during a
	// rollback company jobs wait here rather than fail.
	{
		taskQueue: COMPANY_CONTEXT_TASK_QUEUE,
		maxConcurrentActivityTaskExecutions: ACTIVITY_SLOTS.companyContext,
		maxConcurrentWorkflowTaskExecutions: 5,
	},
	// Coding-instructions snapshot validation gets its OWN queue, for the
	// same reason Living Documents did.
	//
	// It started on "project-documents", whose 5 slots serve a human
	// clicking "Update using context" and waiting. A snapshot validation
	// is watched too — someone is looking at the tab — but it is the
	// wrong SHAPE to share with a foreground queue: the gate hashes and
	// scans every byte of up to 50 MB, promotion re-hashes and re-writes
	// the same bytes, and cleanup lists and deletes up to 5000 keys, so
	// one upload holds one slot for minutes and three concurrent uploads
	// held 60% of the document queue. Separating them means neither
	// feature can starve the other, whichever is busy.
	{
		taskQueue: "project-instructions",
		maxConcurrentActivityTaskExecutions: ACTIVITY_SLOTS.projectInstructions,
		maxConcurrentWorkflowTaskExecutions: 5,
	},
	{
		taskQueue: "workflow-builder", // Task queue for workflow builder executions
		maxConcurrentActivityTaskExecutions: ACTIVITY_SLOTS.workflowBuilder,
		maxConcurrentWorkflowTaskExecutions: 10,
	},
	{
		taskQueue: "fabric-worker", // General purpose task queue for misc workflows
		maxConcurrentActivityTaskExecutions: ACTIVITY_SLOTS.fabric,
		maxConcurrentWorkflowTaskExecutions: 5,
		// Flush activity heartbeat details to the Temporal server promptly so
		// the direct-chat SSE poller surfaces partial assistant text in ~1s
		// steps instead of the SDK default (~80% of the 30s heartbeat timeout
		// ≈ 24s, which read as "no feedback then a sudden answer"). Only
		// activities that actively heartbeat are affected; the cadence is
		// bounded by maxConcurrentActivityTaskExecutions above.
		maxHeartbeatThrottleInterval: "1s",
	},
	{
		taskQueue: ORCHESTRATOR_TASK_QUEUE, // Task queue for the CUGA-inspired orchestrator
		maxConcurrentActivityTaskExecutions: ACTIVITY_SLOTS.fabricOrchestrator, // orchestrator handles many tool calls
		maxConcurrentWorkflowTaskExecutions: 5, // each can be long-running
	},
	{
		taskQueue: "agents", // Task queue for task agent workflows (Kanban agent assignment)
		maxConcurrentActivityTaskExecutions: ACTIVITY_SLOTS.agents, // agent makes many tool calls
		maxConcurrentWorkflowTaskExecutions: 5, // each can be long-running
	},
	// Code indexing and Atlas are the two CPU-bound queues: a tree-sitter pass
	// or a full Atlas analysis can hold this process's single event loop for
	// minutes. Their own queues and low slot counts keep them from taking other
	// queues' slots, but not from taking the CPU, so deployments run them in a
	// separate worker process (`WORKER_TASK_QUEUES`, see
	// ./lib/worker-task-queue-selection.ts; Fizzy #2730).
	{
		taskQueue: "code-indexing", // Task queue for AST-aware code indexing (Phase 2)
		maxConcurrentActivityTaskExecutions: ACTIVITY_SLOTS.codeIndexing, // Low concurrency: CPU-heavy tree-sitter + rate-limited embedding APIs
		maxConcurrentWorkflowTaskExecutions: 3,
	},
	// Atlas's own queue also keeps any foreign/stale worker polling a shared
	// queue from grabbing (and failing "not registered") these activities.
	// Concurrency is capped low because each structure activity does a
	// multi-GB-ish clone + parse.
	{
		taskQueue: "atlas", // must match ATLAS_TASK_QUEUE in @repo/atlas
		maxConcurrentActivityTaskExecutions: ACTIVITY_SLOTS.atlas,
		maxConcurrentWorkflowTaskExecutions: 2,
	},
	{
		taskQueue: "trigger-system", // Task queue for trigger system (webhooks, schedules, Slack mentions)
		maxConcurrentActivityTaskExecutions: ACTIVITY_SLOTS.triggerSystem,
		maxConcurrentWorkflowTaskExecutions: 10,
	},
	// The Publishing Suite reconciliation sweep gets its OWN queue, for the
	// same reason Living Documents auto-refresh does above — and here the
	// starvation runs the other way. This sweep drains obligations left
	// behind by the publishing dispatcher, whose schedule is overlap: "SKIP"
	// and whose workflow can hold an execution open for hours. Sharing a
	// queue with it means a reconciliation tick competes for slots with the
	// very workflow whose stalling created the rows it is draining. The
	// queue is what makes the sweep's progress independent of the
	// dispatcher's, which is the whole reason it is not simply another step
	// on the dispatcher tick.
	//
	// The queue name is IMPORTED, not copied. A schedule pointing at a
	// queue nothing polls produces workflows that queue up in Temporal
	// forever with nothing red anywhere, so the two must agree — and
	// sharing the symbol makes them the same string rather than two
	// strings a guard has to notice diverging. `./schedules` is already in
	// this process's module graph (worker.ts -> worker-startup.ts ->
	// schedules.ts), and schedules.ts's own static graph is seven modules
	// none of which is a worker, so this adds neither a load nor a cycle.
	{
		taskQueue: PUBLISHING_RECONCILE_TASK_QUEUE,
		maxConcurrentActivityTaskExecutions: ACTIVITY_SLOTS.publishingReconcile,
		maxConcurrentWorkflowTaskExecutions: 2,
	},
	// `monitoring` is a back-compat alias for the canonical
	// `fabric-worker` queue. Earlier deployments set
	// `TEMPORAL_MONITORING_TASK_QUEUE=monitoring` in their env, and the
	// alertmanager webhook handler used to default to that string.
	// We register a dedicated worker for the same queue name so those
	// deployments don't break on upgrade — workflows enqueued on
	// `monitoring` still find a consumer. The handler default has been
	// switched to `fabric-worker`, so net-new deployments use only the
	// canonical queue; this is purely a deprecation bridge.
	{
		taskQueue: "monitoring",
		maxConcurrentActivityTaskExecutions: ACTIVITY_SLOTS.monitoringAlias,
		maxConcurrentWorkflowTaskExecutions: 5,
	},
];

/**
 * The queues this process polls, chosen by `WORKER_TASK_QUEUES` or
 * `WORKER_EXCLUDED_TASK_QUEUES` (all of them when neither is set). Exported
 * for the worker bootstrap test.
 */
export function selectTaskQueueWorkers(
	env: Readonly<Record<string, string | undefined>> = process.env,
): TaskQueueWorkerOptions[] {
	const selected = selectTaskQueues(
		TASK_QUEUE_WORKERS.map((queue) => queue.taskQueue),
		env,
	);
	return TASK_QUEUE_WORKERS.filter((queue) =>
		selected.includes(queue.taskQueue),
	);
}

/** Activity slots a set of queue workers can run at once. */
export function activitySlotTotal(
	queues: readonly Pick<
		TaskQueueWorkerOptions,
		"maxConcurrentActivityTaskExecutions"
	>[],
): number {
	return queues.reduce(
		(sum, queue) => sum + queue.maxConcurrentActivityTaskExecutions,
		0,
	);
}

/**
 * Resolved once at load, so an invalid selection stops the process before it
 * connects to anything instead of leaving a queue silently unpolled.
 */
const SELECTED_TASK_QUEUE_WORKERS = selectTaskQueueWorkers();

/**
 * Size the database pool against the work this process actually admits.
 *
 * `pg` defaults to 10 connections. That default was silently governing a
 * process that admits 89 concurrent activities — the sum of `ACTIVITY_SLOTS`
 * above, so re-add it whenever a key is added or changed rather than trusting
 * this figure — so the pool saturated under ordinary scheduled bursts and,
 * because `connectionTimeoutMillis` also bounds queued callers, surfaced as
 * timeout-shaped Prisma errors rather than as anything recognisably
 * pool-related. A process limited to some queues (`WORKER_TASK_QUEUES`) is
 * sized from those queues' slots alone.
 *
 * Half the slot count is the compromise: activities hold a connection for a
 * fraction of their lifetime (most of it is spent in LLM and HTTP calls), so
 * one-per-slot would reserve capacity that is never concurrently used, and the
 * ceiling has to leave room for every other replica sharing the same database.
 * Set DATABASE_POOL_MAX explicitly to override.
 */
function applyDatabasePoolBudget(): void {
	if (process.env.DATABASE_POOL_MAX) {
		return;
	}
	process.env.DATABASE_POOL_MAX = String(
		Math.ceil(activitySlotTotal(SELECTED_TASK_QUEUE_WORKERS) / 2),
	);
}

let metricsServer: Server | null = null;

/** Workers currently polling, so the signal handler can drain them. */
let activeWorkers: Worker[] = [];

/** Resolves when every worker has finished draining. */
let workersRunning: Promise<unknown> | null = null;

/** Guards against SIGINT and SIGTERM both arriving. */
let shuttingDown = false;

/**
 * How long to let in-flight work finish before exiting anyway. Container
 * runtimes send SIGKILL a fixed interval after SIGTERM, so this has to expire
 * first or the drain is cut off mid-write with no chance to report back.
 */
const SHUTDOWN_DRAIN_TIMEOUT_MS = 25_000;

/**
 * Bundle workflows once at boot; every task queue below is created from
 * the result. The options — including the workflow interceptor modules,
 * which only take effect when passed here — live in
 * ./lib/workflow-bundle-options so a test can assert against the same
 * object this passes to the bundler.
 */
async function getWorkflowBundle() {
	return await bundleWorkflowCode(
		buildWorkflowBundleOptions(require.resolve("./workflows")),
	);
}

/**
 * Main worker function
 */
async function run() {
	console.log("[Worker] Starting Temporal worker...");

	// Non-fatal config check for the PartyKit realtime publishers. PartyKit is
	// optional in some environments, so a missing value only degrades a
	// feature (no live progress broadcasts) rather than blocking worker boot —
	// but the degradation is otherwise silent, so warn loudly at startup
	// instead of letting operators discover it via an empty activity feed.
	if (!process.env.NEXT_PUBLIC_PARTYKIT_HOST) {
		console.warn(
			"[Worker] NEXT_PUBLIC_PARTYKIT_HOST is not set — PartyKit realtime broadcasts will target the localhost:1999 fallback and likely fail outside local dev.",
		);
	}
	// Local dev PartyKit (localhost) doesn't expect auth, so a missing secret
	// is only worth a warning when broadcasts target a real host.
	const partykitHost =
		process.env.NEXT_PUBLIC_PARTYKIT_HOST || "localhost:1999";
	if (
		!process.env.AGENT_SERVICE_SECRET &&
		!partykitHost.startsWith("localhost")
	) {
		console.warn(
			"[Worker] AGENT_SERVICE_SECRET is not set — PartyKit publishes will be sent unauthenticated.",
		);
	}

	// Surface env warnings early so they land on the same boot log line
	// operators see when they restart manually. Non-fatal — audit
	// retention is opt-in and operators may deliberately configure a
	// shorter window.
	validateAuditRetentionDays();
	validatePmSyncLogRetentionDays();

	// Key material is read lazily at the first encrypt or decrypt, so a worker
	// configured with an active key version it does not hold starts cleanly and
	// then fails EVERY credential read for as long as it runs — surfacing far
	// away, as a per-feature error at the end of a workflow, long after the
	// deploy that caused it.
	//
	// Fatal, because the damage is not confined to this worker. Workers compete
	// for tasks on a shared queue, so one that cannot read credentials does not
	// simply do less work — it wins a share of the work and fails it, while a
	// correctly-configured sibling succeeds at the rest. That reads as an
	// intermittent product bug, which is the hardest kind to trace back to a
	// deployment. Refusing to start removes it from the pool instead.
	//
	// Safe to be fatal only because the deploy no longer activates a key version
	// an environment has no material for (deployment/azure/main.bicep takes it as
	// a parameter, resolved from the vault), so an unseeded environment gets the
	// legacy key and boots. `advisory` covers the states that still work.
	const encryptionProblem = describeEncryptionKeyMisconfiguration();
	if (encryptionProblem?.severity === "fatal") {
		throw new Error(
			`[Worker] Encryption is misconfigured — every stored-credential read would fail, and this worker would fail a share of the queue's tasks while its siblings succeed. ${encryptionProblem.message}`,
		);
	}
	if (encryptionProblem) {
		console.warn(`[Worker] ${encryptionProblem.message}`);
	}

	// Install the Temporal runtime with core metrics export before any native
	// call (connect / Worker.create) creates the default, exporter-less one.
	installTemporalRuntime();

	// Initialize OpenTelemetry before starting the worker
	initTelemetry();

	// Azure Application Insights — metrics + alerting backend. Idempotent
	// + safe; no-ops when APPLICATIONINSIGHTS_CONNECTION_STRING is unset.
	initAppInsights();

	// Start the Prometheus scrape server. Bound to METRICS_PORT (or 9464).
	const metricsPort = Number.parseInt(process.env.METRICS_PORT ?? "9464", 10);
	try {
		metricsServer = createMetricsHttpServer({ port: metricsPort });
		console.log(
			`[Worker] Prometheus /metrics endpoint listening on :${metricsPort}`,
		);
	} catch (err) {
		// Failure to bind the scrape port must NOT prevent worker boot —
		// metrics are observability, not a correctness gate.
		console.warn(
			"[Worker] Failed to start metrics HTTP server",
			err instanceof Error ? err.message : err,
		);
	}

	const config = getTemporalConfig();

	try {
		// Create connection to Temporal Server
		console.log(`[Worker] Connecting to ${config.address}...`);

		const connectionOptions: Parameters<
			typeof NativeConnection.connect
		>[0] = {
			address: config.address,
		};

		// Configure authentication for Temporal Cloud
		if (config.apiKey) {
			// API Key authentication (recommended for Temporal Cloud)
			connectionOptions.apiKey = config.apiKey;
			// Get system root CA certificates for TLS verification
			// The native Rust core doesn't have access to system CAs, so we must provide them
			const rootCerts = tls.rootCertificates.join("\n");
			connectionOptions.tls = {
				serverRootCACertificate: Buffer.from(rootCerts),
			};
			console.log(
				"[Worker] Using API Key authentication for Temporal Cloud",
			);
		} else if (
			config.tls &&
			process.env.TEMPORAL_CLIENT_CERT &&
			process.env.TEMPORAL_CLIENT_KEY
		) {
			// mTLS authentication (alternative method using client certificates)
			connectionOptions.tls = {
				clientCertPair: {
					crt: Buffer.from(process.env.TEMPORAL_CLIENT_CERT),
					key: Buffer.from(process.env.TEMPORAL_CLIENT_KEY),
				},
			};
			console.log("[Worker] Using mTLS certificate authentication");
		} else if (config.tls) {
			// TLS enabled but no authentication (useful for self-hosted with TLS)
			connectionOptions.tls = true;
			console.log("[Worker] Using TLS without authentication");
		} else {
			assertInsecureConnectionAllowed("[Worker]");
			console.log(
				"[Worker] Using insecure connection (local development)",
			);
		}

		const connection = await NativeConnection.connect(connectionOptions);
		console.log("[Worker] Connected to Temporal Server");

		// Bundle workflows once (with publicPath fix for Temporal's VM sandbox)
		console.log("[Worker] Bundling workflows...");
		const workflowBundle = await getWorkflowBundle();
		console.log("[Worker] Workflow bundle created");

		// Combined interceptor options: OTEL telemetry (if enabled) +
		// correlation-ID propagation (always on). Every worker below
		// spreads this so the correlation interceptors land once at the
		// boundary and cover all current + future activities/workflows
		// with no per-callsite work.
		const telemetryOptions = getCombinedInterceptors();
		if (isTelemetryEnabled()) {
			console.log("[Worker] OpenTelemetry tracing enabled");
		}
		console.log(
			"[Worker] Correlation-ID propagation enabled (activity inbound + workflow outbound)",
		);

		// One worker per selected queue, created in the order declared above.
		// Assigned to activeWorkers as each is created, so a signal arriving
		// mid-startup still drains whatever is already polling.
		activeWorkers = [];
		for (const queue of SELECTED_TASK_QUEUE_WORKERS) {
			activeWorkers.push(
				await Worker.create({
					connection,
					namespace: config.namespace,
					workflowBundle, // Use pre-bundled workflows with publicPath fix
					activities, // Activity implementations
					// Reuse V8 context across workflow executions — major RAM/CPU
					// reduction with no behavior change (sandbox isolation is preserved).
					reuseV8Context: true,
					...queue,
					...telemetryOptions,
				}),
			);
		}

		console.log("[Worker] Workers created successfully");
		console.log(`[Worker] Namespace: ${config.namespace}`);
		console.log(
			`[Worker] Task Queues: ${SELECTED_TASK_QUEUE_WORKERS.map((queue) => queue.taskQueue).join(", ")}`,
		);

		workersRunning = startWorkerRuntime(activeWorkers);
		await workersRunning;
	} catch (error) {
		console.error("[Worker] Failed to start worker:", error);
		process.exit(1);
	}
}

/**
 * Graceful shutdown handler
 */
function setupShutdownHandlers() {
	const shutdown = async (signal: string) => {
		if (shuttingDown) {
			return;
		}
		shuttingDown = true;
		console.log(`[Worker] Received ${signal}, shutting down gracefully...`);

		// Ask every worker to stop accepting tasks and finish what it holds.
		// This used to be left entirely to the SDK's own signal handling while
		// this function raced ahead to process.exit(0) — and won, because
		// closing a metrics server and flushing telemetry takes far less time
		// than draining activities. In-flight work was killed mid-task on every
		// deploy and every autoscale-down, which Temporal then reports as
		// "Task not found when completing" / "Activity not found".
		//
		// shutdown() is synchronous and only signals intent; the promise
		// returned by run() is what actually resolves once draining completes.
		for (const worker of activeWorkers) {
			try {
				worker.shutdown();
			} catch (error) {
				console.error(
					"[Worker] Failed to signal shutdown to a worker:",
					error instanceof Error ? error.message : error,
				);
			}
		}

		if (workersRunning) {
			let drainTimer: NodeJS.Timeout | undefined;
			const drained = await Promise.race([
				workersRunning.then(() => true).catch(() => true),
				new Promise<false>((resolve) => {
					drainTimer = setTimeout(
						() => resolve(false),
						SHUTDOWN_DRAIN_TIMEOUT_MS,
					);
				}),
			]);
			if (drainTimer) {
				clearTimeout(drainTimer);
			}
			if (!drained) {
				console.warn(
					`[Worker] Drain did not finish within ${SHUTDOWN_DRAIN_TIMEOUT_MS}ms; exiting with work still in flight.`,
				);
			}
		}

		// Close metrics HTTP server so the loopback port releases.
		if (metricsServer) {
			await new Promise<void>((resolve) =>
				metricsServer!.close(() => resolve()),
			);
			metricsServer = null;
		}
		// Flush the optional isolated Application Insights client before its
		// providers are released, then flush the process-wide OTel pipeline.
		await shutdownAppInsights();
		await shutdownTelemetry();
		process.exit(0);
	};

	process.on("SIGINT", () => shutdown("SIGINT"));
	process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// Size the DB pool before any activity can open a connection.
applyDatabasePoolBudget();

// Set up shutdown handlers
setupShutdownHandlers();

// Add unhandled rejection and exception handlers for debugging
process.on("unhandledRejection", (reason, promise) => {
	console.error("[Worker] Unhandled Promise Rejection:", reason);
	console.error("[Worker] Promise:", promise);
});

process.on("uncaughtException", (error) => {
	console.error("[Worker] Uncaught Exception:", error);
	process.exit(1);
});

// Start the worker
run().catch((error) => {
	console.error("[Worker] Fatal error:", error);
	process.exit(1);
});
