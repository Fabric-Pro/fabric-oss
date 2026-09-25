import { ORPCError } from "@orpc/client";
import { config } from "@repo/config";
import {
	type CreateAgenticRunInput,
	cancelAgenticRun,
	createAgenticRun,
	db,
	getAgenticRun,
	getProjectPipelineRunDetail,
	getProjectQaSettings,
	listAgenticRuns,
	listAgenticRunsPage,
	listAgenticStepLogs,
	Prisma,
} from "@repo/database";
import { logger } from "@repo/logs";
import { getSignedUrl, isTenantOwnedKey } from "@repo/storage";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { describeCostRefusal } from "../../lib/agentic-run-cost";
import { deriveIdempotentRunId } from "../../lib/agentic-run-idempotency";
import { describeProductionRunWarning } from "../../lib/agentic-run-production";
import { assertPipelineResultsEnabled } from "../../lib/pipeline-results-feature";
import {
	isScriptedRunPermitted,
	resolveAgenticRunMode,
	resolveSelectedTestCaseIds,
} from "../../lib/agentic-run-selection";
import { testCaseSelectionSchema } from "../../lib/test-case-selection";

/**
 * Create an agentic run, or — when the caller supplied a deterministic id
 * (from {@link deriveIdempotentRunId}) that already belongs to a row THIS
 * project created — return that row instead of a duplicate.
 *
 * The P2002 branch only ever fires for a deterministic id: `input.id` is
 * otherwise absent, leaving Prisma's own `cuid()` default to assign one, and
 * a collision on THAT would be a genuine bug rather than a retried dispatch.
 * Guarding on `input.id` first is what keeps an unrelated primary-key
 * collision from being silently swallowed as "someone's retry".
 */
async function createOrReuseAgenticRun(input: CreateAgenticRunInput): Promise<{
	run: Awaited<ReturnType<typeof createAgenticRun>>;
	deduplicated: boolean;
}> {
	try {
		return { run: await createAgenticRun(input), deduplicated: false };
	} catch (err) {
		if (
			!input.id ||
			!(err instanceof Prisma.PrismaClientKnownRequestError) ||
			err.code !== "P2002"
		) {
			throw err;
		}
		const existing = await getAgenticRun({
			projectId: input.projectId,
			runId: input.id,
		});
		if (!existing) {
			// The id collided but no row FOR THIS PROJECT answers to it — an
			// astronomically unlikely sha256 collision with a different
			// dispatch's key, or a read racing an in-flight write. Either way,
			// there is nothing here this request actually caused, so it must
			// not be reported as one.
			throw new ORPCError("CONFLICT", {
				message: "Could not start or find this run. Try again.",
			});
		}
		return { run: existing, deduplicated: true };
	}
}

/**
 * Fabric-orchestrated test runs — dispatching one, and reading what it did.
 *
 * A run drives a real browser against a real environment using a stored
 * credential, so guards sit in front of it:
 *
 * 1. **Cost REFUSES.** The estimate is computed from the ACTUAL step count of
 *    the selected cases and refuses above the per-run cap. A refused run is
 *    still recorded, with the numbers that refused it, so the cap can be argued
 *    with instead of merely resented.
 * 2. **Production WARNS.** Pointing a browser at a PRODUCTION environment
 *    returns a warning the caller must display, and the run proceeds. This is a
 *    product ruling taken 2026-07-27, replacing an explicit-confirmation gate:
 *    storing a production credential is already the customer's call, and the
 *    same person is making this one. Recorded honestly here because the trade is
 *    real — nothing now stops an unattended production run, and the row's raised
 *    severity plus `productionAcknowledged` metadata is what an investigation
 *    has to work with instead.
 * 3. **Audit.** Every dispatch and every refusal is recorded.
 *
 * A failing case NEVER files a bug here. It produces a FAILED result, which the
 * ordinary ingestion path turns into a finding; promotion stays a person's
 * action.
 */

/** How long a signed evidence link lives. Long enough to look at, not to share. */
const EVIDENCE_URL_TTL_SECONDS = 300;

/**
 * What a downloaded piece of evidence should be called on disk.
 *
 * Without a name the browser saves the object key, which is a UUID — so a
 * folder of evidence from one run is indistinguishable a minute later. Named
 * after the case and the step instead, which is how somebody attaching it to a
 * bug report needs to refer to it.
 *
 * Everything is stripped back to a safe alphabet before it reaches the
 * `Content-Disposition` header. The pieces come from our own rows, but a
 * filename is a header value and a quote or a newline in one is a response-
 * splitting bug rather than a cosmetic problem.
 */
export function evidenceFileName(input: {
	identifier: string | null;
	testCaseId: string;
	stepNumber: number;
	key: string;
}): string {
	const safe = (value: string) => value.replace(/[^A-Za-z0-9._-]/g, "-");
	const stem = safe(input.identifier?.trim() || input.testCaseId);
	const extension = /\.([A-Za-z0-9]{1,5})$/.exec(input.key)?.[1] ?? "png";
	return `${stem}-step-${input.stepNumber}.${safe(extension)}`;
}

async function requireProjectTenant(
	projectId: string,
): Promise<{ organizationId: string | null; userId: string | null }> {
	const project = await db.project.findUnique({
		where: { id: projectId },
		select: { organizationId: true, userId: true },
	});
	if (!project) {
		throw new ORPCError("NOT_FOUND", { message: "Project not found" });
	}
	return project;
}

/**
 * Start the Temporal workflow behind one run. Factored out of `dispatch`
 * because it is called from two places: the ordinary path, and a
 * deduplicated retry that reuses the SAME workflow id (`USE_EXISTING`) —
 * which is what lets a first request that created the row but crashed
 * before this call ever ran get completed by the retry, while a genuinely
 * concurrent first request just gets its own workflow handle back.
 */
async function startAgenticRunWorkflow(input: {
	projectId: string;
	organizationId: string | null;
	userId: string;
	runId: string;
	environmentId: string;
	targetBaseUrl: string;
	testCaseIds: string[];
	runMode: "MODE_A" | "MODE_B";
	scriptRevisionIds?: Record<string, string>;
	environmentSnapshot: {
		signInUrl: string | null;
		authKind: string;
		authUsername: string | null;
		authHeaderName: string | null;
	};
	browser: string;
	resolution: string;
	costPerModelCallUsd: number;
}): Promise<void> {
	const { getTemporalClient } = await import("@repo/temporal");
	const client = await getTemporalClient();
	await client.workflow.start("qaAgenticRunWorkflow", {
		taskQueue: "ai-chat",
		// The run id IS the workflow id: one workflow per run, and a
		// retried dispatch cannot start a second browser for the same run.
		workflowId: `qa-agentic-run-${input.runId}`,
		workflowIdReusePolicy: "ALLOW_DUPLICATE" as const,
		workflowIdConflictPolicy: "USE_EXISTING" as const,
		args: [
			{
				projectId: input.projectId,
				organizationId: input.organizationId,
				userId: input.userId,
				runId: input.runId,
				environmentId: input.environmentId,
				targetBaseUrl: input.targetBaseUrl,
				testCaseIds: input.testCaseIds,
				runMode: input.runMode,
				scriptRevisionIds: input.scriptRevisionIds,
				environmentSnapshot: input.environmentSnapshot,
				browser: input.browser,
				resolution: input.resolution,
				costPerModelCallUsd: input.costPerModelCallUsd,
			},
		],
	});
}

/**
 * What dispatch WOULD decide for a selection, without creating anything — the
 * figure the run-configuration dialog shows before Start (product ruling:
 * "an estimate shown before dispatch").
 *
 * Read-level (TEST_CASE_READ), like the sibling list/get procedures: this
 * changes nothing, and asking what a run would cost needs no more than
 * reading the project's cases. Resolves through the exact same helpers
 * dispatch uses ({@link resolveSelectedTestCaseIds},
 * {@link resolveAgenticRunMode}) so quote and dispatch can never disagree
 * about what a selection would run or what it would cost.
 */
export const quoteAgenticRunProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_READ))
	.route({
		method: "POST",
		path: "/projects/{projectId}/qa/agentic-runs/quote",
		tags: ["Projects", "Test Cases"],
		summary: "Estimate what dispatching a selection would run and cost",
		description:
			"Read-only: resolves a selection for both runners without creating a run, so the run-configuration dialog can show a figure before Start.",
	})
	.input(
		z.object({
			projectId: z.string(),
			selection: testCaseSelectionSchema,
		}),
	)
	.handler(async ({ input, context }) => {
		assertPipelineResultsEnabled();
		const testCaseIds = await resolveSelectedTestCaseIds({
			projectId: input.projectId,
			selection: input.selection,
		});
		const [agentic, scripted, scriptedPermitted] = await Promise.all([
			resolveAgenticRunMode({
				projectId: input.projectId,
				testCaseIds,
				runMode: "MODE_A",
			}),
			resolveAgenticRunMode({
				projectId: input.projectId,
				testCaseIds,
				runMode: "MODE_B",
			}),
			// The same gate `dispatch` enforces for MODE_B, answered here so the
			// dialog never defaults, restores, or offers a runner this caller
			// cannot actually start (Fizzy #2233 follow-up: an EDITOR with only
			// `TEST_CASE_UPDATE` could be defaulted into Scripted and then see
			// Start come back FORBIDDEN).
			isScriptedRunPermitted({
				projectId: input.projectId,
				userId: context.user.id,
			}),
		]);
		return {
			resolvedCaseCount: testCaseIds.length,
			agentic: {
				runnableCaseCount: agentic.cases.length,
				stepCount: agentic.stepCount,
				estimatedCostUsd: agentic.estimate.estimatedCostUsd,
				capUsd: agentic.estimate.capUsd,
				withinCap: agentic.estimate.withinCap,
			},
			// A scripted run makes no model calls, so there is nothing to cost —
			// only whether the selection is runnable AND permitted matters here.
			scripted: {
				runnableCaseCount: scripted.cases.length,
				permitted: scriptedPermitted,
			},
		};
	});

/**
 * Start a run.
 *
 * Gated by TEST_CASE_UPDATE, matching the CI-trigger procedure: the people this
 * feature exists for are QA engineers and developers, who are EDITORs. The line
 * drawn there holds here too — configuring which credentials Fabric holds stays
 * with admins (PROJECT_SETTINGS_EDIT on the credential write), using an
 * already-trusted one does not.
 */
export const dispatchAgenticRunProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/qa/agentic-runs",
		tags: ["Projects", "Test Cases"],
		summary: "Run Fabric-authored test cases against an environment",
		description:
			"Drives a browser through each case's authored steps. Refuses above the per-run cost cap, and warns (without stopping) for a PRODUCTION target. Failures become findings, never bugs.",
	})
	.input(
		z.object({
			projectId: z.string(),
			/**
			 * Which cases to run: an explicit id list, or the list's own filter.
			 *
			 * The filter mode is why this is a selection rather than an id array.
			 * "Select all N matching" carries the intent as a predicate and
			 * deliberately holds no ids, so a run that only accepted ids received
			 * an empty list and refused — the widest selection the list offers
			 * used to leave the Run button dead with nothing on screen to explain
			 * it. Resolved server-side against the same predicate the bulk
			 * actions use.
			 */
			selection: testCaseSelectionSchema,
			/** Omit to use the QA policy's default environment. */
			environmentId: z.string().optional(),
			/**
			 * Playwright context overrides from the chosen run configuration
			 * (mocks C2/C8). Omitted means "use the project's QA policy", which is
			 * what keeps a saved configuration meaningful after the policy changes
			 * instead of freezing a copy of it.
			 */
			browser: z.enum(["chromium", "firefox", "webkit"]).optional(),
			resolution: z
				.string()
				.regex(/^\d{3,5}x\d{3,5}$/, {
					message: "Use WIDTHxHEIGHT, e.g. 1920x1080",
				})
				.optional(),
			runMode: z.enum(["MODE_A", "MODE_B"]).default("MODE_A"),
			/**
			 * Required to run against a PRODUCTION environment. Not a formality:
			 * it is the difference between the customer choosing to store a
			 * credential and Fabric choosing to spend it on their live system.
			 */
			/**
			 * One dispatch ATTEMPT, from the client's perspective (Fizzy #2233
			 * follow-up). `RunConfigurationDialog` mints one when the dialog opens
			 * and again whenever anything that defines the run changes, and reuses
			 * it across a same-tick double click or a network retry — the reason
			 * this exists. Optional: an absent key falls back to today's behavior,
			 * a fresh row on every call, which is what every non-UI caller (the
			 * public API) still gets.
			 */
			idempotencyKey: z.string().uuid().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		assertPipelineResultsEnabled();
		const user = context.user;
		if (
			input.runMode === "MODE_B" &&
			!(await isScriptedRunPermitted({
				projectId: input.projectId,
				userId: user.id,
			}))
		) {
			throw new ORPCError("FORBIDDEN", {
				message:
					"Only project admins or owners can run credentialed scripted tests.",
			});
		}
		// Absent for every non-UI caller, which keeps today's behavior: a fresh
		// row every call. Scoped to THIS project and THIS user, so nobody else's
		// key — replayed, guessed, or coincidentally identical — can ever
		// address a run it did not create.
		const idempotentRunId = input.idempotencyKey
			? deriveIdempotentRunId({
					projectId: input.projectId,
					userId: user.id,
					idempotencyKey: input.idempotencyKey,
				})
			: undefined;
		const tenant = await requireProjectTenant(input.projectId);
		const settings = await getProjectQaSettings(input.projectId);
		const selectedBrowser =
			input.browser ?? settings.browsers[0] ?? "chromium";
		if (input.runMode === "MODE_B" && selectedBrowser !== "chromium") {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"Scripted runs currently require Chromium so Fabric can pin the validated public address.",
			});
		}

		const environmentId =
			input.environmentId ?? settings.defaultEnvironmentId ?? null;
		if (!environmentId) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"Choose an environment to run against, or set a default in Settings ▸ Testing.",
			});
		}

		const environment = await db.projectEnvironment.findFirst({
			where: { id: environmentId, projectId: input.projectId },
			select: {
				id: true,
				name: true,
				type: true,
				baseUrl: true,
				signInUrl: true,
				authKind: true,
				authUsername: true,
				authHeaderName: true,
			},
		});
		if (!environment) {
			throw new ORPCError("NOT_FOUND", {
				message: "Environment not found",
			});
		}

		// Resolve WHICH cases before anything is judged on their number: the
		// estimate, the cap and the audit trail all count cases, and a filter
		// selection does not know its own size until the database answers.
		// Shared with `quote` so the two paths cannot resolve a selection
		// differently.
		const testCaseIds = await resolveSelectedTestCaseIds({
			projectId: input.projectId,
			selection: input.selection,
		});

		const auditAttempt = (
			outcome: "success" | "failure",
			metadata: Record<string, unknown>,
		) =>
			recordAuditFromRequest(context, {
				action: "project.agentic_run.dispatched",
				category: "project",
				severity:
					environment.type === "PRODUCTION" ? "warning" : "info",
				outcome,
				projectId: input.projectId,
				// `recordAuditFromRequest` rather than `recordAudit`: its
				// `resolveActor` fills the actor's email and name from the request,
				// without which the row renders as `system` instead of the person
				// who dispatched the run, and it carries ip / user agent / request
				// id / session id. The owning organization no longer has to be
				// passed — the write path derives it from `projectId`, which is
				// what stops the next new call site landing an unreachable row.
				resource: { type: "project_environment", id: environment.id },
				metadata: {
					environmentName: environment.name,
					environmentType: environment.type,
					isProduction: environment.type === "PRODUCTION",
					caseCount: testCaseIds.length,
					runMode: input.runMode,
					...metadata,
				},
			});

		// --- Guard 2: production warns, it does not refuse -------------------
		// Returned rather than thrown, and returned on the SUCCESS path, so the
		// caller renders it beside a run that is genuinely happening. A warning
		// the product can quietly drop is not a warning, so it also rides in the
		// audit metadata, where nobody can choose not to show it.
		const productionWarning = describeProductionRunWarning(environment);

		// Steps are counted from the REAL cases, not assumed, so the estimate the
		// user is refused on is the one their run would actually have cost.
		// Shared with `quote` so the figure shown before Start is the figure
		// dispatch actually enforces.
		const { cases, stepCount, estimate } = await resolveAgenticRunMode({
			projectId: input.projectId,
			testCaseIds,
			runMode: input.runMode,
		});
		if (cases.length === 0) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					input.runMode === "MODE_B"
						? "None of the selected cases have a saved Playwright script. Generate or add a script first."
						: "None of the selected cases have steps, so there is nothing to run. Add steps to a case first.",
			});
		}
		if (
			input.runMode === "MODE_B" &&
			cases.length !== new Set(testCaseIds).size
		) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"Every selected case needs a saved Playwright script for a scripted run.",
			});
		}
		const scriptRevisionIds: Record<string, string> = {};
		if (input.runMode === "MODE_B") {
			for (const testCase of cases) {
				if (!testCase.scriptRevisionId) {
					throw new ORPCError("BAD_REQUEST", {
						message:
							"Every selected case needs a saved script revision for a scripted run.",
					});
				}
				scriptRevisionIds[testCase.id] = testCase.scriptRevisionId;
			}
		}
		// --- Guard 1: cost refuses, it does not warn -------------------------
		if (!estimate.withinCap) {
			const reason = describeCostRefusal(estimate);
			// Recorded as a REFUSED run, not merely thrown: "we asked, at this
			// price, and were told no" is the record that makes the cap
			// reviewable rather than folklore.
			const { run: refused, deduplicated } =
				await createOrReuseAgenticRun({
					id: idempotentRunId,
					projectId: input.projectId,
					organizationId: tenant.organizationId,
					userId: tenant.userId,
					environmentId: environment.id,
					targetBaseUrl: environment.baseUrl,
					environmentType: environment.type,
					estimatedCostUsd: estimate.estimatedCostUsd,
					costCapUsd: estimate.capUsd,
					browser: selectedBrowser,
					resolution:
						input.resolution ??
						settings.resolutions[0] ??
						"1920x1080",
					caseCount: cases.length,
					triggeredByUserId: user.id,
					runMode: input.runMode,
					refusal: { reason },
				});
			// A deduplicated dispatch writes no audit row of its own, success or
			// refusal: the click that produced this request performed no action —
			// it landed on the SAME row the original attempt of this key already
			// recorded, and that attempt's row is what the ledger describes.
			if (!deduplicated) {
				auditAttempt("failure", {
					refusal: "COST_CAP",
					estimatedCostUsd: estimate.estimatedCostUsd,
					capUsd: estimate.capUsd,
					runId: refused.id,
				});
			}
			return {
				dispatched: false as const,
				run: refused,
				reason: refused.refusalReason ?? reason,
				productionWarning,
				deduplicated,
			};
		}

		const { run, deduplicated } = await createOrReuseAgenticRun({
			id: idempotentRunId,
			projectId: input.projectId,
			organizationId: tenant.organizationId,
			userId: tenant.userId,
			environmentId: environment.id,
			// Snapshotted: an environment can be edited or deleted, and "which URL
			// did this run hit" must stay answerable.
			targetBaseUrl: environment.baseUrl,
			environmentType: environment.type,
			estimatedCostUsd: estimate.estimatedCostUsd,
			costCapUsd: estimate.capUsd,
			browser: selectedBrowser,
			resolution:
				input.resolution ?? settings.resolutions[0] ?? "1920x1080",
			caseCount: cases.length,
			triggeredByUserId: user.id,
			runMode: input.runMode,
		});

		if (run.status === "REFUSED") {
			// The SAME key dedup here lands on a run recorded REFUSED by an
			// earlier submission of it — e.g. the cost cap tightened between
			// the two submissions. Nothing was ever dispatched for that row and
			// nothing starts now; report it exactly as the cost guard above
			// would have.
			return {
				dispatched: false as const,
				run,
				reason: run.refusalReason ?? "This run was refused.",
				productionWarning,
				deduplicated,
			};
		}

		// A retry of this key only needs to START the workflow while the row is
		// still QUEUED — no worker has claimed it, so the first attempt may have
		// crashed before starting it. Once a worker has claimed it (RUNNING or
		// finished), starting again is not a no-op: `ALLOW_DUPLICATE` lets a
		// COMPLETED workflow id run a second time, and the workflow does not
		// stop when its start claim fails, so a late retry would re-run and
		// re-bill the cases. Return the run as it is instead.
		if (deduplicated && run.status !== "QUEUED") {
			return {
				dispatched: true as const,
				run,
				reason: null,
				productionWarning,
				deduplicated,
			};
		}

		try {
			await startAgenticRunWorkflow({
				projectId: input.projectId,
				organizationId: tenant.organizationId,
				userId: user.id,
				runId: run.id,
				environmentId: environment.id,
				targetBaseUrl: environment.baseUrl,
				testCaseIds: cases.map((c) => c.id),
				runMode: input.runMode,
				scriptRevisionIds:
					input.runMode === "MODE_B" ? scriptRevisionIds : undefined,
				environmentSnapshot: {
					signInUrl: environment.signInUrl,
					authKind: environment.authKind,
					authUsername: environment.authUsername,
					authHeaderName: environment.authHeaderName,
				},
				browser: selectedBrowser,
				resolution:
					input.resolution ?? settings.resolutions[0] ?? "1920x1080",
				// Half a step's estimate — the runner bills per model call
				// and a step is two calls.
				costPerModelCallUsd:
					input.runMode === "MODE_B"
						? 0
						: estimate.estimatedCostUsd / (stepCount * 2),
			});
		} catch (err) {
			// The row exists but nothing is driving it. Left visible as a failed
			// dispatch rather than deleted: a run that vanished is harder to
			// explain than one that says it could not start.
			logger.error("qa.agentic_run.dispatch_failed", {
				projectId: input.projectId,
				runId: run.id,
				error: err instanceof Error ? err.message : String(err),
			});
			if (!deduplicated) {
				auditAttempt("failure", {
					refusal: "DISPATCH_FAILED",
					runId: run.id,
				});
			}
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message:
					"Fabric could not start the run. The run is recorded as not started — try again.",
			});
		}

		if (!deduplicated) {
			auditAttempt("success", {
				runId: run.id,
				estimatedCostUsd: estimate.estimatedCostUsd,
				stepCount,
				runMode: input.runMode,
				testCaseIds: cases.map((c) => c.id),
				// The ruling made legible in the ledger: this run went ahead against a
				// live system on a warning alone, with no confirmation step. The
				// severity is already raised for a production target; this says WHY
				// there is no matching confirmation to point at.
				...(productionWarning
					? { productionAcknowledged: false as const }
					: {}),
			});
		}

		return {
			dispatched: true as const,
			run,
			reason: null,
			productionWarning,
			deduplicated,
		};
	});

export const listAgenticRunsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/qa/agentic-runs",
		tags: ["Projects", "Test Cases"],
		summary: "List the project's Fabric-orchestrated runs",
	})
	.input(
		z.object({
			projectId: z.string(),
			limit: z.number().int().min(1).max(100).optional(),
		}),
	)
	.handler(async ({ input }) => {
		assertPipelineResultsEnabled();
		return listAgenticRuns({
			projectId: input.projectId,
			limit: input.limit,
		});
	});

/**
 * A PAGE of the project's Fabric runs, with the total.
 *
 * The list procedure above returns the newest 25 and stops, which reads as the
 * whole history because nothing says otherwise. This is the way to the rest.
 */
export const listAgenticRunsPageProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/qa/agentic-runs/page",
		tags: ["Projects", "QA"],
		summary: "List a page of the project's Fabric-orchestrated runs",
	})
	.input(
		z.object({
			projectId: z.string(),
			limit: z.number().int().min(1).max(100).default(25),
			offset: z.number().int().min(0).default(0),
		}),
	)
	.handler(async ({ input }) => {
		assertPipelineResultsEnabled();
		return listAgenticRunsPage({
			projectId: input.projectId,
			limit: input.limit,
			offset: input.offset,
		});
	});

/**
 * One run with its per-case step log, and short-lived links to the evidence.
 *
 * Evidence URLs are minted here and expire; the stored value is a KEY, never a
 * URL, so a link cannot outlive the page that showed it. Each key is checked
 * against the tenant prefix before signing — the keys come from our own rows, but
 * signing whatever a row happens to hold is how a path traversal becomes a data
 * leak.
 */
export const getAgenticRunProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/qa/agentic-runs/{runId}",
		tags: ["Projects", "Test Cases"],
		summary: "Get one Fabric-orchestrated run with its step log",
	})
	.input(z.object({ projectId: z.string(), runId: z.string() }))
	.handler(async ({ input }) => {
		assertPipelineResultsEnabled();
		const run = await getAgenticRun({
			projectId: input.projectId,
			runId: input.runId,
		});
		if (!run) {
			throw new ORPCError("NOT_FOUND", { message: "Run not found" });
		}
		const tenant = await requireProjectTenant(input.projectId);

		// The per-case events this run produced, each with its steps. Null
		// pipelineRunId means the run has not finished — there is nothing to read
		// yet, and that is a state, not an error.
		const events = run.pipelineRunId
			? await db.testResultEvent.findMany({
					where: { pipelineRunId: run.pipelineRunId },
					select: {
						id: true,
						testCaseId: true,
						result: true,
						occurredAt: true,
						testCase: { select: { identifier: true, title: true } },
					},
					orderBy: { occurredAt: "asc" },
				})
			: [];

		// Why each case ended as it did. The runner writes a per-case
		// `failureMessage` into the ingested run's stored results, NOT onto
		// `TestResultEvent` (which has no such column), so it is read back through
		// the query that already owns that JSON rather than parsed again here.
		//
		// Load-bearing for a case blocked BEFORE its first step — sign-in failed,
		// the page never loaded — because then there is no step log to explain it
		// and the panel would render a bare verdict with the reason sitting unread
		// in the database. That is exactly how the first real run looked.
		const failureByCaseId = new Map<string, string>();
		if (run.pipelineRunId) {
			const detail = await getProjectPipelineRunDetail({
				projectId: input.projectId,
				runId: run.pipelineRunId,
			});
			for (const result of detail?.results ?? []) {
				if (result.matchedCaseId && result.failureMessage) {
					failureByCaseId.set(
						result.matchedCaseId,
						result.failureMessage,
					);
				}
			}
		}

		const cases = await Promise.all(
			events.map(async (event) => {
				const steps = await listAgenticStepLogs({
					testResultEventId: event.id,
				});
				return {
					testCaseId: event.testCaseId,
					identifier: event.testCase?.identifier ?? null,
					title: event.testCase?.title ?? null,
					result: event.result,
					failureMessage:
						failureByCaseId.get(event.testCaseId) ?? null,
					steps: await Promise.all(
						steps.map(async (step, index) => {
							const readable =
								step.evidenceKey &&
								isTenantOwnedKey(
									step.evidenceKey,
									tenant.organizationId,
									tenant.userId ?? "",
								);
							if (!readable || !step.evidenceKey) {
								return {
									...step,
									evidenceKey: undefined,
									evidenceUrl: null,
									evidenceDownloadUrl: null,
									evidenceFileName: null,
								};
							}
							const bucket =
								config.storage.bucketNames.qaRunEvidence;
							const fileName = evidenceFileName({
								identifier: event.testCase?.identifier ?? null,
								testCaseId: event.testCaseId,
								stepNumber: index + 1,
								key: step.evidenceKey,
							});
							// Two links, because they are two different acts. The
							// inline one renders the image in place; the download
							// one carries a Content-Disposition so the saved file
							// is named after its case and step rather than the
							// object key, which is a UUID.
							const [evidenceUrl, evidenceDownloadUrl] =
								await Promise.all([
									getSignedUrl(step.evidenceKey, {
										bucket,
										expiresIn: EVIDENCE_URL_TTL_SECONDS,
									}).catch(() => null),
									getSignedUrl(step.evidenceKey, {
										bucket,
										expiresIn: EVIDENCE_URL_TTL_SECONDS,
										responseContentDisposition: `attachment; filename="${fileName}"`,
									}).catch(() => null),
								]);
							return {
								...step,
								evidenceKey: undefined,
								evidenceUrl,
								evidenceDownloadUrl,
								evidenceFileName: fileName,
							};
						}),
					),
				};
			}),
		);

		return { run, cases };
	});

/**
 * Stop an in-flight run.
 *
 * Signals the workflow rather than terminating it, so the steps already executed
 * are still persisted. A cancelled run with partial results is far more useful
 * than a cancelled run with none.
 */
export const cancelAgenticRunProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/qa/agentic-runs/{runId}/cancel",
		tags: ["Projects", "Test Cases"],
		summary: "Cancel an in-flight Fabric-orchestrated run",
	})
	.input(z.object({ projectId: z.string(), runId: z.string() }))
	.handler(async ({ input }) => {
		assertPipelineResultsEnabled();
		const { cancelled, workflowId } = await cancelAgenticRun({
			projectId: input.projectId,
			runId: input.runId,
		});

		// Signal even when the row write lost a race: a cancelled row with a live
		// browser behind it is the worse of the two failure modes.
		if (workflowId) {
			try {
				const { getTemporalClient } = await import("@repo/temporal");
				const client = await getTemporalClient();
				await client.workflow
					.getHandle(workflowId)
					.signal("cancelAgenticRun");
			} catch (err) {
				logger.warn("qa.agentic_run.cancel_signal_failed", {
					projectId: input.projectId,
					runId: input.runId,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		// Returned rather than thrown: asking to stop a run that already finished
		// is an ordinary race, not an error worth a red toast.
		return { cancelled };
	});
