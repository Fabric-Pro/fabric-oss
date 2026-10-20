/**
 * The bulk story sync's link check and claimed create (`storySyncWorkflow`, push).
 *
 * Linked stories use `checkStoryPmLink` before PM updates. It checks the
 * server stamp and legacy link origin, sharing the fenced refusal writer
 * with the create activity's legacy action.
 *
 * The workflow builds the create arguments; `createStoryInPmWithClaim`
 * checks the story is in the run's project, takes its create claim, sends the create
 * once (`sendAtMostOnce`) and links the row in the write that settles the
 * claim, with the SUCCESS status in the same transaction. An outcome Fabric
 * cannot confirm keeps the claim and is recorded on the row
 * (`create_unconfirmed` or `create_orphan`) while the row still holds the
 * claim, and in the sync log only once it does not. A held claim blocks
 * later claimed creates until the user's Unlink & re-create clears it.
 * The create and link write are caught here, and the release and recording
 * helpers handle their own errors, so every outcome after the claim is taken
 * is returned, not thrown.
 *
 * A Temporal retry of the create activity sends a create only if it takes the
 * claim itself (`acquirePmCreateClaim`'s conditional UPDATE). An earlier
 * attempt that sent a create either linked the row (the retry finds it
 * linked), or kept the claim (the retry records `create_unconfirmed` and
 * sends nothing); it released the claim only on a definite rejection, after
 * which nothing was created. The exception is the user's reset: once
 * Unlink & re-create clears the claim, a retry still outstanding takes a
 * fresh claim and sends this activity's original create arguments.
 *
 * Histories recorded before `bulk-sync-link-guard-v1` use the create
 * activity's `refuse-legacy-link` action. Like `checkStoryPmLink`, it uses
 * the fenced failure writer to offer Unlink & re-create for a mismatched link.
 */

import { db, PmSyncStatus } from "@repo/database";
import { logger } from "@repo/logs";
import { pmTargetsConflict } from "@repo/utils/pm-target";
import { jobHeartbeat } from "../lib/job-progress";
import { executeMcpTool } from "../orchestrator/execution/execute-mcp-tool";
import type { ExecuteMcpToolOutput } from "../orchestrator/types";
import { resolveExternalPmTarget } from "./external-pm-target";
import {
	acquirePmCreateClaim,
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
	describeLinkWriteCause,
	describeOrphanCause,
	logCreateOrphanBesideOtherLink,
	recordClaimedCreateOrphan,
	recordCreateUnconfirmed,
} from "./pm-create-orphan";
import { describeSyncErrorForUser } from "./pm-sync-user-error";
import {
	detectExternalLinkMismatch,
	legacyLinkOtherToolMessage,
} from "./pm-tool-mismatch";
import { updateStoryFromPm } from "./pm-update-story";
import {
	recordPmSyncFailure,
	writePmSyncSuccessState,
} from "./record-pm-sync-state";
import { resolveStoryPmLinkConfig } from "./story-pm-link-config";

interface CreateStoryInPmCommon {
	storyId: string;
	projectId: string;
	/** Tenant scope of the story check; unset matches the project only. */
	organizationId?: string;
	userId: string;
	mcpConfigId: string | null;
	/**
	 * The MCP server the create is sent to, stamped on the new link
	 * (`externalMcpServerId`) as the single-row create paths do.
	 */
	mcpServerId?: string;
	/** The PM container's instance binding, as the workflow dispatches it. */
	pmTarget: { additionalContext?: unknown; containerId?: string };
	/** The PM tool's detected type, for the recorded failures. */
	pmTool?: string;
	/** The PM tool's name in messages (e.g. "fizzy", "the PM tool"). */
	toolLabel: string;
}

export type CreateStoryInPmWithClaimInput = CreateStoryInPmCommon &
	(
		| {
				action: "create";
				toolName: string;
				createArgs: Record<string, unknown>;
		  }
		| {
				/**
				 * Only histories recorded before `bulk-sync-link-guard-v1`
				 * reach this action. They judged the link by URL; nothing
				 * is created.
				 */
				action: "refuse-legacy-link";
				externalId: string;
				externalUrl: string | null;
		  }
	);

/**
 * One story's outcome, in the shape the workflow pushes into its progress
 * results. `outcome` says which path was taken.
 */
export interface CreateStoryInPmWithClaimResult {
	success: boolean;
	externalId?: string;
	externalUrl?: string;
	error?: string;
	outcome:
		| "created"
		| "already-linked"
		| "link-ok"
		| "attempt-superseded"
		| "not-in-project"
		| "claim-held"
		| "create-unconfirmed"
		| "create-orphan"
		| "create-rejected"
		| "legacy-other-tool"
		| "block"
		| "link-changed";
}

/** The link snapshot the bulk workflow would send to the active server. */
export interface CheckStoryPmLinkInput {
	pmTarget?: { additionalContext?: unknown; containerId?: string };
	verb?: "push" | "pull";
	storyId: string;
	projectId: string;
	organizationId?: string;
	userId: string;
	mcpConfigId: string | null;
	mcpServerId: string;
	pmTool?: string;
	toolLabel: string;
	externalId: string;
	externalUrl: string | null;
	externalMcpServerId: string | null;
	externalPmTarget?: string | null;
}

function readStoryLink(input: {
	storyId: string;
	projectId: string;
	organizationId?: string;
}) {
	return db.userStory.findFirst({
		where: {
			id: input.storyId,
			projectId: input.projectId,
			...(input.organizationId !== undefined
				? { project: { organizationId: input.organizationId } }
				: {}),
		},
		select: {
			externalId: true,
			externalUrl: true,
			externalMcpServerId: true,
			externalPmTarget: true,
			lastPmSyncAttemptId: true,
			lastPmSyncStatus: true,
		},
	});
}

type StoryLink = NonNullable<Awaited<ReturnType<typeof readStoryLink>>>;
type JudgedStoryLink = Pick<
	CheckStoryPmLinkInput,
	"externalId" | "externalUrl"
> & {
	externalMcpServerId?: string | null;
	externalPmTarget?: string | null;
	mcpServerId?: string;
};

function storyLinkChanged(story: StoryLink, input: JudgedStoryLink): boolean {
	return (
		story.externalId !== input.externalId ||
		story.externalUrl !== input.externalUrl ||
		pmTargetsConflict(story.externalPmTarget, input.externalPmTarget) ||
		(input.externalMcpServerId !== undefined &&
			story.externalMcpServerId !== input.externalMcpServerId &&
			// A concurrent successful push can backfill this same legacy link.
			!(
				input.externalMcpServerId === null &&
				story.externalMcpServerId === input.mcpServerId
			))
	);
}

function changedStoryLink(
	verb: "push" | "pull" = "push",
): CreateStoryInPmWithClaimResult {
	return {
		success: false,
		error: `This story's PM link changed while it was syncing, so Fabric did not ${verb} it. Sync again to use the current link.`,
		outcome: "link-changed",
	};
}

/** Config I/O and the fenced refusal stay in activities, before PM dispatch. */
export async function checkStoryPmLink(
	input: CheckStoryPmLinkInput,
): Promise<CreateStoryInPmWithClaimResult> {
	await jobHeartbeat();
	const story = await readStoryLink(input);
	if (!story) {
		return {
			success: false,
			outcome: "not-in-project",
			error: `This story is no longer in this project, so Fabric did not ${input.verb ?? "push"} it.`,
		};
	}
	if (storyLinkChanged(story, input)) {
		return changedStoryLink(input.verb);
	}
	const { config, instanceOrigin } = await resolveStoryPmLinkConfig({
		mcpConfigId: input.mcpConfigId,
		mcpServerId: input.mcpServerId,
		userId: input.userId,
		organizationId: input.organizationId,
		additionalContext: input.pmTarget?.additionalContext,
	});

	const mismatch = detectExternalLinkMismatch({
		externalId: input.externalId,
		externalUrl: input.externalUrl,
		externalMcpServerId: story.externalMcpServerId,
		...(story.externalPmTarget !== undefined
			? { externalPmTarget: story.externalPmTarget }
			: {}),
		activePmTarget:
			story.externalPmTarget == null
				? null
				: await resolveExternalPmTarget({
						...input,
						stableContainerId: input.pmTarget?.containerId,
						containerId: input.pmTarget?.containerId,
						additionalContext: input.pmTarget?.additionalContext,
						config,
					}),
		activeServerId: input.mcpServerId,
		currentDetectedType: input.pmTool,
		currentBaseUrl: config.baseUrl || config.mcpServer.defaultUrl || null,
		currentInstanceOrigin: instanceOrigin,
	});
	if (mismatch.resolution === "ok") {
		return {
			success: true,
			externalId: input.externalId,
			externalUrl: input.externalUrl ?? undefined,
			outcome: "link-ok",
		};
	}
	return refuseLegacyLink(input, story, mismatch.resolution);
}

/** How many times the link write after a create is tried. */
const LINK_WRITE_ATTEMPTS = 3;

export async function createStoryInPmWithClaim(
	input: CreateStoryInPmWithClaimInput,
): Promise<CreateStoryInPmWithClaimResult> {
	await jobHeartbeat();
	const externalPmTarget = input.mcpServerId
		? await resolveExternalPmTarget({
				...input,
				stableContainerId: input.pmTarget?.containerId,
				containerId: input.pmTarget?.containerId,
				additionalContext: input.pmTarget?.additionalContext,
			})
		: null;
	const { storyId, projectId, organizationId, toolLabel } = input;

	// `acquirePmCreateClaim` matches the row by id only, so the run's
	// project (and organization) is checked here first.
	const story = await readStoryLink(input);
	if (!story) {
		logger.warn("pm.sync.bulk_create.not_in_project", {
			storyId,
			projectId,
		});
		return {
			success: false,
			error: "This story is no longer in this project, so Fabric did not create it in the PM tool.",
			outcome: "not-in-project",
		};
	}

	if (input.action === "refuse-legacy-link") {
		return refuseLegacyLink(input, story);
	}

	const recordUnconfirmed = async (
		errorMessage: string,
		reason: "claim-held" | "create-threw" | "create-indeterminate",
	): Promise<CreateStoryInPmWithClaimResult> => {
		logger.warn("pm.sync.create_unconfirmed", {
			storyId,
			mcpConfigId: input.mcpConfigId,
			reason,
		});
		// Written only while the row is unlinked and its claim is held; a
		// row linked since is the benign outcome.
		const recording = await recordCreateUnconfirmed({
			itemId: storyId,
			itemType: "story",
			errorMessage,
			triggerSource: "manual-edit",
			pmTool: input.pmTool,
			actorUserId: input.userId,
		});
		if (recording.outcome === "linked") {
			return alreadyLinked(storyId, recording);
		}
		return {
			success: false,
			error: errorMessage,
			outcome:
				reason === "claim-held" ? "claim-held" : "create-unconfirmed",
		};
	};

	// Started before the claim is asked for, so the claim's database-clock
	// stamp is read after it: no create is sent past it
	// (`PM_CREATE_SEND_TIMEOUT_MS`), however long taking the claim takes.
	const sendDeadline = startPmCreateSendDeadline();
	// Immediately before the create request: nothing is sent unless this
	// attempt took the row's create claim. After Unlink & re-create cleared
	// an earlier attempt's claim, a retry can take a fresh one and send.
	const claim = await acquirePmCreateClaim({ storyId });
	if ("miss" in claim) {
		if (claim.miss === "linked") {
			return alreadyLinked(storyId, claim);
		}
		if (claim.miss === "missing") {
			return {
				success: false,
				error: "This story was deleted, so Fabric did not create it in the PM tool.",
				outcome: "not-in-project",
			};
		}
		return recordUnconfirmed(claimHeldMessage(toolLabel), "claim-held");
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
			// Read-only mode write-gate: blocks creates still queued in a
			// bulk run when the mode is switched on mid-run.
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
		logger.warn("[PM Sync] Create request threw", { error: createError });
		// Refused before anything was sent: the instance check.
		if (
			createError instanceof Error &&
			(createError as { type?: unknown }).type ===
				"GitLabPmOriginMismatch"
		) {
			await releasePmCreateClaim({ storyId, claimId: pmCreateClaimId });
			return {
				success: false,
				error: createError.message,
				outcome: "create-rejected",
			};
		}
		// Anything else may have followed the send: keep the claim.
		return recordUnconfirmed(
			createIndeterminateMessage(
				toolLabel,
				describeSyncErrorForUser(createError),
			),
			"create-threw",
		);
	}

	if (isCreateSendDeadlinePassed(createResult)) {
		// Not sent: its send deadline passed before the request went out, so
		// nothing was created. Release the claim so a later push can create.
		logger.warn("pm.sync.create_not_sent", {
			storyId,
			mcpConfigId: input.mcpConfigId,
			reason: "send-deadline-passed",
		});
		await releasePmCreateClaim({ storyId, claimId: pmCreateClaimId });
		return {
			success: false,
			error: createDeadlinePassedMessage(toolLabel),
			outcome: "create-rejected",
		};
	}

	if (!createResult.success) {
		const errorDetail = mcpErrorDetail(createResult.output);
		logger.error("[Story Sync] Bulk create failed", {
			storyId,
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
			);
		}
		// Refused before it was sent: release the claim so the next push
		// can create.
		await releasePmCreateClaim({ storyId, claimId: pmCreateClaimId });
		return {
			success: false,
			error:
				`Failed to create work item: ${errorDetail}. ` +
				"Try changing Work Item Type in Project Settings " +
				"(Scrum = Product Backlog Item, Agile = User Story, Basic = Issue).",
			outcome: "create-rejected",
		};
	}

	// From here the item exists. The claim stays held unless the link write
	// below settles it.
	let externalId = "";
	let externalUrl = "";
	try {
		({ externalId, externalUrl } = readCreatedRefs(createResult.output));
	} catch (extractError) {
		logger.warn("pm.sync.create_orphan.extract_threw", {
			storyId,
			error: describeOrphanCause(extractError),
		});
	}

	if (!externalId) {
		const errorMessage = `${toolLabel} reported the item created, but Fabric could not read its id from the response, so this story is not linked to it. A ${toolLabel} item may already exist for it. Check ${toolLabel}; if there is none, use Unlink & re-create.`;
		logger.warn("pm.sync.create_orphan", {
			storyId,
			mcpConfigId: input.mcpConfigId,
			toolName: input.toolName,
			reason: "no-id",
		});
		await recordClaimedCreateOrphan({
			itemId: storyId,
			itemType: "story",
			errorMessage,
			triggerSource: "manual-edit",
			pmTool: input.pmTool,
			actorUserId: input.userId,
			claimId: pmCreateClaimId,
			link: { externalId: null, externalUrl: externalUrl || null },
		});
		return {
			success: false,
			error: errorMessage,
			outcome: "create-orphan",
		};
	}

	const createdResult: CreateStoryInPmWithClaimResult = {
		success: true,
		externalId,
		externalUrl: externalUrl || undefined,
		outcome: "created",
	};

	// The link and this create's SUCCESS, in one transaction: the link write
	// clears this attempt's claim (scoped to it), and the status commits with
	// it, so no other writer's state lands between the two. SUCCESS replaces
	// a failure a loser of the claim (a concurrent push, or a retry of this
	// activity) recorded while this attempt held it; with no attempt id, a
	// row PENDING for an attempt keeps its status
	// (`writePmSyncStatusUnattempted`) while the link still lands. Retried
	// briefly: the item exists, so a lost link is worse than a short wait. A
	// claim no longer held (Unlink & re-create cleared it, or an earlier try
	// here committed but lost its answer) cannot become held again, so that
	// error is not retried.
	for (let attempt = 1; attempt <= LINK_WRITE_ATTEMPTS; attempt++) {
		try {
			await db.$transaction(async (tx) => {
				await updateStoryFromPm(
					storyId,
					projectId,
					{
						externalId,
						externalUrl: externalUrl || undefined,
						...(input.mcpServerId
							? {
									externalMcpServerId: input.mcpServerId,
									externalPmTarget,
								}
							: {}),
					},
					{ settlesPmCreateClaim: pmCreateClaimId },
					tx,
				);
				await writePmSyncSuccessState(
					{ itemId: storyId, itemType: "story" },
					tx,
				);
			});
			return createdResult;
		} catch (linkError) {
			const claimLost =
				linkError instanceof Error &&
				linkError.name === "PmCreateClaimNotHeldError";
			logger.warn("[Story Sync] Failed to persist new external link", {
				storyId,
				externalId,
				attempt,
				error: describeOrphanCause(linkError),
			});
			if (claimLost || attempt >= LINK_WRITE_ATTEMPTS) {
				return settleUncertainLink({
					input,
					claimId: pmCreateClaimId,
					externalId,
					externalUrl,
					createdResult,
					claimLost,
					cause: describeLinkWriteCause(linkError, "story"),
				});
			}
			await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
		}
	}
	// Unreachable: the last attempt returns from the catch above.
	throw new Error("link write loop exited without an outcome");
}

/**
 * The link write's outcome is unknown (the claim was gone, or the last try
 * failed): read the row again and settle on what it carries.
 *
 * - This create's link (`isThisCreatesLink`): a try committed but lost its
 *   answer. Its transaction wrote the status with the link, so nothing is
 *   written now.
 * - Another link, or one this create cannot prove is its own: the item is
 *   orphaned, and only the sync log records it. The row's status belongs to
 *   the link it carries.
 * - No link, or the read failed: `recordClaimedCreateOrphan`. FAILED is
 *   stamped (claim kept) only while the row is unlinked and still holds
 *   this create's claim, checked in the write itself; otherwise the orphan
 *   goes to the sync log only. A failed read authorises nothing more.
 */
async function settleUncertainLink(args: {
	input: CreateStoryInPmCommon;
	claimId: string;
	externalId: string;
	externalUrl: string;
	createdResult: CreateStoryInPmWithClaimResult;
	claimLost: boolean;
	cause: string;
}): Promise<CreateStoryInPmWithClaimResult> {
	const { input, externalId, externalUrl, claimLost, cause } = args;
	const { storyId, toolLabel } = input;
	const persisted = await readPersistedLink(storyId, input.projectId);
	if (
		persisted &&
		isThisCreatesLink(persisted, {
			externalId,
			externalUrl,
			mcpServerId: input.mcpServerId,
		})
	) {
		logger.info("pm.sync.create_link.confirmed", { storyId, externalId });
		return args.createdResult;
	}
	const recording = {
		itemId: storyId,
		itemType: "story" as const,
		triggerSource: "manual-edit" as const,
		pmTool: input.pmTool,
		actorUserId: input.userId,
	};
	const failure = (errorMessage: string): CreateStoryInPmWithClaimResult => ({
		success: false,
		externalId,
		externalUrl: externalUrl || undefined,
		error: errorMessage,
		outcome: "create-orphan",
	});
	if (persisted?.externalId) {
		const errorMessage = `Item ${externalId} was created in ${toolLabel}, but Fabric could not link this story to it: the story's link changed while the item was being created, and Fabric cannot confirm the link it has now is this item. Check ${toolLabel}: if item ${externalId} is a second item for this story, delete it there.`;
		logger.warn("pm.sync.create_orphan", {
			storyId,
			mcpConfigId: input.mcpConfigId,
			externalId,
			reason: "row-carries-another-link",
		});
		await logCreateOrphanBesideOtherLink({
			...recording,
			errorMessage,
			link: { externalId, externalUrl: externalUrl || null },
		});
		return failure(errorMessage);
	}
	const errorMessage = `Item ${externalId} was created in ${toolLabel} but Fabric could not save its link (${cause}), so this story is not linked to it. Check ${toolLabel}: use Unlink & re-create only if item ${externalId} was deleted or a second one is wanted.`;
	logger.warn("pm.sync.create_orphan", {
		storyId,
		mcpConfigId: input.mcpConfigId,
		externalId,
		reason: claimLost ? "claim-not-held" : "link-write-failed",
	});
	await recordClaimedCreateOrphan({
		...recording,
		errorMessage,
		claimId: args.claimId,
		link: { externalId, externalUrl: externalUrl || null },
	});
	return failure(errorMessage);
}

interface PersistedLink {
	externalId: string | null;
	externalUrl: string | null;
	externalMcpServerId: string | null;
	externalPmTarget?: string | null;
}

/** The row's stored link, read again in its project; `null` when unreadable. */
async function readPersistedLink(
	storyId: string,
	projectId: string,
): Promise<PersistedLink | null> {
	try {
		return await db.userStory.findFirst({
			where: { id: storyId, projectId },
			select: {
				externalId: true,
				externalUrl: true,
				externalMcpServerId: true,
				externalPmTarget: true,
			},
		});
	} catch (readError) {
		logger.warn("pm.sync.create_link.reread_failed", {
			storyId,
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
	created: { externalId: string; externalUrl: string; mcpServerId?: string },
): boolean {
	return (
		row.externalId === created.externalId &&
		created.externalUrl !== "" &&
		row.externalUrl === created.externalUrl &&
		(!created.mcpServerId ||
			row.externalMcpServerId === created.mcpServerId)
	);
}

/** Another run linked the row: nothing created, nothing written. */
function alreadyLinked(
	storyId: string,
	link: { externalId: string; externalUrl: string | null },
): CreateStoryInPmWithClaimResult {
	logger.info("pm.sync.create_skipped", { storyId, reason: "linked" });
	return {
		success: true,
		externalId: link.externalId,
		externalUrl: link.externalUrl ?? undefined,
		outcome: "already-linked",
	};
}

/**
 * Record the recovery message only while the judged link and read attempt
 * still match. Old workflow histories omit the judged stamp; new checks
 * include it and re-read predicate misses before naming their outcome.
 */
async function refuseLegacyLink(
	input: Pick<
		CreateStoryInPmCommon,
		| "storyId"
		| "projectId"
		| "organizationId"
		| "userId"
		| "pmTool"
		| "toolLabel"
	> &
		JudgedStoryLink &
		Pick<CheckStoryPmLinkInput, "verb">,
	story: StoryLink,
	outcome: "block" | "legacy-other-tool" = "legacy-other-tool",
): Promise<CreateStoryInPmWithClaimResult> {
	if (storyLinkChanged(story, input)) {
		return changedStoryLink(input.verb);
	}
	const errorMessage = legacyLinkOtherToolMessage(
		input.toolLabel,
		input.verb,
	);
	const recorded = await recordPmSyncFailure({
		direction: input.verb,
		itemId: input.storyId,
		itemType: "story",
		errorMessage,
		errorClass: "PM_TOOL_MISMATCH_LEGACY",
		triggerSource: "manual-edit",
		pmTool: input.pmTool,
		actorUserId: input.userId,
		onlyIfRowUnchanged: {
			externalId: story.externalId,
			externalUrl: story.externalUrl,
			externalMcpServerId: story.externalMcpServerId,
			...(story.externalPmTarget !== undefined
				? { externalPmTarget: story.externalPmTarget }
				: {}),
			lastPmSyncAttemptId: story.lastPmSyncAttemptId,
		},
	});
	const refusal: CreateStoryInPmWithClaimResult = {
		success: false,
		error: errorMessage,
		outcome,
	};
	if (recorded || input.externalMcpServerId === undefined) {
		return refusal;
	}
	// A missed fence or a failed write records nothing. Read again so a
	// replacement link or active-server backfill keeps its own state.
	const current = await readStoryLink(input);
	if (!current) {
		return {
			success: false,
			outcome: "not-in-project",
			error: `This story is no longer in this project, so Fabric did not ${input.verb ?? "push"} it.`,
		};
	}
	const snapshot = {
		...input,
		externalMcpServerId: story.externalMcpServerId,
		...(story.externalPmTarget !== undefined
			? { externalPmTarget: story.externalPmTarget }
			: {}),
	};
	if (storyLinkChanged(current, snapshot)) {
		return changedStoryLink(input.verb);
	}
	if (
		story.externalMcpServerId === null &&
		current.externalMcpServerId === input.mcpServerId
	) {
		return {
			success: true,
			externalId: input.externalId,
			externalUrl: input.externalUrl ?? undefined,
			outcome: "link-ok",
		};
	}
	// The unattempted bulk run yields status ownership to a concurrent run.
	if (
		current.lastPmSyncAttemptId !== story.lastPmSyncAttemptId ||
		(current.lastPmSyncStatus === PmSyncStatus.PENDING &&
			current.lastPmSyncAttemptId !== null)
	) {
		return {
			success: false,
			outcome: "attempt-superseded",
			error: `Another PM sync attempt now owns this story, so Fabric did not ${input.verb ?? "push"} it.`,
		};
	}
	throw new Error(
		"Fabric could not record this story's PM link refusal. Sync again.",
	);
}

/**
 * An MCP result's text content, parsed as JSON when it is JSON. The same
 * reading `storySyncWorkflow` applies to its MCP responses.
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

/**
 * The created item's id and URL, read from the fields `storySyncWorkflow`
 * read before this activity existed. The id is the first of those fields,
 * in that order, that holds a non-empty string or a finite number (0
 * included); anything else (an object, which would stringify to
 * "[object Object]") is skipped. Empty strings when absent.
 */
function readCreatedRefs(output: unknown): {
	externalId: string;
	externalUrl: string;
} {
	const parsed = parseMcpResponse(output) as Record<string, unknown>;
	const rawId = [
		parsed.id,
		parsed.card_id,
		parsed.issue_id,
		parsed.task_id,
	].find(
		(candidate) =>
			(typeof candidate === "string" && candidate.trim() !== "") ||
			(typeof candidate === "number" && Number.isFinite(candidate)),
	);
	const externalId = rawId === undefined ? "" : String(rawId);
	// Azure DevOps: URL in _links.web.href
	const links = parsed._links as { web?: { href?: string } } | undefined;
	const externalUrl = String(
		links?.web?.href ||
			parsed.url ||
			parsed.link ||
			parsed.webUrl ||
			parsed.web_url ||
			"",
	);
	return { externalId, externalUrl };
}

/** A failed MCP result's error text, read as the workflow read it. */
function mcpErrorDetail(output: unknown): string {
	const mcpError = parseMcpResponse(output);
	return typeof mcpError === "string"
		? mcpError
		: typeof mcpError === "object" &&
				mcpError !== null &&
				"error" in mcpError
			? String((mcpError as Record<string, unknown>).error)
			: "Unknown error";
}
