/**
 * The test-case push's create (`testCaseSyncWorkflow`, push), under the PM
 * create claim (`pm-create-claim.ts`). The test-case counterpart of
 * `createStoryInPmWithClaim`.
 *
 * The workflow builds the create arguments; this activity checks the case is
 * in the run's project (and organization) and not deleted, takes the case's
 * create claim, sends the create once (`sendAtMostOnce`) and links the case
 * in the write that settles the claim, with the SUCCESS status in the same
 * transaction. An outcome Fabric cannot confirm keeps the claim and is
 * recorded on the case (`create_unconfirmed` or `create_orphan`) while the
 * case still holds the claim, and in the sync log only once it does not; a
 * held claim stops every later create for the case until the user's Unlink
 * & re-create clears it. Every outcome after the claim is taken is returned,
 * not thrown, and every one is recorded here, so the workflow only counts it.
 *
 * Every row write after the claim was taken is fenced on this claim (the
 * case unlinked and still holding it), on top of the attempt scoping: a late
 * outcome of a create whose claim Unlink & re-create cleared never lands on
 * a case another create has claimed or linked since; it goes to the sync log
 * instead. The claim-held stamp is fenced the same way on the claim it saw.
 * A case found linked before anything was sent settles this run's attempt
 * (`alreadyLinked`).
 *
 * A Temporal retry of this activity sends a create only if it takes the
 * claim itself. An earlier attempt that sent a create either linked the case
 * (the retry finds it linked), or kept the claim (the retry records
 * `create_unconfirmed` and sends nothing); it released the claim only on a
 * definite rejection, after which nothing was created. The exception is the
 * user's reset: once Unlink & re-create clears the claim, a retry still
 * outstanding takes a fresh claim and sends its original create arguments.
 *
 * The drift baseline (`lastSyncedPmHash`) needs a read-back from the PM
 * tool, which cannot sit inside the link's database transaction. It is read
 * after the link has committed, best effort, and stamped only while the case
 * still carries this link and no baseline (`stampCreatedBaseline`). The link
 * write clears any earlier baseline, which belonged to another item.
 *
 * A case linked to another PM tool never reaches here: the workflow sends a
 * linked case down its update path, never the create.
 */

import { db, PmSyncStatus } from "@repo/database";
import { logger } from "@repo/logs";
import { jobHeartbeat } from "../lib/job-progress";
import { executeMcpTool } from "../orchestrator/execution/execute-mcp-tool";
import type { ExecuteMcpToolOutput } from "../orchestrator/types";
import { readCreatedTestCaseRefs } from "./created-item-refs";
import { fetchPmTicket } from "./fetch-pm-ticket";
import {
	acquirePmCreateClaim,
	CREATE_UNCONFIRMED_ERROR_CLASS,
	claimHeldMessage,
	createDeadlinePassedMessage,
	createIndeterminateMessage,
	isCreateSendDeadlinePassed,
	isDefiniteMcpCreateRejection,
	PM_CREATE_SEND_TIMEOUT_MS,
	releasePmCreateClaim,
	startPmCreateSendDeadline,
} from "./pm-create-claim";
import {
	describeOrphanCause,
	logCreateOrphanBesideOtherLink,
	recordClaimedCreateOrphan,
	recordCreateUnconfirmed,
} from "./pm-create-orphan";
import { computePmHash } from "./pm-sync-hash";
import {
	recordPmSyncFailure,
	recordPmSyncFailureLog,
	writePmSyncSuccessState,
} from "./record-pm-sync-state";
import type { UpdateTestCaseExternalRefsInput } from "./test-case-sync";

export interface CreateTestCaseInPmWithClaimInput {
	testCaseId: string;
	projectId: string;
	/** Tenant scope of the case check; unset matches the project only. */
	organizationId?: string;
	userId: string;
	mcpConfigId: string | null;
	/** The MCP server the create is sent to, stamped on the new link. */
	mcpServerId?: string;
	/** The PM container's instance binding, as the workflow dispatches it. */
	pmTarget: { additionalContext?: unknown };
	/** The PM tool's detected type, for the recorded failures. */
	pmTool?: string;
	/** The PM tool's name in messages (e.g. "fizzy", "the PM tool"). */
	toolLabel: string;
	toolName: string;
	createArgs: Record<string, unknown>;
	/**
	 * The single-case retry's attempt id (`attemptFor` in the workflow). The
	 * SUCCESS and a rejection's FAILED land only while the case names it;
	 * unset, they skip a case PENDING for an attempt. The link is written
	 * whatever the status, and the unconfirmed and orphan FAILED override
	 * any attempt (a PM item may exist).
	 */
	pmSyncAttemptId?: string;
	/** Post-create drift baseline input, as `updateTestCaseExternalRefs` takes it. */
	baseline?: UpdateTestCaseExternalRefsInput["baseline"];
}

/** One case's outcome; `outcome` says which path was taken. */
export interface CreateTestCaseInPmWithClaimResult {
	success: boolean;
	externalId?: string;
	externalUrl?: string;
	error?: string;
	outcome:
		| "created"
		| "already-linked"
		| "not-in-project"
		| "claim-held"
		| "create-unconfirmed"
		| "create-orphan"
		| "create-rejected";
}

/** How many times the link write after a create is tried. */
const LINK_WRITE_ATTEMPTS = 3;

/** The link write found the case no longer holding this create's claim. */
class PmCreateClaimNotHeldError extends Error {
	constructor(testCaseId: string) {
		super(
			`The PM create claim this link write settles is no longer held on test case ${testCaseId}.`,
		);
		this.name = "PmCreateClaimNotHeldError";
	}
}

export async function createTestCaseInPmWithClaim(
	input: CreateTestCaseInPmWithClaimInput,
): Promise<CreateTestCaseInPmWithClaimResult> {
	await jobHeartbeat();
	const { testCaseId, projectId, organizationId, toolLabel } = input;

	// `acquirePmCreateClaim` matches the case by id only, so the run's
	// project (and organization) is checked here first.
	const testCase = await db.testCase.findFirst({
		where: {
			id: testCaseId,
			projectId,
			deletedAt: null,
			...(organizationId !== undefined
				? { project: { organizationId } }
				: {}),
		},
		select: { id: true },
	});
	if (!testCase) {
		logger.warn("pm.sync.test_case_create.not_in_project", {
			testCaseId,
			projectId,
		});
		return {
			success: false,
			error: "This test case is no longer in this project, so Fabric did not create it in the PM tool.",
			outcome: "not-in-project",
		};
	}

	const recording = {
		itemId: testCaseId,
		itemType: "testCase" as const,
		triggerSource: "manual-edit" as const,
		pmTool: input.pmTool,
		actorUserId: input.userId,
	};

	/**
	 * Record `create_unconfirmed`, fenced on one claim: the claim this
	 * activity saw held (`claim-held`, before anything was sent) or the one
	 * it took (after the send). FAILED is stamped only while the case is
	 * unlinked and still holds that claim; a claim another create took since,
	 * or a link written since, keeps the case's state, and the unconfirmed
	 * create goes to the sync log only.
	 *
	 * A case found linked is the benign outcome only before anything was
	 * sent (`claim-held`): this activity then created nothing, and settles
	 * its own attempt (`alreadyLinked`). After a send, a link someone else
	 * wrote does not make this create's item any less possibly orphaned, so
	 * that is reported as unconfirmed, log only.
	 */
	const recordUnconfirmed = async (
		errorMessage: string,
		reason: "claim-held" | "create-threw" | "create-indeterminate",
		claimId: string | undefined,
	): Promise<CreateTestCaseInPmWithClaimResult> => {
		logger.warn("pm.sync.create_unconfirmed", {
			testCaseId,
			mcpConfigId: input.mcpConfigId,
			reason,
		});
		const recorded = await recordCreateUnconfirmed({
			...recording,
			errorMessage,
			claimId,
		});
		if (recorded.outcome === "linked" && reason === "claim-held") {
			return alreadyLinked(input, recorded);
		}
		if (recorded.outcome !== "recorded") {
			logger.info("pm.sync.create_unconfirmed.log_only", {
				testCaseId,
				reason,
				found: recorded.outcome,
			});
			await recordPmSyncFailureLog({
				...recording,
				errorMessage,
				errorClass: CREATE_UNCONFIRMED_ERROR_CLASS,
			});
		}
		return {
			success: false,
			error: errorMessage,
			outcome:
				reason === "claim-held" ? "claim-held" : "create-unconfirmed",
		};
	};

	/**
	 * Nothing was created: FAILED for this run (attempt-scoped as the
	 * workflow's own failure write is), then the claim is released. Recorded
	 * first, while the claim still keeps every other create (and so every
	 * other link) off the case.
	 */
	const rejected = async (
		claimId: string,
		errorMessage: string,
	): Promise<CreateTestCaseInPmWithClaimResult> => {
		const failure = {
			...recording,
			errorMessage,
			errorClass: "push_failed",
		};
		await recordPmSyncFailure({
			...failure,
			onlyIfAttempt: input.pmSyncAttemptId,
			// A late rejection never lands on a case another create has
			// claimed or linked since Unlink & re-create cleared this claim.
			onlyWhileHoldingCreateClaim: claimId,
		});
		const released = await releasePmCreateClaim({ testCaseId, claimId });
		if (!released) {
			// The claim was no longer this create's (or the release failed):
			// the case's state is not this outcome's, so the log has it.
			await recordPmSyncFailureLog(failure);
		}
		return {
			success: false,
			error: errorMessage,
			outcome: "create-rejected",
		};
	};

	// Started before the claim is asked for, so the claim's database-clock
	// stamp is read after it: no create is sent past it
	// (`PM_CREATE_SEND_TIMEOUT_MS`), however long taking the claim takes.
	const sendDeadline = startPmCreateSendDeadline();
	// Immediately before the create request: nothing is sent unless this
	// attempt took the case's create claim.
	const claim = await acquirePmCreateClaim({ testCaseId });
	if ("miss" in claim) {
		if (claim.miss === "linked") {
			return alreadyLinked(input, claim);
		}
		if (claim.miss === "missing") {
			return {
				success: false,
				error: "This test case was deleted, so Fabric did not create it in the PM tool.",
				outcome: "not-in-project",
			};
		}
		if (claim.heldBy === undefined) {
			// The claim kept slipping between the UPDATE and the read, so no
			// claim was seen to fence a stamp on: an unfenced "any claim held"
			// stamp could land on a newer create's claim and PENDING. This
			// caller sent nothing, so the outcome goes to the sync log only.
			const errorMessage = claimHeldMessage(toolLabel);
			logger.warn("pm.sync.create_unconfirmed", {
				testCaseId,
				mcpConfigId: input.mcpConfigId,
				reason: "claim-held",
				found: "claim-slipping",
			});
			await recordPmSyncFailureLog({
				...recording,
				errorMessage,
				errorClass: CREATE_UNCONFIRMED_ERROR_CLASS,
			});
			return {
				success: false,
				error: errorMessage,
				outcome: "claim-held",
			};
		}
		return recordUnconfirmed(
			claimHeldMessage(toolLabel),
			"claim-held",
			claim.heldBy,
		);
	}
	const pmCreateClaimId = claim.claimId;

	let createResult: ExecuteMcpToolOutput;
	try {
		createResult = await executeMcpTool({
			// Bound to the PM container's GitLab instance at dispatch.
			pmTarget: input.pmTarget,
			toolName: input.toolName,
			args: input.createArgs,
			userId: input.userId,
			organizationId,
			// Read-only mode write-gate keys off projectId.
			projectId,
			mcpConfigId: input.mcpConfigId ?? undefined,
			// A closed connection after the send must not resend it.
			sendAtMostOnce: true,
			// Not sent past the claim's send deadline; Fabric stops waiting for
			// a request in flight there (abandoned on HTTP and SSE, not torn
			// down), an unconfirmed create. A recovery may clear
			// the claim only well after it
			// (`PM_CREATE_CLAIM_RECOVERY_MIN_AGE_MS`).
			timeoutMs: PM_CREATE_SEND_TIMEOUT_MS,
			dispatchDeadline: sendDeadline,
		});
	} catch (createError) {
		// Refused before anything was sent: the instance check.
		if (
			createError instanceof Error &&
			(createError as { type?: unknown }).type ===
				"GitLabPmOriginMismatch"
		) {
			return rejected(pmCreateClaimId, createError.message);
		}
		// Anything else may have followed the send: keep the claim.
		return recordUnconfirmed(
			createIndeterminateMessage(
				toolLabel,
				describeOrphanCause(createError),
			),
			"create-threw",
			pmCreateClaimId,
		);
	}

	if (isCreateSendDeadlinePassed(createResult)) {
		// Not sent: its send deadline passed before the request went out, so
		// nothing was created. FAILED for this run, then the claim released.
		logger.warn("pm.sync.create_not_sent", {
			testCaseId,
			mcpConfigId: input.mcpConfigId,
			reason: "send-deadline-passed",
		});
		return rejected(
			pmCreateClaimId,
			createDeadlinePassedMessage(toolLabel),
		);
	}

	if (!createResult.success) {
		const errorDetail = mcpErrorDetail(createResult.output);
		logger.error("[Test Case Sync] Create failed", {
			testCaseId,
			toolName: input.toolName,
			errorDetail,
			failureKind: createResult.failureKind,
		});
		if (!isDefiniteMcpCreateRejection(createResult)) {
			// Sent, and not proven to have created nothing (a timeout, a
			// transport failure, or an error result): the item may exist.
			return recordUnconfirmed(
				createIndeterminateMessage(toolLabel, errorDetail),
				"create-indeterminate",
				pmCreateClaimId,
			);
		}
		// Refused before it was sent; the message the workflow threw before.
		return rejected(
			pmCreateClaimId,
			`Failed to create work item: ${errorDetail}`,
		);
	}

	// From here the item exists. The claim stays held unless the link write
	// below settles it.
	let externalId = "";
	let externalUrl = "";
	try {
		({ externalId, externalUrl } = readCreatedTestCaseRefs(
			parseMcpResponse(createResult.output),
		));
	} catch (extractError) {
		logger.warn("pm.sync.create_orphan.extract_threw", {
			testCaseId,
			error: describeOrphanCause(extractError),
		});
	}

	if (!externalId) {
		const errorMessage = `${toolLabel} reported the item created, but Fabric could not read its id from the response, so this test case is not linked to it. A ${toolLabel} item may already exist for it. Check ${toolLabel}; if there is none, use Unlink & re-create.`;
		logger.warn("pm.sync.create_orphan", {
			testCaseId,
			mcpConfigId: input.mcpConfigId,
			toolName: input.toolName,
			reason: "no-id",
		});
		await recordClaimedCreateOrphan({
			...recording,
			errorMessage,
			claimId: pmCreateClaimId,
			link: { externalId: null, externalUrl: externalUrl || null },
		});
		return {
			success: false,
			error: errorMessage,
			outcome: "create-orphan",
		};
	}

	const createdResult: CreateTestCaseInPmWithClaimResult = {
		success: true,
		externalId,
		externalUrl: externalUrl || undefined,
		outcome: "created",
	};
	const link = { externalId, externalUrl: externalUrl || null };

	// The link and this create's SUCCESS, in one transaction: the link write
	// clears this attempt's claim (scoped to it, and to an unlinked case),
	// and the status commits with it, so no other writer's state lands
	// between the two. The status write is attempt-scoped
	// (`writePmSyncRunStatus`): with an attempt id it lands only while the
	// case names that attempt; without one it skips a case PENDING for an
	// attempt, while the link still lands. Retried briefly: the item exists,
	// so a lost link is worse than a short wait. A claim no longer held
	// cannot become held again, so that error is not retried.
	for (let attempt = 1; attempt <= LINK_WRITE_ATTEMPTS; attempt++) {
		try {
			await db.$transaction(async (tx) => {
				const { count } = await tx.testCase.updateMany({
					where: {
						id: testCaseId,
						projectId,
						externalId: null,
						pmCreateClaimId,
					},
					data: {
						externalId,
						externalUrl: link.externalUrl,
						...(input.mcpServerId
							? { externalMcpServerId: input.mcpServerId }
							: {}),
						// An earlier link's baseline is not this item's.
						lastSyncedPmHash: null,
						pmCreateClaimId: null,
						pmCreateClaimedAt: null,
					},
				});
				if (count !== 1) {
					throw new PmCreateClaimNotHeldError(testCaseId);
				}
				await writePmSyncSuccessState(
					{
						itemId: testCaseId,
						itemType: "testCase",
						pmSyncAttemptId: input.pmSyncAttemptId,
					},
					tx,
				);
			});
			await stampCreatedBaseline(input, link);
			return createdResult;
		} catch (linkError) {
			const claimLost = linkError instanceof PmCreateClaimNotHeldError;
			// Another case in the project already carries this item's link
			// (the partial unique index on projectId + externalId): a retry
			// cannot succeed.
			const duplicateLink = prismaErrorCode(linkError) === "P2002";
			logger.warn(
				"[Test Case Sync] Failed to persist new external link",
				{
					testCaseId,
					externalId,
					attempt,
					error: describeOrphanCause(linkError),
				},
			);
			if (claimLost || duplicateLink || attempt >= LINK_WRITE_ATTEMPTS) {
				return settleUncertainLink({
					input,
					claimId: pmCreateClaimId,
					link,
					createdResult,
					claimLost,
					cause: linkWriteCause(linkError),
				});
			}
			await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
		}
	}
	// Unreachable: the last attempt returns from the catch above.
	throw new Error("link write loop exited without an outcome");
}

interface CreatedLink {
	externalId: string;
	externalUrl: string | null;
}

/**
 * The link write's outcome is unknown (the claim was gone, or the last try
 * failed): read the case again and settle on what it carries.
 *
 * - This create's link (`isThisCreatesLink`): a try committed but lost its
 *   answer. Its transaction wrote the status with the link, so nothing is
 *   written now except the baseline.
 * - Another link, or one this create cannot prove is its own: the item is
 *   orphaned, and only the sync log records it. The case's status belongs
 *   to the link it carries.
 * - No link, or the read failed: `recordClaimedCreateOrphan`. FAILED is
 *   stamped (claim kept) only while the case is unlinked and still holds
 *   this create's claim, checked in the write itself; otherwise the orphan
 *   goes to the sync log only.
 */
async function settleUncertainLink(args: {
	input: CreateTestCaseInPmWithClaimInput;
	claimId: string;
	link: CreatedLink;
	createdResult: CreateTestCaseInPmWithClaimResult;
	claimLost: boolean;
	cause: string;
}): Promise<CreateTestCaseInPmWithClaimResult> {
	const { input, link, claimLost, cause } = args;
	const { testCaseId, toolLabel } = input;
	const { externalId } = link;
	const persisted = await readPersistedLink(testCaseId, input.projectId);
	if (
		persisted &&
		isThisCreatesLink(persisted, {
			...link,
			mcpServerId: input.mcpServerId,
		})
	) {
		logger.info("pm.sync.create_link.confirmed", {
			testCaseId,
			externalId,
		});
		await stampCreatedBaseline(input, link);
		return args.createdResult;
	}
	const recording = {
		itemId: testCaseId,
		itemType: "testCase" as const,
		triggerSource: "manual-edit" as const,
		pmTool: input.pmTool,
		actorUserId: input.userId,
	};
	const failure = (
		errorMessage: string,
	): CreateTestCaseInPmWithClaimResult => ({
		success: false,
		externalId,
		externalUrl: link.externalUrl ?? undefined,
		error: errorMessage,
		outcome: "create-orphan",
	});
	if (persisted?.externalId) {
		const errorMessage = `Item ${externalId} was created in ${toolLabel}, but Fabric could not link this test case to it: the test case's link changed while the item was being created, and Fabric cannot confirm the link it has now is this item. Check ${toolLabel}: if item ${externalId} is a second item for this test case, delete it there.`;
		logger.warn("pm.sync.create_orphan", {
			testCaseId,
			mcpConfigId: input.mcpConfigId,
			externalId,
			reason: "row-carries-another-link",
		});
		await logCreateOrphanBesideOtherLink({
			...recording,
			errorMessage,
			link,
		});
		return failure(errorMessage);
	}
	const errorMessage = `Item ${externalId} was created in ${toolLabel} but Fabric could not save its link (${cause}), so this test case is not linked to it. Check ${toolLabel}: use Unlink & re-create only if item ${externalId} was deleted or a second one is wanted.`;
	logger.warn("pm.sync.create_orphan", {
		testCaseId,
		mcpConfigId: input.mcpConfigId,
		externalId,
		reason: claimLost ? "claim-not-held" : "link-write-failed",
	});
	await recordClaimedCreateOrphan({
		...recording,
		errorMessage,
		claimId: args.claimId,
		link,
	});
	return failure(errorMessage);
}

interface PersistedLink {
	externalId: string | null;
	externalUrl: string | null;
	externalMcpServerId: string | null;
}

/** The case's stored link, read again in its project; `null` when unreadable. */
async function readPersistedLink(
	testCaseId: string,
	projectId: string,
): Promise<PersistedLink | null> {
	try {
		return await db.testCase.findFirst({
			where: { id: testCaseId, projectId },
			select: {
				externalId: true,
				externalUrl: true,
				externalMcpServerId: true,
			},
		});
	} catch (readError) {
		logger.warn("pm.sync.create_link.reread_failed", {
			testCaseId,
			error: describeOrphanCause(readError),
		});
		return null;
	}
}

/**
 * Whether the stored link is provably the one this create wrote: the same
 * id and the same URL, and the same server stamp when this create stamps
 * one. An id and a server stamp alone are not unique to a create (two
 * configurations sharing one MCP server can reach different instances), so
 * a create that returned no URL is never confirmed this way.
 */
function isThisCreatesLink(
	row: PersistedLink,
	created: CreatedLink & { mcpServerId?: string },
): boolean {
	return (
		row.externalId === created.externalId &&
		created.externalUrl !== null &&
		row.externalUrl === created.externalUrl &&
		(!created.mcpServerId ||
			row.externalMcpServerId === created.mcpServerId)
	);
}

/**
 * Stamp the new link's drift baseline from a read-back of the item, so the
 * next push can tell a PM-side edit from its own (the readback, not the
 * pushed body, is hashed: Azure DevOps re-renders markdown). Runs after the
 * link has committed, since a PM call cannot sit inside that transaction.
 * Best effort: a failed read-back or write leaves no baseline, which the
 * conflict guard reads as "no drift known", as before for a failed readback.
 * Stamped only while the case carries this create's link and no baseline yet
 * (the link write cleared it), so a newer push's baseline or a later
 * relink is never overwritten.
 */
async function stampCreatedBaseline(
	input: CreateTestCaseInPmWithClaimInput,
	link: CreatedLink,
): Promise<void> {
	const baseline = input.baseline;
	if (!baseline?.capabilities?.taskGet) {
		return;
	}
	try {
		const snapshot = await fetchPmTicket({
			mcpConfigId: baseline.mcpConfigId,
			userId: baseline.userId,
			organizationId: baseline.organizationId,
			capabilities: baseline.capabilities,
			externalId: link.externalId,
			containerId: baseline.containerId,
			containerName: baseline.containerName,
			additionalContext: baseline.additionalContext,
		});
		if (!snapshot) {
			return;
		}
		const { count } = await db.testCase.updateMany({
			where: {
				id: input.testCaseId,
				projectId: input.projectId,
				externalId: link.externalId,
				externalUrl: link.externalUrl,
				...(input.mcpServerId
					? { externalMcpServerId: input.mcpServerId }
					: {}),
				lastSyncedPmHash: null,
			},
			data: {
				lastSyncedPmHash: computePmHash(
					snapshot.title,
					snapshot.description,
				),
			},
		});
		if (count === 0) {
			logger.info("pm.sync.create_baseline.skipped", {
				testCaseId: input.testCaseId,
				reason: "link-or-baseline-changed",
			});
		}
	} catch (baselineError) {
		logger.warn("pm.sync.create_baseline.failed", {
			testCaseId: input.testCaseId,
			error: describeOrphanCause(baselineError),
		});
	}
}

/** A Prisma known-request error's code (`P2002`, ...), when it has one. */
function prismaErrorCode(error: unknown): string | null {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === "string" && /^P\d{4}$/.test(code) ? code : null;
}

/**
 * The failed link write's cause, for the message on the case: short, and
 * free of the query text and file paths a Prisma error message carries
 * (the full error is logged).
 */
function linkWriteCause(error: unknown): string {
	const code = prismaErrorCode(error);
	if (code === "P2002") {
		return "another test case in this project is already linked to that item";
	}
	if (code) {
		return `database error ${code}`;
	}
	return (
		describeOrphanCause(error).trim().split("\n")[0]?.slice(0, 200) ?? ""
	);
}

/**
 * Another push linked the case, and this activity sent no create. The case
 * needs no create; what is left is this run's own attempt: a retry stamped
 * the case PENDING for it, and the push that linked the case (a run with no
 * attempt id) left that PENDING alone. So, with an attempt id, the attempt
 * is settled to SUCCESS, in one conditional write that requires the case to
 * still name this attempt and carry the link seen here. A newer attempt, a
 * link changed since, or a run with no attempt id writes nothing. Best
 * effort: a failed write leaves the PENDING for the stuck-sync watchdog.
 */
async function alreadyLinked(
	input: CreateTestCaseInPmWithClaimInput,
	link: { externalId: string; externalUrl: string | null },
): Promise<CreateTestCaseInPmWithClaimResult> {
	const { testCaseId } = input;
	logger.info("pm.sync.create_skipped", { testCaseId, reason: "linked" });
	if (input.pmSyncAttemptId !== undefined) {
		try {
			const { count } = await db.testCase.updateMany({
				where: {
					id: testCaseId,
					projectId: input.projectId,
					lastPmSyncAttemptId: input.pmSyncAttemptId,
					externalId: link.externalId,
					externalUrl: link.externalUrl,
				},
				data: {
					lastPmSyncStatus: PmSyncStatus.SUCCESS,
					lastPmSyncError: null,
					lastPmSyncAttemptAt: new Date(),
				},
			});
			if (count === 0) {
				logger.info("pm.sync.create_skipped.attempt_not_settled", {
					testCaseId,
					reason: "attempt-or-link-changed",
				});
			}
		} catch (error) {
			logger.warn("pm.sync.create_skipped.settle_failed", {
				testCaseId,
				error: describeOrphanCause(error),
			});
		}
	}
	return {
		success: true,
		externalId: link.externalId,
		externalUrl: link.externalUrl ?? undefined,
		outcome: "already-linked",
	};
}

/**
 * An MCP result's text content, parsed as JSON when it is JSON. The same
 * reading `testCaseSyncWorkflow` applies to its MCP responses.
 */
function parseMcpResponse(output: unknown): unknown {
	if (typeof output === "object" && output !== null) {
		const obj = output as Record<string, unknown>;
		if (Array.isArray(obj.content)) {
			const textContent = obj.content.find(
				(c: unknown) =>
					typeof c === "object" &&
					c !== null &&
					(c as Record<string, unknown>).type === "text",
			) as { text?: string } | undefined;
			if (textContent?.text) {
				try {
					return JSON.parse(textContent.text);
				} catch {
					return textContent.text;
				}
			}
		}
	}
	return output;
}

/** A failed MCP result's error text, read as the workflow read it. */
function mcpErrorDetail(output: unknown): string {
	const parsed = parseMcpResponse(output);
	if (typeof parsed === "string") {
		return parsed;
	}
	if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
		return String((parsed as Record<string, unknown>).error);
	}
	return "Unknown error";
}
