/**
 * Delete a synced text file from a project's Context by its path — but only
 * the version the caller names (Fizzy #2636). The ONE function behind the
 * `projects.contexts.deleteSyncedFile` procedure and the v1 REST route
 * `DELETE /api/v1/projects/:projectId/contexts/synced-files` that `fabric
 * context push --prune` calls, so the index cleanup, the audit row and the
 * realtime refresh cannot drift between them.
 *
 *  - The path holds the named version → its points are removed from the
 *    vector index, then the row is deleted: `deleted`.
 *  - The path holds another version (someone changed it since the caller
 *    last saw it) → `conflict`, nothing deleted. Deleting it anyway means
 *    naming that version.
 *  - No row at the path → `absent`, which is also what a retry of a delete
 *    whose response was lost hears.
 *  - No answer within `SYNCED_CONTEXT_DELETE_WAIT_MS` of the call →
 *    `in-progress`: the workflow keeps running (if its start landed), and a
 *    repeat of the call reconciles: it hears `absent` once the row is gone,
 *    or deletes it itself.
 *
 * ## Durable: the destructive steps run in a workflow the request waits on
 *
 * The steps are those of the Context tab's delete (`delete-context.ts` →
 * `contextDeletionWorkflow`): the points, strictly, then the row. They run in
 * `syncedContextDeletionWorkflow` (`@repo/temporal`) rather than in this
 * request, because a process that died between the two left a row that said
 * it was indexed and had no points, and nothing ever came back for it. The
 * workflow's history records which steps finished and a restarted worker
 * carries on from the next one:
 *  1. claim: compare the stored hash with the named one and, in the same
 *     guarded write, mark the row unindexed (`embeddedAt: null`);
 *  2. `deleteProjectContext(..., { strict: true })` on its points;
 *  3. delete the row under the claim's guard. If it changed or moved after
 *     the claim, it survives, and the workflow starts the embedding
 *     workflow to rebuild the points step 2 removed.
 * The tab's own workflow cannot serve here: it deletes whatever the row holds
 * when it runs, seconds after its request was answered, so a version pushed
 * in between would be deleted unseen, and it swallows a failed point delete.
 *
 * This function reads the row's id at the path first (no row: `absent`,
 * nothing started), gives the request an operation id of its own (a fresh
 * UUID), starts the workflow under `synced-context-deletion-<contextId>-
 * <operationId>`, and awaits its answer. If the request is cut off, or the
 * deadline passes (`in-progress`), the workflow still finishes, and a retry
 * starts a run of its own that hears `absent` once the row is gone. A step
 * whose retries are spent fails the workflow with a type saying which step,
 * and the answer is a 500 that says what was and was not done.
 *
 * Why an id per request rather than per row and version: Temporal keeps a
 * closed run under its id, and a handle by id follows the most recent run.
 * With a shared id, a request whose own start never landed would rejoin an
 * OLDER closed run of the same row and version (one that answered `absent`
 * because the row moved after its claim, and has since moved back) and
 * report its stale answer; the CLI would drop the lock entry of a row that
 * still exists. Concurrent deletes of one row need no shared run: the
 * database guards serialize them. The second claim writes the same null, its
 * vector delete is idempotent, and its row delete finds the row gone with no
 * receipt of ITS operation id and answers `absent`; exactly one audit row is
 * written.
 *
 * A start that throws may still have reached Temporal (the acknowledgement
 * can be lost after the server accepted it). Unless the error says the start
 * was refused outright — its arguments were invalid, or the client never
 * sent it — the workflow is rejoined by this request's id and awaited in the
 * same way; that id can only name this request's run, so only a workflow
 * Temporal does not know answers "nothing was deleted".
 *
 * ## One absolute deadline
 *
 * The bound is set when the call begins, and every awaited step — reading
 * the row's id, getting a Temporal client, the start (or rejoin), the result
 * — races the time that is left, so a slow connection cannot push the answer
 * past `SYNCED_CONTEXT_DELETE_WAIT_MS`. If the deadline passes before the
 * start was acknowledged, the answer is still `in-progress`, never "nothing
 * was deleted": the workflow may or may not have started, and the next run
 * reconciles through `absent` or `deleted`.
 *
 * ## The audit row and the realtime events are the workflow's
 *
 * The row delete writes the `project.context_source.synced_file_deleted`
 * audit row, keyed by the operation id (`metadata.operationId`; the workflow
 * id is that plus the row's id, so it is not stored twice), in the SAME
 * transaction (`deleteClaimedSyncedContextRow`), so a deletion is never left
 * unrecorded by a request that died or was cut off after the start, and a
 * retried row delete recognises its own committed attempt. After a
 * `deleted` row delete, the workflow's last activity
 * (`publishSyncedContextDeleted`) emits the two realtime events
 * `delete-context.ts` emits, so a delete that finishes after this request
 * answered `in-progress`, or whose request died, still reaches an open
 * Context tab and the activity feed. The request only hands the workflow
 * what the audit row records about it (`auditRequestFields`: plain values,
 * since workflow input is kept in Temporal's history), and after `deleted`
 * marks the call as curated, so the activity capture does not add a
 * generic row beside the workflow's. It emits nothing itself.
 *
 * ## Authorization is the caller's
 *
 * As for the upsert: the procedure and the v1 route each resolve the caller's
 * LIVE `CONTEXT_DELETE` on the project and its hosting organization, and
 * visibility, before calling this. `organizationId` is that hosting
 * organization, never a caller-supplied value, and it is what the workflow
 * and each of its activities run under.
 */

import { randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/client";
import {
	ContextSourcePathError,
	findSyncedContextIdAtPath,
	normalizeContextSourcePath,
} from "@repo/database";
import { logger } from "@repo/logs";
import {
	getTemporalClient,
	SYNCED_CONTEXT_DELETION_FAILURE,
	SYNCED_CONTEXT_DELETION_TASK_QUEUE,
	type SyncedContextDeletionWorkflowInput,
	type SyncedContextDeletionWorkflowOutput,
} from "@repo/temporal";
import {
	type AuditRequestContext,
	auditRequestFields,
} from "../../../lib/audit";
import { withCorrelationMemo } from "../../../lib/temporal-correlation";
import { markCuratedAuditWritten } from "../../../orpc/middleware/audit-timing-middleware";
import type { SyncedContextSurface } from "./context-content-audit";
import {
	resolveSyncedContextEditor,
	SHA256_HEX,
	type SyncedContextConflict,
} from "./upsert-synced-context";

export interface DeleteSyncedContextInput {
	projectId: string;
	/** As the caller sent it; normalized here. */
	sourcePath: string;
	/** The `contentHash` of the version the caller means to delete. Required. */
	expectedContentHash: string | null | undefined;
	/** The human the request acts as. Never a client-supplied field. */
	userId: string;
	/** The project's hosting organization, resolved server-side. */
	organizationId: string | null;
	via: SyncedContextSurface;
	/**
	 * The request: its sanitized audit fields ride to the workflow, which
	 * writes the audit row.
	 */
	request: AuditRequestContext;
}

export type DeleteSyncedContextResult =
	| {
			status: "deleted";
			contextId: string;
			sourcePath: string;
			/** The hash of the version that was deleted. */
			contentHash: string;
	  }
	/** No row at the path: deleted already, or never pushed. */
	| { status: "absent"; sourcePath: string }
	/**
	 * No answer within `SYNCED_CONTEXT_DELETE_WAIT_MS` of the call. The
	 * workflow keeps running if its start landed; call again to confirm (a
	 * repeat hears `absent` once the row is gone, or deletes it itself).
	 */
	| { status: "in-progress"; sourcePath: string }
	| {
			status: "conflict";
			/** The row that was kept. */
			contextId: string;
			sourcePath: string;
			/** The hash this call named — the version it meant to delete. */
			contentHash: string;
			/** The version stored instead. Never its content. */
			current: SyncedContextConflict;
	  };

/**
 * How long after the call begins it answers `in-progress` if the deletion
 * workflow has not answered: an absolute deadline covering the row lookup,
 * the Temporal connection, the start and the wait. A healthy delete is a
 * few short steps and answers in
 * seconds; 45 s leaves room for a step's retry with backoff, and stays below
 * the 60 s per-request timeout of `@fabricorg/sdk` (`DEFAULT_TIMEOUT_MS`)
 * and of `fabric context push` (`PUSH_TIMEOUT_MS`), so the caller hears the
 * answer instead of timing out first — and far below the app route's
 * 800 s ceiling (`apps/web/app/api/[[...rest]]/route.ts`, `maxDuration`),
 * which the workflow's own worst case (every step's retries spent) can
 * approach.
 */
export const SYNCED_CONTEXT_DELETE_WAIT_MS = 45_000;

/** The workflow could not start, or its claim failed: nothing was deleted. */
const NOTHING_DELETED_MESSAGE =
	"Could not delete this file, and nothing was deleted. Try again.";

/** The index cleanup failed: the row was kept. */
const INDEX_CLEANUP_FAILED_MESSAGE =
	"Could not remove this file from the search index, so nothing was deleted. Try again.";

/** The points are gone and the row is not: a retry finishes the delete. */
const ROW_KEPT_MESSAGE =
	"Removed this file from the search index but could not delete it from the project's Context. Try again to finish.";

/** gRPC `INVALID_ARGUMENT`: Temporal refused the start request as sent. */
const GRPC_INVALID_ARGUMENT = 3;

/**
 * Errors the Temporal client raises BEFORE sending a start (its options or
 * its payloads do not validate), so nothing can have been accepted.
 */
const CLIENT_SIDE_REFUSALS = new Set([
	"TypeError",
	"ValueError",
	"PayloadConverterError",
	"DataConverterError",
]);

/** The errors along a failure's `cause` chain, outermost first. */
function causeChain(error: unknown): unknown[] {
	const chain: unknown[] = [];
	let current: unknown = error;
	for (let depth = 0; current && depth < 8; depth++) {
		chain.push(current);
		current = (current as { cause?: unknown }).cause;
	}
	return chain;
}

/** The `ApplicationFailure.type` values along a failure's `cause` chain. */
function failureTypes(error: unknown): string[] {
	return causeChain(error)
		.map((link) => (link as { type?: unknown }).type)
		.filter((type): type is string => typeof type === "string");
}

/**
 * True only when the start certainly did not create or join a workflow: the
 * client refused it before sending, or Temporal answered `INVALID_ARGUMENT`.
 * Anything else — a dropped connection, a deadline, an unknown error — may
 * have come after Temporal accepted it, so the caller rejoins by id.
 */
function startWasRefused(error: unknown): boolean {
	return causeChain(error).some((link) => {
		const { name, code, details } = link as {
			name?: unknown;
			code?: unknown;
			details?: unknown;
		};
		return (
			(typeof name === "string" && CLIENT_SIDE_REFUSALS.has(name)) ||
			(code === GRPC_INVALID_ARGUMENT && typeof details === "string")
		);
	});
}

/** Temporal has no workflow under the id: the start never landed. */
function isWorkflowNotFound(error: unknown): boolean {
	return causeChain(error).some(
		(link) => (link as { name?: unknown }).name === "WorkflowNotFoundError",
	);
}

type DeletionAnswer =
	| SyncedContextDeletionWorkflowOutput
	| { status: "in-progress" };

/** What a step raced against the deadline yields when the time ran out. */
const EXPIRED = Symbol("synced-context-delete-deadline");

/**
 * The call's one absolute deadline: a single timer set when the call
 * begins, which every awaited step races, so the steps share one budget.
 */
interface Deadline {
	/** `work`'s value, or `EXPIRED` if the deadline passes first. */
	race<T>(work: Promise<T>): Promise<T | typeof EXPIRED>;
	clear(): void;
}

function startDeadline(ms: number): Deadline {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<typeof EXPIRED>((resolve) => {
		timer = setTimeout(() => resolve(EXPIRED), ms);
	});
	return {
		race<T>(work: Promise<T>): Promise<T | typeof EXPIRED> {
			// If the deadline wins, `work` still settles later, and nobody
			// is left to handle its failure: it must not surface as an
			// unhandled rejection.
			work.catch(() => undefined);
			return Promise.race([work, expired]);
		},
		clear() {
			clearTimeout(timer);
		},
	};
}

interface ResultHandle {
	result(): Promise<unknown>;
}

function nothingDeleted(): ORPCError<"INTERNAL_SERVER_ERROR", unknown> {
	return new ORPCError("INTERNAL_SERVER_ERROR", {
		message: NOTHING_DELETED_MESSAGE,
	});
}

/**
 * Start this request's deletion workflow — or, when the start's outcome is
 * unknown, rejoin it by its id — and wait for its answer until the deadline.
 * See the file comment for why, and for what a retry hears.
 */
async function runDeletionWorkflow(
	workflowId: string,
	args: SyncedContextDeletionWorkflowInput,
	deadline: Deadline,
): Promise<DeletionAnswer> {
	const where = `${args.sourcePath} in project ${args.projectId} (workflow ${workflowId})`;
	const inProgress = (step: string): DeletionAnswer => {
		logger.warn(
			`[DeleteSyncedContext] The deletion of ${where} has not answered within ${SYNCED_CONTEXT_DELETE_WAIT_MS} ms of the call (${step}); answering in-progress and leaving it to run, or to the next call`,
		);
		return { status: "in-progress" };
	};

	let client: Awaited<ReturnType<typeof getTemporalClient>>;
	try {
		const connected = await deadline.race(getTemporalClient());
		if (connected === EXPIRED) {
			// Nothing was sent, and nothing will be: the continuation of this
			// call ends here. `in-progress` keeps the caller's lock entry,
			// and the next run deletes it.
			return inProgress("still connecting to Temporal");
		}
		client = connected;
	} catch (error) {
		logger.error(
			`[DeleteSyncedContext] No Temporal client to delete ${where}; nothing was deleted: ${error instanceof Error ? error.message : String(error)}`,
		);
		throw nothingDeleted();
	}

	let handle: ResultHandle;
	let rejoined = false;
	try {
		const startedRun = await deadline.race(
			client.workflow.start(
				"syncedContextDeletionWorkflow",
				withCorrelationMemo({
					taskQueue: SYNCED_CONTEXT_DELETION_TASK_QUEUE,
					// This request's own run. No conflict policy: no other
					// request uses the id, so the default (fail on a running
					// one) can only meet this start's own retry, which the
					// catch below rejoins.
					workflowId,
					args: [args],
				}),
			),
		);
		if (startedRun === EXPIRED) {
			// Maybe started, maybe not: the next run reconciles.
			return inProgress("start not yet acknowledged");
		}
		handle = startedRun;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		if (startWasRefused(error)) {
			logger.error(
				`[DeleteSyncedContext] The start of the deletion of ${where} was refused; nothing was deleted: ${detail}`,
			);
			throw nothingDeleted();
		}
		// The acknowledgement may be what was lost: find out from Temporal.
		// The id is this request's alone, so the handle can only reach this
		// request's run, or fail not-found.
		logger.warn(
			`[DeleteSyncedContext] The start of the deletion of ${where} failed after it may have been accepted; rejoining it by id: ${detail}`,
		);
		handle = client.workflow.getHandle(workflowId);
		rejoined = true;
	}

	try {
		const answer = await deadline.race(
			handle.result() as Promise<SyncedContextDeletionWorkflowOutput>,
		);
		return answer === EXPIRED ? inProgress("workflow running") : answer;
	} catch (error) {
		const types = failureTypes(error);
		const detail = error instanceof Error ? error.message : String(error);
		if (isWorkflowNotFound(error)) {
			logger.error(
				`[DeleteSyncedContext] ${rejoined ? "The rejoined" : "The"} deletion workflow of ${where} does not exist; nothing was deleted: ${detail}`,
			);
			throw nothingDeleted();
		}
		if (types.includes(SYNCED_CONTEXT_DELETION_FAILURE.rowDelete)) {
			logger.error(
				`[DeleteSyncedContext] Removed the points of ${where} but could not delete the row: ${detail}`,
			);
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: ROW_KEPT_MESSAGE,
			});
		}
		if (types.includes(SYNCED_CONTEXT_DELETION_FAILURE.indexCleanup)) {
			logger.error(
				`[DeleteSyncedContext] Could not remove the points of ${where}; nothing was deleted: ${detail}`,
			);
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: INDEX_CLEANUP_FAILED_MESSAGE,
			});
		}
		if (types.includes(SYNCED_CONTEXT_DELETION_FAILURE.claim)) {
			logger.error(
				`[DeleteSyncedContext] Could not claim ${where} for deletion; nothing was deleted: ${detail}`,
			);
			throw nothingDeleted();
		}
		throw error;
	}
}

function badRequest(message: string): ORPCError<"BAD_REQUEST", unknown> {
	return new ORPCError("BAD_REQUEST", { message });
}

function validate(input: DeleteSyncedContextInput): {
	sourcePath: string;
	expectedContentHash: string;
} {
	let sourcePath: string;
	try {
		sourcePath = normalizeContextSourcePath(input.sourcePath);
	} catch (error) {
		if (error instanceof ContextSourcePathError) {
			throw badRequest(error.message);
		}
		throw error;
	}
	const expectedContentHash = input.expectedContentHash?.toLowerCase();
	if (!expectedContentHash || !SHA256_HEX.test(expectedContentHash)) {
		throw badRequest(
			"expectedContentHash is required: the 64-character sha256 hex 'contentHash' of the version you mean to delete",
		);
	}
	return { sourcePath, expectedContentHash };
}

export async function deleteSyncedContext(
	input: DeleteSyncedContextInput,
): Promise<DeleteSyncedContextResult> {
	const deadline = startDeadline(SYNCED_CONTEXT_DELETE_WAIT_MS);
	try {
		return await deleteSyncedContextBefore(input, deadline);
	} finally {
		deadline.clear();
	}
}

async function deleteSyncedContextBefore(
	input: DeleteSyncedContextInput,
	deadline: Deadline,
): Promise<DeleteSyncedContextResult> {
	const { sourcePath, expectedContentHash } = validate(input);

	// ADR-018, as in the upsert: never the fail-closed personal arm.
	const organizationId = input.organizationId;
	if (!organizationId) {
		throw new ORPCError("FORBIDDEN", {
			message: "Synced context files require an organization project",
		});
	}

	const contextId = await deadline.race(
		findSyncedContextIdAtPath({
			projectId: input.projectId,
			sourcePath,
			userId: input.userId,
			organizationId,
		}),
	);
	if (contextId === EXPIRED) {
		// Nothing was started; `in-progress` keeps the caller's lock entry
		// and the next run tries again.
		logger.warn(
			`[DeleteSyncedContext] Reading ${sourcePath} in project ${input.projectId} took longer than ${SYNCED_CONTEXT_DELETE_WAIT_MS} ms; answering in-progress, nothing was started`,
		);
		return { status: "in-progress", sourcePath };
	}
	if (!contextId) {
		return { status: "absent", sourcePath };
	}

	// This request's own operation: the audit row the workflow writes is
	// keyed by it, and no other request's run shares its workflow id.
	const operationId = randomUUID();
	const workflowId = `synced-context-deletion-${contextId}-${operationId}`;
	const outcome = await runDeletionWorkflow(
		workflowId,
		{
			projectId: input.projectId,
			sourcePath,
			expectedContentHash,
			userId: input.userId,
			organizationId,
			operationId,
			audit: { via: input.via, ...auditRequestFields(input.request) },
		},
		deadline,
	);

	if (outcome.status === "absent" || outcome.status === "in-progress") {
		return { status: outcome.status, sourcePath };
	}

	if (outcome.status === "conflict") {
		const { current } = outcome;
		// The conflict is known whatever the lookup does; if naming who made
		// it outlasts the deadline, answer the conflict without the name
		// rather than `in-progress`.
		const editor = await deadline.race(
			resolveSyncedContextEditor(current.contentUpdatedByUserId),
		);
		if (editor === EXPIRED) {
			logger.warn(
				`[DeleteSyncedContext] Naming who changed ${sourcePath} in project ${input.projectId} outlasted ${SYNCED_CONTEXT_DELETE_WAIT_MS} ms; answering the conflict without the editor`,
			);
		}
		return {
			status: "conflict",
			contextId: current.contextId,
			sourcePath,
			contentHash: expectedContentHash,
			current: {
				contextId: current.contextId,
				contentHash: current.contentHash,
				// An ISO string once it has crossed Temporal's payloads.
				contentUpdatedAt: current.contentUpdatedAt
					? new Date(current.contentUpdatedAt)
					: null,
				contentUpdatedBy: editor === EXPIRED ? null : editor,
			},
		};
	}

	const { context } = outcome;

	// The workflow wrote the curated audit row with the delete; tell the
	// activity capture, or it adds a generic `activity.*` row for this call.
	// The realtime events are the workflow's too (see the file comment).
	markCuratedAuditWritten();

	return {
		status: "deleted",
		contextId: context.contextId,
		sourcePath,
		contentHash: expectedContentHash,
	};
}
