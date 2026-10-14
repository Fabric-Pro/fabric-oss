/**
 * Hierarchy Sync Activities
 *
 * Generalized work item sync for stories and bugs (UserStory rows — the only
 * work-item table since the Epic/Feature folder tables were dropped). The
 * `epic`/`feature` members of `WorkItemType` remain for wire compatibility
 * with persisted Temporal histories; syncing them now fails fast with a clear
 * capabilities error.
 */
import {
	db,
	formatBackLinkForProvider,
	getStoryById,
	HTML_BACK_LINK_RE,
	isProjectReadOnly,
	PmSyncStatus,
	upsertPendingChange,
} from "@repo/database";
import { stripFailedMediaPlaceholders } from "@repo/integrations/pm/pull-image-ingest";
import { logger } from "@repo/logs";
import {
	parseWorkItemTypeMapping,
	READ_ONLY_MODE_MESSAGE,
	resolveWorkItemType,
	type StoryKindValue,
} from "@repo/utils";
import { ApplicationFailure, Context } from "@temporalio/activity";
import { executeMcpTool } from "../orchestrator/execution/execute-mcp-tool";
import { assertPmMcpTargetOrigin } from "../pm-source";
import { refreshAtlassianCloudToken } from "./atlassian-cloud-refresh";
import { extractCreatedWorkItemRefs as extractExternalInfo } from "./created-item-refs";
import { fillJiraCreateArgs } from "./fetch-pm-hierarchy";
import { fetchPmTicket } from "./fetch-pm-ticket";
import { mayUseMcpConfigCredential } from "./mcp-credential-gate";
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
	recordCreateOrphan,
	recordCreateUnconfirmed,
} from "./pm-create-orphan";
import { mcpConfigPmInstanceOrigin } from "./pm-link-instance";
import { PM_MISSING_SENTINEL } from "./pm-missing-constants";
import { writePmSyncRunStatus } from "./pm-sync-attempt-fence";
import { computePmHash } from "./pm-sync-hash";
import { truncateTitleForProvider } from "./pm-title-limits";
import {
	detectExternalLinkMismatch,
	legacyLinkOtherToolMessage,
} from "./pm-tool-mismatch";
import { updateStoryFromPm as updateStory } from "./pm-update-story";
import { recordPmSyncLog } from "./record-pm-sync-log";
import {
	discoverPMToolCapabilities,
	extractFizzyTables,
	fetchPMItemsByIds,
	HTML_DESCRIPTION_TOOLS,
	isPmNotFoundError,
	MARKDOWN_DESCRIPTION_TOOLS,
	markdownToSimpleHtml,
	restoreFizzyTables,
} from "./story-sync";
import {
	type AdoAttachmentTarget,
	convertEmbeddedHtmlTablesToMarkdown,
	embedJiraImagesAsAdfMedia,
	extractAdoImages,
	extractAdoTables,
	extractFizzyImages,
	extractStoryMediaKeysFromContent,
	type JiraCloudTarget,
	looksFabricAuthored,
	replaceHtmlImagesWithMarkdown,
	resolveFizzyAttachmentTarget,
	resolveFizzyImageEmbeds,
	resolveIssueSite,
	resolveJiraCloudTarget,
	resolveStoryMediaSignedUrls,
	restoreAdoImages,
	restoreAdoTables,
	restoreFizzyImages,
	restoreFizzyImagesWithEmbeds,
	rewriteAdoInCellImagesToAttachments,
	rewriteFizzyInCellImagesHybrid,
	rewriteStoryMediaSourcesToSignedUrls,
	stripImagesForJira,
	uploadAdoImageAttachments,
} from "./story-sync-media";
import type { PMToolCapabilities } from "./tool-analyzer";

/**
 * Strip markdown formatting for PM tools that don't render it (e.g. Fizzy).
 * Removes bold (**text**), heading markers (### ), and italic (*text*).
 */
function stripMarkdownForPlainText(text: string): string {
	return text
		.replace(/\*{2}([^*]+)\*{2}/g, "$1") // **bold** → bold
		.replace(/^#{1,6}\s+/gm, "") // ### Heading → Heading
		.replace(/(?<!\*)\*(?!\*)([^*]+)\*(?!\*)/g, "$1"); // *italic* → italic
}

/**
 * Apply the story-media + table + markdown transforms to a single field
 * destined for an ADO `System.Description` /
 * `Microsoft.VSTS.Common.AcceptanceCriteria` slot.
 *
 * Resolves every `story-media/...` reference to a 7-day signed URL, then —
 * only when the field looks Fabric-authored — converts the full body to
 * HTML so ADO's HTML renderer displays it correctly:
 *
 *   1. Extract `<table>` blocks (cleaned via `cleanTiptapTableHtml`) and
 *      every `<img>` / `![alt](url)` reference into sentinel tokens.
 *   2. Run `markdownToSimpleHtml` to convert headings / lists / emphasis to
 *      HTML.
 *   3. Restore cleaned tables and inline `<img>` tags.
 *
 * Descriptions that round-tripped from ADO (no Tiptap markers, no
 * story-media keys) pass through verbatim, so subsequent push→pull cycles
 * stay hash-stable.
 *
 * Why this pipeline (and not just `convertEmbeddedHtmlTablesToCleanHtml`):
 * the ADO MCP server's `wit_update_work_item` JSON Patch entries do not
 * accept a `format` field, and the create path now sets `format: "Html"`
 * for symmetry. ADO renders `System.Description` as HTML, so any raw
 * markdown around the table (`## heading`, `- bullet`, `**bold**`) would
 * otherwise show as literal text. Converting the entire body to HTML
 * client-side eliminates that gap.
 *
 * Per-key resolution failures are logged but never thrown; the original
 * key stays in the field and the surrounding text still ships.
 */
async function transformFieldForAdoHtml(
	field: string,
	itemId: string,
	fieldName: "description" | "acceptanceCriteria",
	adoTarget: AdoAttachmentTarget | null,
): Promise<string> {
	if (!field) {
		return field;
	}
	const mediaKeys = extractStoryMediaKeysFromContent(field);
	const signedUrlMap = await resolveStoryMediaSignedUrls(mediaKeys);
	const { content: withResolvedMedia, unresolvedKeys } =
		rewriteStoryMediaSourcesToSignedUrls(field, signedUrlMap);
	if (unresolvedKeys.length > 0) {
		logger.warn("[Hierarchy Sync] Some story-media keys did not resolve", {
			itemId,
			field: fieldName,
			unresolvedCount: unresolvedKeys.length,
			sampleKey: unresolvedKeys[0],
		});
	}
	if (!looksFabricAuthored(withResolvedMedia)) {
		return withResolvedMedia;
	}
	const { withTokens: tableTokens, tables } =
		extractAdoTables(withResolvedMedia);
	const { withTokens: imgTokens, images } = extractAdoImages(tableTokens);

	// Upload every image (standalone + in-cell) to ADO as a work-item
	// attachment so it actually renders. ADO's HTML sanitizer strips
	// external `<img src>` URLs — only `dev.azure.com/.../_apis/wit/
	// attachments/...` references survive. Failures per image leave the
	// original src in place (the surrounding text still ships).
	const uploadedImages = adoTarget
		? await uploadAdoImageAttachments(images, adoTarget)
		: images;
	const tablesWithUploads = adoTarget
		? await Promise.all(
				tables.map((t) =>
					rewriteAdoInCellImagesToAttachments(t, adoTarget),
				),
			)
		: tables;

	return restoreAdoImages(
		restoreAdoTables(markdownToSimpleHtml(imgTokens), tablesWithUploads),
		uploadedImages,
	);
}

/**
 * Build an `AdoAttachmentTarget` (PAT + org slug) from a user's ADO
 * MCPConfig. Returns `null` when the config can't supply both pieces.
 * Mirrors the helper in story-sync.ts; lives here too because
 * hierarchy-sync calls it for the AI-Update flow.
 */
async function resolveAdoAttachmentTargetForHierarchy(
	mcpConfig: {
		encryptedApiKey?: string | null;
		commandArgs?: readonly string[] | string[] | null;
		baseUrl?: string | null;
		mcpServer?: { defaultUrl?: string | null } | null;
	} | null,
): Promise<AdoAttachmentTarget | null> {
	if (!mcpConfig?.encryptedApiKey) {
		return null;
	}
	let pat: string;
	try {
		const { decryptApiKey } = await import("@repo/utils");
		pat = decryptApiKey(mcpConfig.encryptedApiKey);
	} catch (err) {
		logger.warn("[Hierarchy Sync] PAT decrypt failed for ADO attachments", {
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
	if (!pat) {
		return null;
	}
	const commandArg = Array.isArray(mcpConfig.commandArgs)
		? mcpConfig.commandArgs[0]
		: null;
	let org = typeof commandArg === "string" ? commandArg : null;
	if (!org) {
		const url =
			mcpConfig.baseUrl ?? mcpConfig.mcpServer?.defaultUrl ?? null;
		if (url) {
			const match = url.match(/dev\.azure\.com\/([^/?#]+)/i);
			org = match?.[1] ?? null;
		}
	}
	if (!org) {
		return null;
	}
	return { pat, org };
}

export type WorkItemType = "epic" | "feature" | "story" | "bug";

export interface SyncWorkItemInput {
	itemType: WorkItemType;
	itemId: string;
	projectId: string;
	/**
	 * `null` only on the GitLab REST fallback path (no MCPConfig pinned).
	 * Other tools always have a non-null id resolved upstream by
	 * `enqueuePmSync`.
	 */
	mcpConfigId: string | null;
	/**
	 * MCP server id — REQUIRED when `mcpConfigId` is null so the REST source
	 * resolver can identify the integration (e.g. `key:gitlab-official`).
	 * Optional for the MCP path (server id is reachable via the config).
	 */
	mcpServerId?: string;
	containerId: string;
	/** Project name for ADO (which expects name, not GUID) */
	containerName?: string;
	additionalContext?: Record<string, string>;
	userId: string;
	organizationId?: string;
	/** Pre-discovered capabilities */
	capabilities?: PMToolCapabilities;
	/** Original action from the change proposal (helps decide create vs update) */
	action?: "create" | "update";
	/** External PM tool ID from the change proposal (for linking items not yet synced) */
	existingExternalId?: string;
	/** Where this sync was initiated from. Used for telemetry only. */
	triggerSource?: "ai-update" | "manual-edit" | "retry";
	/** When true, skip the PM-side drift check and overwrite the ticket. */
	pushAnyway?: boolean;
	/**
	 * The attempt id the enqueue stamped on the row before starting this run.
	 * When set, the SUCCESS and CONFLICT writes this sync makes apply only
	 * while the row still names this attempt, so a newer enqueue's PENDING is
	 * not overwritten; the link and drift baseline are still written. Unset
	 * (backlog apply, older histories), they skip a row that is PENDING for an
	 * attempt and are otherwise by id (`writePmSyncRunStatus`). The
	 * create-orphan FAILED is by id either way (`recordCreateOrphan`).
	 */
	pmSyncAttemptId?: string;
}

export type SyncWorkItemResult =
	| {
			status: "SUCCESS";
			externalId?: string;
			externalUrl?: string;
			pmHash?: string;
			pushedAt: string;
			/**
			 * Set when nothing was sent because another run linked the row
			 * first (`externalId` / `externalUrl` are that run's link). See
			 * `StorySyncResult.pushSkipped`.
			 */
			pushSkipped?: "already-linked";
	  }
	| {
			status: "CONFLICT";
			externalId: string;
			pmCurrent: { title: string; description: string };
			pmUrl?: string;
	  }
	| {
			// A PM item may exist that the row is not linked to, and the row
			// keeps its create claim, so no later push creates again:
			// - `create_orphan`: the PM tool created the item but the row
			//   could not be linked to it (no readable id in the create
			//   response, or the link write failed);
			// - `create_unconfirmed`: the create was not sent because the
			//   row's claim was held, or it was sent and got no definite
			//   answer.
			// The activity has already tried to persist `lastPmSyncStatus =
			// FAILED` with that class (best effort, by id); this shape
			// propagates the outcome up to the workflow, which then clears
			// any PENDING on the row after `create_orphan`, and only its own
			// attempt's after `create_unconfirmed`. Returned, never thrown, so Temporal
			// does not retry it.
			status: "FAILED";
			externalId?: undefined;
			externalUrl?: undefined;
			pmHash?: undefined;
			error: string;
			pushedAt: string;
			/** Absent on results from before it existed: `create_orphan`. */
			errorClass?: "create_orphan" | "create_unconfirmed";
	  };

/**
 * Map item type to Azure DevOps work item type name. Epic/Feature rows were
 * removed — those item types can no longer reach the push path (the early
 * guard in `syncWorkItemToPM` rejects them).
 */
const ITEM_TYPE_TO_ADO_TYPE: Record<"story" | "bug", string> = {
	story: "User Story",
	bug: "Bug",
};

/**
 * Map a sync work-item type to the `PmSyncLog` `entityType` value.
 *
 * Bugs (`StoryKind.BUG`) are `UserStory` rows and log as `STORY`.
 * There is NO `TASK` value anywhere — `StoryTask` is never independently synced.
 */
export function itemTypeToLogEntityType(
	itemType: WorkItemType,
): "EPIC" | "FEATURE" | "STORY" {
	switch (itemType) {
		case "epic":
			return "EPIC";
		case "feature":
			return "FEATURE";
		case "story":
		case "bug":
			return "STORY";
	}
}

/**
 * Fetch a work item's title and description from the database.
 *
 * Returns `externalUrl` so the caller can detect stale cross-tool links via
 * URL host (e.g. a story bearing a `https://app.fizzy.do/...` URL when the
 * project is now configured for Azure DevOps). For stories/bugs we also
 * return `externalMcpServerId` — when populated, it's a hard signal that the
 * row was synced to a specific MCP server and lets us block (or honor an
 * override) without guessing from the URL.
 */
async function getWorkItemData(
	_itemType: "story" | "bug",
	itemId: string,
	projectId: string,
): Promise<{
	title: string;
	description?: string | null;
	acceptanceCriteria?: string | null;
	identifier: string;
	externalId?: string | null;
	externalUrl?: string | null;
	externalMcpServerId?: string | null;
	draftingStage?: string | null;
	kind?: string | null;
} | null> {
	const story = await getStoryById(itemId, projectId);
	return story
		? {
				title: story.title,
				description: story.description,
				acceptanceCriteria: story.acceptanceCriteria,
				identifier: story.identifier,
				externalId: story.externalId,
				externalUrl: story.externalUrl,
				externalMcpServerId: story.externalMcpServerId,
				draftingStage: story.draftingStage,
				kind: story.kind,
			}
		: null;
}

/**
 * Update the external references on a work item.
 *
 * For stories/bugs we also stamp `externalMcpServerId` when the caller
 * provides it. Without that stamp, every future sync would have to fall back
 * to the URL-host heuristic to detect cross-tool migrations; with it, the
 * faster + more reliable hard check on `externalMcpServerId` kicks in.
 */
async function updateWorkItemExternalRefs(
	itemType: "story" | "bug",
	itemId: string,
	projectId: string,
	externalId: string,
	externalUrl?: string,
	externalMcpServerId?: string | null,
	/**
	 * The create claim this link settles (the link write after a create):
	 * the write applies only while the row holds it, and clears it.
	 */
	pmCreateClaimId?: string,
): Promise<void> {
	const data: {
		externalId: string;
		externalUrl?: string;
	} = { externalId };
	if (externalUrl) {
		data.externalUrl = externalUrl;
	}

	// Persist the new external link with a brief retry. Losing this write after
	// a successful PM create leaves the item with `externalId = null`, so the
	// NEXT sync re-runs the CREATE path and produces a DUPLICATE PM item. The
	// remote item already exists, so a short retry is strictly safer than
	// dropping the link.
	for (let attempt = 1; attempt <= 3; attempt++) {
		try {
			const storyData: typeof data & {
				externalMcpServerId?: string | null;
			} = { ...data };
			if (externalMcpServerId !== undefined) {
				storyData.externalMcpServerId = externalMcpServerId;
			}
			await updateStory(
				itemId,
				projectId,
				storyData,
				pmCreateClaimId !== undefined
					? { settlesPmCreateClaim: pmCreateClaimId }
					: undefined,
			);
			return;
		} catch (persistErr) {
			logger.warn(
				"[Hierarchy Sync] Failed to persist external link after create; retrying",
				{
					itemType,
					itemId,
					externalId,
					attempt,
					error:
						persistErr instanceof Error
							? persistErr.message
							: String(persistErr),
				},
			);
			if (attempt >= 3) {
				throw persistErr;
			}
			await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
		}
	}
}

/**
 * On-demand "PM ticket is missing" handler for the push path.
 *
 * When a push UPDATE fails with a CONFIRMED not-found (the linked PM card was
 * deleted on its server), we don't silently dead-end at FAILED. We surface the
 * SAME `FLAG_MISSING` proposal the hourly `pm-state-poll` produces — but
 * immediately, on the failed push — so the user gets a prompt "unlink this
 * missing ticket" action in the Review Center instead of waiting for up to
 * `STREAK_THRESHOLD` poll cycles (~3h). Accepting the unlink nulls the stale
 * link, and the next sync recreates a fresh card.
 *
 * Safe by construction:
 *  - Only called after `isPmNotFoundError` (permission-ambiguity vetoed), so a
 *    403/401/transient error never triggers an unlink proposal.
 *  - `upsertPendingChange` is idempotent and de-dupes against the poll's rows
 *    (PENDING refresh / DISMISSED short-circuit / active-slot arbitration), so
 *    the two producers can't create duplicate flags.
 *  - Provenance (`expectedExternalMcpServerId`) is the item's CURRENT link
 *    server, so the atomic unlink predicate matches the row exactly. The
 *    mismatch guard already ran upstream, so by here the link is not cross-tool.
 *  - Never throws — a flagging failure must not mask the underlying sync error
 *    the caller is about to surface.
 */
async function proposeFlagMissingOnPushNotFound(args: {
	itemType: WorkItemType;
	itemId: string;
	projectId: string;
	externalId: string;
	externalMcpServerId?: string | null;
	previousState?: string | null;
}): Promise<void> {
	try {
		await upsertPendingChange({
			projectId: args.projectId,
			entityType: itemTypeToLogEntityType(args.itemType),
			entityId: args.itemId,
			externalId: args.externalId,
			previousState: args.previousState ?? "",
			newState: PM_MISSING_SENTINEL,
			proposedAction: "FLAG_MISSING",
			expectedExternalMcpServerId: args.externalMcpServerId ?? null,
		});
		logger.info(
			"[Hierarchy Sync] Push hit a deleted PM ticket — proposed FLAG_MISSING (unlink) for review",
			{
				itemType: args.itemType,
				itemId: args.itemId,
				externalId: args.externalId,
			},
		);
	} catch (flagErr) {
		logger.warn(
			"[Hierarchy Sync] Failed to propose FLAG_MISSING after push not-found (non-fatal)",
			{
				itemType: args.itemType,
				itemId: args.itemId,
				error:
					flagErr instanceof Error
						? flagErr.message
						: String(flagErr),
			},
		);
	}
}

/**
 * Sync any work item (epic, feature, or story) to the PM tool.
 * Creates or updates the item based on whether it already has an externalId.
 *
 * For story/bug items (UserStory rows), this also performs a content-hash
 * conflict check against the last-synced PM state and short-circuits with
 * `{ status: "CONFLICT" }` when PM-side drift is detected (unless
 * `pushAnyway` is true). On success it stamps `lastSyncedPmHash` /
 * `lastSyncedAt` / `lastPmSyncStatus = SUCCESS` on the UserStory.
 *
 * Throws `ApplicationFailure` on push failures so the workflow's catch path
 * can persist `lastPmSyncStatus = FAILED` and surface the error.
 */
export async function syncWorkItemToPM(
	input: SyncWorkItemInput,
): Promise<SyncWorkItemResult> {
	const {
		itemType,
		itemId,
		projectId,
		mcpConfigId,
		mcpServerId,
		containerId,
		containerName,
		additionalContext,
		userId,
		organizationId,
		capabilities: preDiscoveredCapabilities,
		action: proposedAction,
		existingExternalId: proposedExternalId,
		triggerSource = "ai-update",
		pushAnyway = false,
		pmSyncAttemptId,
	} = input;

	logger.info("pm.sync.attempt", {
		itemType,
		itemId,
		mcpConfigId,
		triggerSource,
		pushAnyway,
	});

	const startedAt = Date.now();

	// `user_story` is the only work-item table — the Epic/Feature folder
	// tables were dropped. Persisted Temporal histories / stored proposals may
	// still carry epic/feature-typed sync commands; fail fast with a clear
	// capabilities error instead of attempting a push for a row type that no
	// longer exists. (New applies normalize feature-typed changes to "story"
	// via typeCorrections before PM sync — see applyBacklogChanges.)
	if (itemType === "epic" || itemType === "feature") {
		throw ApplicationFailure.nonRetryable(
			`Epic/Feature containers were removed — ${itemType} items can no longer be synced. Features are roadmap work items (stories) now.`,
			"PmCapabilitiesError",
		);
	}

	// Read-only mode: this activity only pushes to the PM tool —
	// skip before ANY external dispatch, including the ADO attachment uploads
	// that run while building the description (ahead of the MCP chokepoint).
	if (await isProjectReadOnly(projectId)) {
		throw ApplicationFailure.nonRetryable(
			READ_ONLY_MODE_MESSAGE,
			"PmReadOnlyMode",
		);
	}

	// The container id names a project on one GitLab instance; a personal
	// GitLab config on another is refused before anything is sent (the REST
	// path below checks the connection's instance in `resolvePmSource`).
	if (mcpConfigId) {
		await assertPmMcpTargetOrigin({
			mcpConfigId,
			userId,
			organizationId,
			additionalContext,
		});
	}

	// GitLab REST fallback path: `mcpConfigId` is `null` and the source is
	// resolved via `mcpServerId` (the `key:gitlab-official` sentinel).
	//
	// We delegate to `syncStoryToPM(direction:"push")`, which itself
	// short-circuits to `syncGitLabStoryViaRest` for null mcpConfigId. The
	// REST routine handles its own push-time conflict guard (PR #1249) and
	// stamps `lastSyncedPmHash` / `lastPmSyncStatus = SUCCESS` directly. We
	// translate its `StorySyncResult` to the `SyncWorkItemResult` shape the
	// workflow expects.
	if (mcpConfigId === null) {
		if (!mcpServerId) {
			throw ApplicationFailure.nonRetryable(
				"syncWorkItemToPM: mcpServerId is required when mcpConfigId is null",
				"PmCapabilitiesError",
			);
		}
		// Dynamic import keeps the static circular dependency in check —
		// story-sync.ts already imports `discoverPMToolCapabilities` from
		// this file at module load.
		const { syncStoryToPM } = await import("./story-sync");
		const result = await syncStoryToPM({
			storyId: itemId,
			projectId,
			mcpConfigId: null,
			mcpServerId,
			containerId,
			additionalContext,
			direction: "push",
			userId,
			organizationId,
			forceHashOverride: pushAnyway,
			pmSyncAttemptId,
			// A failure is thrown on below; the calling workflow's catch path
			// stamps FAILED and writes its one audit row.
			failureRecordedByCaller: true,
		});
		if (result.success) {
			return {
				status: "SUCCESS",
				externalId: result.externalId,
				externalUrl: result.externalUrl,
				pushedAt: result.syncedAt.toISOString(),
				...(result.pushSkipped
					? { pushSkipped: result.pushSkipped }
					: {}),
			};
		}
		if (result.errorCode === "PM_CREATE_ORPHAN") {
			// The REST routine created the issue but could not save its link,
			// and has already stamped FAILED (`create_orphan`) by id. Returned,
			// not thrown, so nothing retries the create.
			return {
				status: "FAILED",
				pushedAt: result.syncedAt.toISOString(),
				error: result.error ?? "GitLab issue created but not linked",
				errorClass: "create_orphan",
			};
		}
		if (result.errorCode === "PM_CREATE_UNCONFIRMED") {
			// The REST routine did not create (the story's create claim was
			// held) or its create got no definite answer, and it has already
			// stamped FAILED (`create_unconfirmed`) by id. Returned, not
			// thrown, so nothing retries the create.
			return {
				status: "FAILED",
				pushedAt: result.syncedAt.toISOString(),
				error: result.error ?? claimHeldMessage("GitLab"),
				errorClass: CREATE_UNCONFIRMED_ERROR_CLASS,
			};
		}
		if (result.errorCode === "PM_SYNC_CONFLICT") {
			// `syncGitLabStoryViaRest` has already stamped
			// `lastPmSyncStatus = CONFLICT` and recorded a `push`/`CONFLICT`
			// audit row. We don't have the live PM `pmCurrent` here (the
			// guard fetched it but didn't bubble it through StorySyncResult)
			// — the existing review-center flow re-fetches via
			// `pmSyncPreviewConflictsWorkflow` when the user opens the
			// resolve modal, so this is fine.
			return {
				status: "CONFLICT",
				externalId: result.externalId ?? "",
				pmCurrent: { title: "", description: "" },
			};
		}
		// Tool mismatch / not-found / transient — all map to FAILED. The
		// REST routine has already logged a `push`/`FAILURE` row with the
		// detail; the workflow's catch path will stamp the row to FAILED.
		// For a legacy link that is not on the GitLab instance
		// (`PM_TOOL_MISMATCH_LEGACY`) the routine recorded nothing, as asked
		// above: the workflow's catch path is the one record.
		throw ApplicationFailure.nonRetryable(
			result.error ?? "GitLab REST sync failed",
			result.errorCode === "PM_TOOL_MISMATCH"
				? "PmCapabilitiesError"
				: result.errorCode === "PM_TOOL_MISMATCH_LEGACY"
					? "PmToolMismatchError"
					: result.errorCode === "EXTERNAL_ID_NOT_FOUND"
						? "PmNotFoundError"
						: "PmUpdateError",
		);
	}

	// 1. Discover PM tool capabilities
	const capabilities =
		preDiscoveredCapabilities ??
		(await discoverPMToolCapabilities({
			mcpConfigId,
			userId,
			organizationId,
		}));

	// Azure DevOps MCP expects a project name, not a GUID.
	// Other tools (Fizzy, etc.) need the actual container/board ID.
	const isADO = capabilities?.detectedType === "azure-devops";
	const containerValue = isADO ? (containerName ?? containerId) : containerId;

	if (!capabilities?.hasPMCapabilities) {
		throw ApplicationFailure.nonRetryable(
			"PM tool does not have required capabilities",
			"PmCapabilitiesError",
		);
	}

	// 2. Fetch the work item
	const item = await getWorkItemData(itemType, itemId, projectId);
	if (!item) {
		throw ApplicationFailure.nonRetryable(
			`${itemType} ${itemId} not found in project ${projectId}`,
			"PmNotFoundError",
		);
	}

	const originalTitle = item.title;
	// Clamp the outbound title to the PM tool's limit before pushing. Fizzy
	// rejects a 256+ char title with an opaque HTTP 500 (Rails varchar(255)
	// overflow), permanently stranding the item as FAILED. Fabric keeps the
	// full title; the post-push readback baselines lastSyncedPmHash from what
	// the tool actually stored (the truncated title), so truncation never
	// registers as content drift on the next poll.
	const title = truncateTitleForProvider(
		originalTitle,
		capabilities?.detectedType,
	);
	if (title !== originalTitle) {
		logger.warn(
			"[Hierarchy Sync] Title exceeds PM tool limit; truncating for push",
			{
				itemType,
				itemId,
				detectedType: capabilities?.detectedType,
				originalLength: originalTitle.length,
				pushedLength: title.length,
			},
		);
	}

	// Load the user's MCPConfig once up-front and reuse it for (a) the
	// ADO description/AC transforms which need `encryptedApiKey` +
	// `commandArgs` to upload images as ADO attachments, (b) the
	// cross-tool mismatch check further down which needs `mcpServerId`, and
	// (c) the Jira hybrid Cloud attachment upload which needs the
	// `atlassianCloud*` token fields (see `resolveJiraCloudTarget`).
	//
	// The stored credentials are used directly (before any MCP client is
	// built in this activity when capabilities were pre-discovered), so an
	// owner who may no longer use the config gets it treated as gone, as
	// after the offboarding cascade; the push is then refused by the client
	// factory. The read is scoped to the same `userId` and `organizationId`
	// the gate checked, so the credential used is always that owner's: a
	// config that belongs to someone else, or to another organization, reads
	// as gone too, as the client factory's own tenant-scoped lookup does.
	const mayUseCredential = await mayUseMcpConfigCredential({
		mcpConfigId,
		userId,
		organizationId,
	});
	const mcpConfig = !mayUseCredential
		? null
		: await db.mCPConfig.findFirst({
				where: {
					id: mcpConfigId,
					userId,
					organizationId: organizationId ?? null,
				},
				select: {
					id: true,
					baseUrl: true,
					mcpServerId: true,
					encryptedApiKey: true,
					commandArgs: true,
					mcpServer: { select: { defaultUrl: true, key: true } },
					encryptedAtlassianCloudAccessToken: true,
					atlassianCloudTokenExpiresAt: true,
					atlassianCloudCloudId: true,
					atlassianCloudSiteUrl: true,
					atlassianCloudAccessibleResources: true,
				},
			});

	// Resolve the Jira hybrid Cloud target up-front: the description build uses
	// it to decide whether to strip image refs (Cloud target present → re-embed
	// as ADF media nodes post-create) or keep the signed URL (no Cloud target →
	// existing fallback, no regression / no image loss).
	let jiraCloudTarget: JiraCloudTarget | null = null;
	if (capabilities?.detectedType === "jira" && mcpConfig) {
		const { decryptApiKey } = await import("@repo/utils");
		jiraCloudTarget = await resolveJiraCloudTarget(mcpConfig, {
			decrypt: decryptApiKey,
			refreshIfExpired: refreshAtlassianCloudToken,
		});
	}

	// ADO has separate fields for description and acceptance criteria.
	// Flat PM tools only have a single description field, so we combine them.
	// HTML-based tools (Fizzy, Trello, etc.) need HTML; others get plain text.
	let description: string;
	let acceptanceCriteria: string;
	// For Jira: image src URLs stripped from the body at build time, re-embedded
	// post-create as ADF media nodes (a raw <img>/external URL won't render in
	// ADF). Empty for every other tool.
	let jiraImageSrcs: string[] = [];

	// Strip "could not be imported" placeholders BEFORE pushing. A failed-pull
	// placeholder pushed back OVERWRITES the live attachment reference in the
	// PM tool (permanent data loss — an ADO `_apis/wit/attachments/…` reference
	// becomes inert text). Stripping keeps the source intact so a transient
	// failure self-heals on the next pull. Done here, above the ADO/flat split,
	// so both branches are covered; `syncStoryToPM` and
	// `syncGitLabStoryViaRest` do the same on their own push paths.
	const sourceDescription = stripFailedMediaPlaceholders(
		item.description ?? "",
	);
	const sourceAcceptanceCriteria = stripFailedMediaPlaceholders(
		item.acceptanceCriteria ?? "",
	);

	if (isADO) {
		// ADO description + AC stay separate. Apply the media + table
		// transforms to each field independently so Tiptap-shaped content
		// (story-media keys, HTML tables embedded in markdown) renders
		// correctly via ADO's HTML renderer. Pulled-from-ADO HTML preserves
		// byte-for-byte via the `looksFabricAuthored` gate.
		//
		// Build the AdoAttachmentTarget once and reuse it for both fields —
		// every `<img>` in either gets uploaded to ADO attachments so the
		// HTML renderer (which strips external src URLs) can display them.
		const adoTarget =
			await resolveAdoAttachmentTargetForHierarchy(mcpConfig);
		description = await transformFieldForAdoHtml(
			sourceDescription,
			itemId,
			"description",
			adoTarget,
		);
		acceptanceCriteria = await transformFieldForAdoHtml(
			sourceAcceptanceCriteria,
			itemId,
			"acceptanceCriteria",
			adoTarget,
		);
	} else {
		const isHtmlTool = HTML_DESCRIPTION_TOOLS.has(
			capabilities?.detectedType ?? "",
		);
		// Extract the "View in Fabric" back-link wherever it currently lives
		// (acceptanceCriteria first, then description) so we can push it as
		// the LAST block of the joined payload. `placeFabricBackLink` now
		// puts the anchor at the end of acceptanceCriteria when AC is non-
		// empty (visual UI end of the card); legacy stories still have it at
		// the end of description, hence the two-column lookup. Idempotent:
		// when neither column has an anchor (e.g. createStory's back-link
		// append failed, or a non-Fizzy provider never persisted one), this
		// is a no-op.
		const rawDescription = sourceDescription;
		const rawAcceptanceCriteria = sourceAcceptanceCriteria;
		const acBackLinkMatch = rawAcceptanceCriteria.match(HTML_BACK_LINK_RE);
		const descBackLinkMatch = acBackLinkMatch
			? null
			: rawDescription.match(HTML_BACK_LINK_RE);
		const backLinkMatch = acBackLinkMatch ?? descBackLinkMatch;
		const descriptionWithoutLink = descBackLinkMatch
			? rawDescription
					.replace(HTML_BACK_LINK_RE, "")
					.replace(/\n{3,}/g, "\n\n")
					.trim()
			: rawDescription;
		const acWithoutLink = acBackLinkMatch
			? rawAcceptanceCriteria
					.replace(HTML_BACK_LINK_RE, "")
					.replace(/\n{3,}/g, "\n\n")
					.trim()
			: rawAcceptanceCriteria;

		const parts: string[] = [];
		if (descriptionWithoutLink) {
			parts.push(descriptionWithoutLink);
		}
		if (acWithoutLink) {
			parts.push(`**Acceptance Criteria:**\n\n${acWithoutLink}`);
		}
		if (backLinkMatch) {
			parts.push(backLinkMatch[0]);
		}
		const combined = parts.join("\n\n");
		// For Fizzy, formatBackLinkForProvider rewrites the trailing HTML anchor
		// as a markdown link so markdownToSimpleHtml's inline-link regex emits a
		// clean `<a>` instead of escaping `<` / `>` to literal text. For all
		// other providers it returns `combined` byte-for-byte.
		const withProviderBackLink = formatBackLinkForProvider(
			combined,
			capabilities?.detectedType,
		);

		// Resolve every `story-media/...` key in the joined body to a 7-day
		// signed download URL and rewrite the embedded references. Mirrors
		// the story-sync `syncStoryToPM` pipeline so AI-Update-driven pushes
		// produce the same rendered output as user-initiated pushes.
		const mediaKeys =
			extractStoryMediaKeysFromContent(withProviderBackLink);
		const signedUrlMap = await resolveStoryMediaSignedUrls(mediaKeys);
		const { content: withResolvedMedia, unresolvedKeys } =
			rewriteStoryMediaSourcesToSignedUrls(
				withProviderBackLink,
				signedUrlMap,
			);
		if (unresolvedKeys.length > 0) {
			logger.warn(
				"[Hierarchy Sync] Some story-media keys did not resolve",
				{
					itemId,
					detectedType: capabilities?.detectedType,
					unresolvedCount: unresolvedKeys.length,
					sampleKey: unresolvedKeys[0],
				},
			);
		}

		if (isHtmlTool) {
			// Fizzy / Trello / Asana / Monday / ClickUp: convert the markdown
			// body to HTML. Pre-extract `<table>` blocks (Lexxy needs a
			// specific shape) and standalone `<img>` / markdown image
			// references (so they survive `escapeHtml`), then re-emit them as
			// Lexxy-compatible figures via the sentinel-token mechanism
			// shared with `syncStoryToPM`.
			const { withTokens: tableTokens, tables } =
				extractFizzyTables(withResolvedMedia);
			const { withTokens: imgTokens, images } =
				extractFizzyImages(tableTokens);
			if (capabilities?.detectedType === "fizzy") {
				// Fizzy: upload each image natively via the Rails ActionText
				// direct_uploads flow so it RENDERS (`<action-text-attachment>`),
				// instead of embedding a dead external R2 signed URL that Lexxy
				// can't load. Mirrors the inline `syncStoryToPM` path — this is
				// the worker/auto-push parity the previous worker code lacked.
				// `resolveFizzyAttachmentTarget` returns null when the API key /
				// account_slug aren't available, and `resolveFizzyImageEmbeds`
				// then degrades per-image to base64/original.
				const fizzyTarget = await resolveFizzyAttachmentTarget(
					mcpConfig,
					additionalContext as
						| Record<string, unknown>
						| null
						| undefined,
				);
				const imageEmbeds = await resolveFizzyImageEmbeds(
					images,
					fizzyTarget,
				);
				const tablesWithResolvedImages = await Promise.all(
					tables.map((t) =>
						rewriteFizzyInCellImagesHybrid(t, fizzyTarget),
					),
				);
				description = restoreFizzyImagesWithEmbeds(
					restoreFizzyTables(
						markdownToSimpleHtml(imgTokens),
						tablesWithResolvedImages,
					),
					imageEmbeds,
				);
			} else {
				description = restoreFizzyImages(
					restoreFizzyTables(markdownToSimpleHtml(imgTokens), tables),
					images,
				);
			}
		} else if (looksFabricAuthored(withResolvedMedia)) {
			// Jira / GitHub / GitLab / Linear / ClickUp / Trello: convert
			// embedded Tiptap-shaped `<table>` HTML to GFM markdown so the
			// table renders natively.
			const convertedBody =
				convertEmbeddedHtmlTablesToMarkdown(withResolvedMedia);
			if (capabilities?.detectedType === "jira" && jiraCloudTarget) {
				// Jira renders descriptions as ADF, which shows a raw `<img>` or
				// external URL as literal text — never an image. With a Cloud
				// target we can upload + re-embed as ADF media nodes, so strip
				// the refs here (the create ships clean text) and capture the
				// srcs for `embedJiraImagesAsAdfMedia` post-create. Without a
				// Cloud target there's no way to attach, so we keep the existing
				// signed-URL body rather than dropping the image. Linear /
				// GitHub / GitLab render external image URLs natively.
				const stripped = stripImagesForJira(convertedBody);
				description = stripMarkdownForPlainText(stripped.text);
				jiraImageSrcs = stripped.srcs;
			} else if (
				MARKDOWN_DESCRIPTION_TOOLS.has(capabilities?.detectedType ?? "")
			) {
				// GitHub / GitLab / Linear / ClickUp / Trello render Markdown
				// natively — keep GFM tables + emphasis + headings and convert
				// any standalone <img> to a markdown image so it renders (a raw
				// <img> isn't reliable across these). Mirrors the inline
				// `syncStoryToPM` path so auto-push and manual push emit the
				// same body (previously this stripped formatting on the worker
				// path only — a silent divergence).
				description = replaceHtmlImagesWithMarkdown(convertedBody);
			} else {
				description = stripMarkdownForPlainText(convertedBody);
			}
		} else {
			// Round-tripped from a PM tool — no Tiptap markers, no
			// story-media keys (or only the signed URLs were rewritten).
			// Preserve byte-for-byte through the existing markdown stripper.
			description = stripMarkdownForPlainText(withResolvedMedia);
		}
		acceptanceCriteria = "";
	}
	// Use stored externalId, or fall back to the one from the change proposal
	const externalId: string | null | undefined =
		item.externalId ?? proposedExternalId;
	const externalUrl: string | null | undefined = item.externalUrl;

	// `mcpConfig` was loaded earlier (before the description block) so the
	// ADO branch could use its `encryptedApiKey` + `commandArgs` to build
	// the attachment-upload target. Reuse the same row here for cross-tool
	// migration detection — saves a database round-trip and keeps the test
	// mocks consistent across the two code paths.
	const activeServerId = mcpConfig?.mcpServerId ?? null;
	const pmToolBaseUrl =
		mcpConfig?.baseUrl || mcpConfig?.mcpServer?.defaultUrl || null;

	// Detect stale cross-tool links *before* attempting any PM-side operation.
	// Without this, a story bearing a Fizzy externalId (e.g.
	// `03fzkovwwbnhh82sk1hfprp7p`) gets sent to ADO's `wit_update_work_item`
	// and fails with `Expected number, received nan` because the ADO MCP
	// server runs `z.coerce.number()` on the id. See PR description.
	if (externalId) {
		const mismatch = detectExternalLinkMismatch({
			externalId,
			externalUrl,
			externalMcpServerId: item.externalMcpServerId,
			activeServerId,
			currentDetectedType: capabilities.detectedType,
			currentBaseUrl: pmToolBaseUrl,
			// A personal GitLab config names its instance: the row's own
			// link must be on it. Not applied to an id from the change
			// proposal alone, which carries no URL and is no stored link.
			...(item.externalId
				? {
						currentInstanceOrigin:
							mcpConfigPmInstanceOrigin(mcpConfig),
					}
				: {}),
		});

		if (mismatch.resolution === "block") {
			logger.warn("[Hierarchy Sync] PM tool mismatch — blocking sync", {
				itemType,
				itemId,
				identifier: item.identifier,
				externalMcpServerId: item.externalMcpServerId,
				activeServerId,
				reason: mismatch.reason,
			});
			throw ApplicationFailure.nonRetryable(
				"This item is synced to a different PM tool. Switch back to the original tool, or unlink the item to push it to the current tool.",
				"PmToolMismatchError",
			);
		}

		// A legacy link (no server stamp) whose URL points at another tool.
		// It is neither updated nor replaced: clearing it here and creating
		// could erase a link a concurrent sync just wrote, and create a
		// duplicate. The user replaces it with Unlink & re-create.
		if (mismatch.resolution === "legacy-other-tool") {
			logger.warn(
				"[Hierarchy Sync] Legacy external link points at a different PM tool; not syncing",
				{
					itemType,
					itemId,
					identifier: item.identifier,
					previousExternalId: externalId,
					previousExternalUrl: externalUrl,
					reason: mismatch.reason,
				},
			);
			throw ApplicationFailure.nonRetryable(
				legacyLinkOtherToolMessage(
					capabilities.detectedType ?? "the PM tool",
				),
				"PmToolMismatchError",
			);
		}
	}

	// If we resolved externalId from the proposal and the DB item doesn't have it,
	// persist it so future syncs don't need the proposal hint
	if (!item.externalId && externalId) {
		await updateWorkItemExternalRefs(
			itemType,
			itemId,
			projectId,
			externalId,
			undefined,
			activeServerId ?? undefined,
		);
		logger.info("[Hierarchy Sync] Linked item to PM tool from proposal", {
			itemType,
			itemId,
			externalId,
		});
	}

	// 2b. Conflict check (story/bug only — UserStory holds the hash baseline)
	if (externalId && !pushAnyway && capabilities.taskGet) {
		Context.current().heartbeat("fetch-pm");
		const baseline = await getPmSyncBaseline(itemType, itemId, projectId);
		if (baseline) {
			const snapshot = await fetchPmTicket({
				mcpConfigId,
				userId,
				organizationId,
				capabilities,
				externalId,
				containerId,
				containerName,
				additionalContext,
			});
			if (snapshot) {
				const currentHash = computePmHash(
					snapshot.title,
					snapshot.description,
				);
				if (currentHash !== baseline) {
					await stampPmSyncConflict(
						itemType,
						itemId,
						pmSyncAttemptId,
					);
					logger.info("pm.sync.conflict", {
						itemType,
						itemId,
						mcpConfigId,
						triggerSource,
					});
					await recordPmSyncLog({
						direction: "push",
						entityType: itemTypeToLogEntityType(itemType),
						entityId: itemId,
						title,
						pmTool: capabilities.detectedType ?? "unknown",
						status: "CONFLICT",
						errorPayload: {
							reason: "push-time-hash-drift",
							pmCurrentTitle: snapshot.title,
							triggerSource,
						},
						actorUserId: null,
						durationMs: Date.now() - startedAt,
						externalId,
						externalUrl: snapshot.url ?? null,
						organizationId: organizationId ?? null,
						userId: organizationId ? null : userId,
						projectId,
					});
					return {
						status: "CONFLICT",
						externalId,
						pmCurrent: {
							title: snapshot.title,
							description: snapshot.description,
						},
						pmUrl: snapshot.url,
					};
				}
			}
		}
	}

	const workItemType =
		process.env.FEATURE_PM_TYPE_MAPPING === "true" && item.kind
			? resolveWorkItemType(item.kind as StoryKindValue, {
					mapping: parseWorkItemTypeMapping(
						additionalContext as
							| Record<string, unknown>
							| undefined,
					),
					legacyFallback: ITEM_TYPE_TO_ADO_TYPE[itemType],
				})
			: ITEM_TYPE_TO_ADO_TYPE[itemType];

	logger.info("[Hierarchy Sync] Starting sync", {
		itemType,
		itemId,
		identifier: item.identifier,
		hasExternalId: !!externalId,
		proposedAction,
		workItemType,
	});

	Context.current().heartbeat("push-pm");

	// Jira hybrid Cloud INLINE image embed — WORKER/auto-push parity.
	// `syncStoryToPM` (inline manual sync) handled Jira images; this hierarchy
	// path (auto-push / AI-Update) never did, so worker-driven Jira pushes
	// produced cards with NO screenshot. We upload each image as a REST
	// attachment AND embed it inline in the description via an ADF media node
	// (a raw <img>/external URL is shown as literal text by ADF, so the body's
	// image refs were stripped at build time into `jiraImageSrcs`). The Cloud
	// target was resolved up-front (before the description build). Embed after
	// the create/update succeeds. Never throws — a failed/absent embed must not
	// fail the push.
	const embedJiraCloudImages = async (
		issueKey: string | null | undefined,
		issueUrl: string | null | undefined,
	): Promise<void> => {
		if (!jiraCloudTarget || !issueKey || jiraImageSrcs.length === 0) {
			return;
		}
		try {
			const issueSite = resolveIssueSite(jiraCloudTarget, issueUrl);
			if (!issueSite) {
				logger.warn(
					"[Hierarchy Sync] Jira hybrid Cloud — issue site not in granted resources; skipping image embed",
					{ itemId, externalId: issueKey, issueUrl },
				);
				return;
			}
			const result = await embedJiraImagesAsAdfMedia(
				jiraImageSrcs,
				jiraCloudTarget,
				issueSite,
				issueKey,
			);
			const log =
				result.failed > 0
					? logger.warn.bind(logger)
					: logger.info.bind(logger);
			log("[Hierarchy Sync] Jira hybrid Cloud — inline image embed", {
				itemId,
				externalId: issueKey,
				cloudId: issueSite.cloudId,
				uploaded: result.uploaded,
				failed: result.failed,
				errors: result.errors,
			});
		} catch (err) {
			logger.warn("[Hierarchy Sync] Jira inline image embed threw", {
				itemId,
				externalId: issueKey,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	};

	// 3. Update existing or create new
	// Use update path if we have an externalId (from DB or proposal)
	if (externalId && capabilities.taskUpdate) {
		// Update existing
		const updateTool = capabilities.taskUpdate;
		let updateArgs: Record<string, unknown>;

		if (updateTool.updatesBased) {
			// Azure DevOps JSON Patch style
			const updates: Array<{
				op: string;
				path: string;
				value: string;
			}> = [
				{ op: "add", path: "/fields/System.Title", value: title },
				{
					op: "add",
					path: "/fields/System.Description",
					value: description,
				},
			];
			// ADO Bugs render their body in Repro Steps; mirror the patch there
			// too so an edited bug's body updates on the form (and stays in sync
			// with System.Description, which the pull reads).
			if (itemType === "bug") {
				updates.push({
					op: "add",
					path: "/fields/Microsoft.VSTS.TCM.ReproSteps",
					value: description,
				});
			}
			if (
				(itemType === "story" || itemType === "bug") &&
				acceptanceCriteria
			) {
				updates.push({
					op: "add",
					path: "/fields/Microsoft.VSTS.Common.AcceptanceCriteria",
					value: acceptanceCriteria,
				});
			}
			updateArgs = {
				[updateTool.idParam]: externalId,
				[updateTool.updatesBased.updatesParam]: updates,
			};
		} else if (updateTool.fieldsObjectBased) {
			// Atlassian Rovo Jira style: title/description live INSIDE a
			// required `fields` object param. `editJiraIssue` has only id
			// + fields as top-level params (plus optional cloudId etc.).
			// Without this branch we fell to the generic else below which
			// only sets idParam — the server then rejected with
			// `path: ["fields"], message: "Required"`. This branch mirrors
			// the equivalent path in story-sync.ts:2056. See #1270 for the
			// diagnostic that proved hierarchy-sync was missing it.
			updateArgs = {
				[updateTool.idParam]: externalId,
				[updateTool.fieldsObjectBased.fieldsParam]: {
					[updateTool.fieldsObjectBased.titleField]: title,
					[updateTool.fieldsObjectBased.descriptionField]:
						description,
				},
			};
		} else {
			updateArgs = { [updateTool.idParam]: externalId };
			if (updateTool.titleParam) {
				updateArgs[updateTool.titleParam] = title;
			}
			if (updateTool.descriptionParam) {
				updateArgs[updateTool.descriptionParam] = description;
			}
		}

		if (additionalContext) {
			for (const [key, value] of Object.entries(additionalContext)) {
				if (
					key === "areaPath" ||
					key === "iterationPath" ||
					key === "workItemType"
				) {
					continue;
				}
				if (
					typeof value === "string" &&
					updateTool.allParams.some(
						(p: { name: string }) => p.name === key,
					)
				) {
					updateArgs[key] = value;
				}
			}
		}

		const updateResult = await executeMcpTool({
			pmTarget: { additionalContext },
			toolName: updateTool.toolName,
			args: updateArgs,
			userId,
			organizationId,
			// Read-only mode write-gate keys off projectId
			projectId,
			mcpConfigId,
		});

		if (!updateResult.success) {
			const errorOutput = updateResult.output as
				| { content?: Array<{ type?: string; text?: string }> }
				| { error?: string }
				| null;
			let errorDetail = `Failed to update ${itemType} in PM tool`;
			if (errorOutput && typeof errorOutput === "object") {
				if ("error" in errorOutput && errorOutput.error) {
					errorDetail = String(errorOutput.error);
				} else if (
					"content" in errorOutput &&
					Array.isArray(errorOutput.content)
				) {
					const errText = errorOutput.content.find(
						(c) => c.type === "text",
					)?.text;
					if (errText) {
						errorDetail = errText;
					}
				}
			}
			// A failed UPDATE whose error is an unambiguous "not found" means the
			// linked PM card was deleted on its server (the user-reported 404).
			// Classify it as PmNotFoundError (parity with the GitLab-REST path) and
			// immediately propose a FLAG_MISSING unlink, so the user can heal the
			// stale link from the Review Center instead of dead-ending at a generic
			// FAILED that re-fails on every push until the hourly poll notices.
			// `isPmNotFoundError` vetoes permission/transient errors, so a
			// 401/403/timeout still throws the generic PmUpdateError below.
			if (externalId && isPmNotFoundError(errorDetail)) {
				await proposeFlagMissingOnPushNotFound({
					itemType,
					itemId,
					projectId,
					externalId,
					externalMcpServerId: item.externalMcpServerId,
					previousState: item.draftingStage,
				});
				throw ApplicationFailure.nonRetryable(
					errorDetail,
					"PmNotFoundError",
				);
			}
			throw ApplicationFailure.nonRetryable(errorDetail, "PmUpdateError");
		}

		logger.info("[Hierarchy Sync] Updated existing work item", {
			itemType,
			externalId,
			tool: updateTool.toolName,
		});

		await embedJiraCloudImages(externalId, externalUrl);

		// HTML tools (Fizzy/Asana/Monday) re-render pushed content server-side, so a
		// baseline hashed from what we pushed never matches what the next poll reads
		// back — flagging every healthy item as content drift. Read back what the
		// tool actually stored and baseline from THAT. Best-effort: null on any
		// failure → fall back to hashing the pushed content (today's behavior).
		const pmCanonicalHash = HTML_DESCRIPTION_TOOLS.has(
			capabilities.detectedType ?? "",
		)
			? await readbackPmCanonicalHash({
					mcpConfigId,
					containerId,
					containerName,
					externalId,
					userId,
					organizationId,
				})
			: null;

		await stampPmSyncSuccess({
			itemType,
			itemId,
			title,
			description,
			pmCanonicalHash,
			pmSyncAttemptId,
		});

		logger.info("pm.sync.success", {
			itemType,
			itemId,
			mcpConfigId,
			triggerSource,
			durationMs: Date.now() - startedAt,
		});

		await recordPmSyncLog({
			direction: "push",
			entityType: itemTypeToLogEntityType(itemType),
			entityId: itemId,
			title,
			pmTool: capabilities.detectedType ?? "unknown",
			status: "SUCCESS",
			actorUserId: null,
			durationMs: Date.now() - startedAt,
			externalId: externalId ?? null,
			externalUrl: externalUrl ?? null,
			organizationId: organizationId ?? null,
			userId: organizationId ? null : userId,
			projectId,
		});

		return {
			status: "SUCCESS",
			externalId,
			pmHash: pmCanonicalHash ?? computePmHash(title, description),
			pushedAt: new Date().toISOString(),
		};
	}

	if (capabilities.taskCreation) {
		const createTool = capabilities.taskCreation;
		let createArgs: Record<string, unknown>;

		if (createTool.fieldsBased) {
			// ADO MCP `wit_create_work_item` accepts `format: "Html" |
			// "Markdown"` per field; the update tool does not. We send Html
			// here to keep the create and update paths symmetric — the
			// `description` / `acceptanceCriteria` strings above are clean
			// HTML when Fabric-authored (see `transformFieldForAdoHtml`) or
			// already-HTML when round-tripped from ADO.
			const fieldsArray: Array<{
				name: string;
				value: string;
				format?: string;
			}> = [
				{
					name: createTool.fieldsBased.titleKey,
					value: title,
				},
				{
					name: createTool.fieldsBased.descriptionKey,
					value: description || "",
					format: "Html",
				},
			];
			// ADO Bug body renders in Repro Steps, not System.Description —
			// mirror it so the pushed bug isn't empty (System.Description is
			// kept so the read/pull paths keep working).
			if (itemType === "bug") {
				fieldsArray.push({
					name: "Microsoft.VSTS.TCM.ReproSteps",
					value: description || "",
					format: "Html",
				});
			}
			if (
				(itemType === "story" || itemType === "bug") &&
				acceptanceCriteria
			) {
				fieldsArray.push({
					name: "Microsoft.VSTS.Common.AcceptanceCriteria",
					value: acceptanceCriteria,
					format: "Html",
				});
			}
			if (
				additionalContext?.areaPath &&
				!additionalContext.areaPath.trim().startsWith("http")
			) {
				fieldsArray.push({
					name: "System.AreaPath",
					value: additionalContext.areaPath
						.trim()
						.replace(/\//g, "\\"),
				});
			}
			if (
				additionalContext?.iterationPath &&
				!additionalContext.iterationPath.trim().startsWith("http")
			) {
				fieldsArray.push({
					name: "System.IterationPath",
					value: additionalContext.iterationPath
						.trim()
						.replace(/\//g, "\\"),
				});
			}
			createArgs = {
				[createTool.containerParam]: containerValue,
				[createTool.fieldsBased.workItemTypeParam]: workItemType,
				[createTool.fieldsBased.fieldsParam]: fieldsArray,
			};
		} else {
			createArgs = {
				[createTool.containerParam]: containerValue,
				[createTool.titleParam]: title,
			};
			if (createTool.descriptionParam) {
				createArgs[createTool.descriptionParam] = description;
			}
		}

		if (additionalContext) {
			const workItemTypeParam = createTool.fieldsBased?.workItemTypeParam;
			for (const [key, value] of Object.entries(additionalContext)) {
				if (
					key === "areaPath" ||
					key === "iterationPath" ||
					key === "workItemType" ||
					(workItemTypeParam && key === workItemTypeParam)
				) {
					continue;
				}
				if (
					typeof value === "string" &&
					createTool.allParams.some(
						(p: { name: string }) => p.name === key,
					)
				) {
					createArgs[key] = value;
				}
			}
		}

		// Rovo's createJiraIssue needs a cloudId and an issue type.
		if (capabilities.detectedType === "jira") {
			await fillJiraCreateArgs({
				createArgs,
				createParams: createTool.allParams,
				projectKey: String(containerValue),
				mcpConfigId,
				userId,
				organizationId,
				availableTools: capabilities.availableTools,
			});
		}

		logger.info("[Hierarchy Sync] Creating work item", {
			itemType,
			toolName: createTool.toolName,
			project: createArgs[createTool.containerParam],
			workItemType,
		});

		const toolLabel = capabilities.detectedType ?? "the PM tool";
		// Another run linked the row since this one read it: nothing to
		// create, and no unconfirmed create to report. A SUCCESS that writes
		// nothing, so no state, audit row or PENDING of anyone's is touched;
		// the workflow clears only this run's own PENDING after it.
		// `pushSkipped` tells the caller nothing was sent.
		const alreadyLinked = (link: {
			externalId: string;
			externalUrl: string | null;
		}): SyncWorkItemResult => {
			logger.info("pm.sync.create_skipped", {
				itemType,
				itemId,
				mcpConfigId,
				reason: "linked",
			});
			return {
				status: "SUCCESS",
				externalId: link.externalId,
				externalUrl: link.externalUrl ?? undefined,
				pushedAt: new Date().toISOString(),
				pushSkipped: "already-linked",
			};
		};
		const unconfirmed = async (
			errorMessage: string,
		): Promise<SyncWorkItemResult> => {
			// Best effort, like `recordCreateOrphan`: returned, not thrown, so
			// Temporal does not retry it. Written only while the row is
			// unlinked and its claim is held; a row linked since is benign.
			const recording = await recordCreateUnconfirmed({
				itemId,
				itemType,
				errorMessage,
				triggerSource: triggerSource ?? "manual-edit",
				pmTool: capabilities.detectedType ?? undefined,
			});
			if (recording.outcome === "linked") {
				return alreadyLinked(recording);
			}
			return {
				status: "FAILED" as const,
				externalId: undefined,
				externalUrl: undefined,
				pmHash: undefined,
				pushedAt: new Date().toISOString(),
				error: errorMessage,
				errorClass: CREATE_UNCONFIRMED_ERROR_CLASS,
			};
		};

		// Started before the claim is asked for, so the claim's
		// database-clock stamp is read after it: no create is sent past it
		// (`PM_CREATE_SEND_TIMEOUT_MS`), however long taking the claim takes.
		const sendDeadline = startPmCreateSendDeadline();
		// Immediately before the create request: no create is sent unless
		// this run took the row's create claim. Held by anyone (another run,
		// or an earlier attempt of this one whose create may have landed),
		// nothing is sent and `create_unconfirmed` is recorded. Linked since
		// this run read the row, nothing is sent or recorded.
		const claim = await acquirePmCreateClaim({ storyId: itemId });
		if ("miss" in claim) {
			if (claim.miss === "linked") {
				return alreadyLinked(claim);
			}
			if (claim.miss === "missing") {
				throw ApplicationFailure.nonRetryable(
					`${itemType} ${itemId} not found in project ${projectId}`,
					"PmNotFoundError",
				);
			}
			logger.warn("pm.sync.create_unconfirmed", {
				itemType,
				itemId,
				mcpConfigId,
				reason: "claim-held",
			});
			return unconfirmed(claimHeldMessage(toolLabel));
		}
		const pmCreateClaimId = claim.claimId;

		let createResult: Awaited<ReturnType<typeof executeMcpTool>>;
		try {
			createResult = await executeMcpTool({
				pmTarget: { additionalContext },
				toolName: createTool.toolName,
				args: createArgs,
				userId,
				organizationId,
				// Read-only mode write-gate keys off projectId
				projectId,
				mcpConfigId,
				// A closed connection after the send must not resend it.
				sendAtMostOnce: true,
				// Not sent past the claim's send deadline; Fabric stops waiting
				// for a request in flight there (see `PM_CREATE_SEND_TIMEOUT_MS`).
				timeoutMs: PM_CREATE_SEND_TIMEOUT_MS,
				dispatchDeadline: sendDeadline,
			});
		} catch (createError) {
			// Refused before anything was sent: the instance check.
			if (
				createError instanceof ApplicationFailure &&
				createError.type === "GitLabPmOriginMismatch"
			) {
				await releasePmCreateClaim({
					storyId: itemId,
					claimId: pmCreateClaimId,
				});
				throw createError;
			}
			// Anything else may have followed the send: keep the claim.
			logger.warn("pm.sync.create_unconfirmed", {
				itemType,
				itemId,
				mcpConfigId,
				reason: "create-threw",
				error: describeOrphanCause(createError),
			});
			return unconfirmed(
				createIndeterminateMessage(
					toolLabel,
					describeOrphanCause(createError),
				),
			);
		}

		if (createResult.success) {
			// From here the ticket exists, so nothing below may throw a
			// retryable error: a Temporal retry with the row still unlinked
			// would take this CREATE branch again and make a second ticket.
			// The extraction reads a parsed response and is not expected to
			// throw; if it does, the row is treated as unlinked (orphan).
			let extracted: { externalId?: string; externalUrl?: string };
			try {
				extracted = extractExternalInfo(createResult.output, {
					baseUrl: pmToolBaseUrl,
					idParamHint: capabilities.taskUpdate?.idParam,
				});
			} catch (extractError) {
				logger.warn("pm.sync.create_orphan.extract_threw", {
					itemType,
					itemId,
					error: describeOrphanCause(extractError),
				});
				extracted = {};
			}

			// ATOMICITY GUARD: a successful MCP create that returns no
			// extractable externalId leaves the card created in the PM tool
			// but unlinked in Fabric. Stamping SUCCESS in that state silently
			// breaks the roadmap classifier — `roadmap-filters.ts`'s rule is
			// `synced ⟺ externalId && lastPmSyncStatus !== FAILED`, so a row
			// with `lastPmSyncStatus="SUCCESS"` AND `externalId=null` renders
			// "Unsynced" forever and the next auto-sync re-enters this CREATE
			// branch → duplicate PM card. Stamp FAILED with a specific
			// errorClass so the row enters the reconciliation state instead.
			if (!extracted.externalId) {
				// The claim stays held: it is what stops the next push from
				// creating a second card.
				const errorMessage = `${toolLabel} reported the card created, but Fabric could not read its id from the response, so this item is not linked to it. A ${toolLabel} card may already exist for it. Check ${toolLabel}; if there is none, use Unlink & re-create.`;
				logger.warn("pm.sync.create_orphan", {
					itemType,
					itemId,
					mcpConfigId,
					toolName: createTool.toolName,
					detectedType: capabilities.detectedType,
					outputSampleKeys: Object.keys(
						(createResult.output as Record<string, unknown>) ?? {},
					).slice(0, 10),
				});
				// By id, not scoped to `pmSyncAttemptId`, and best effort:
				// see `recordCreateOrphan`.
				await recordCreateOrphan({
					itemId,
					itemType,
					errorMessage,
					triggerSource: triggerSource ?? "manual-edit",
					pmTool: capabilities.detectedType ?? undefined,
				});
				return {
					status: "FAILED" as const,
					externalId: undefined,
					externalUrl: undefined,
					pmHash: undefined,
					pushedAt: new Date().toISOString(),
					error: errorMessage,
					errorClass: "create_orphan" as const,
				};
			}

			// Stamp `externalMcpServerId` so future syncs can use the hard
			// check (faster + more reliable than re-inspecting URL host).
			try {
				// Clears the create claim in the same write, scoped to it.
				await updateWorkItemExternalRefs(
					itemType,
					itemId,
					projectId,
					extracted.externalId,
					extracted.externalUrl,
					activeServerId ?? undefined,
					pmCreateClaimId,
				);
			} catch (linkError) {
				// The ticket exists but the row still has no link. A throw
				// here would be retried by Temporal, and every retry takes
				// this CREATE branch again: one more ticket each time. Treat
				// it as an orphaned create instead: FAILED by id with the
				// ticket's id in the message, no retry, and the claim kept
				// so no later push creates a second card.
				const errorMessage = `Card ${extracted.externalId} was created in ${toolLabel} but Fabric could not save its link (${describeOrphanCause(
					linkError,
				)}), so this item is not linked to it. Check ${toolLabel}: use Unlink & re-create only if card ${extracted.externalId} was deleted or a second card is wanted.`;
				logger.warn("pm.sync.create_orphan", {
					itemType,
					itemId,
					mcpConfigId,
					externalId: extracted.externalId,
					reason: "link-write-failed",
				});
				await recordCreateOrphan({
					itemId,
					itemType,
					errorMessage,
					triggerSource: triggerSource ?? "manual-edit",
					pmTool: capabilities.detectedType ?? undefined,
				});
				return {
					status: "FAILED" as const,
					externalId: undefined,
					externalUrl: undefined,
					pmHash: undefined,
					pushedAt: new Date().toISOString(),
					error: errorMessage,
					errorClass: "create_orphan" as const,
				};
			}

			logger.info("[Hierarchy Sync] Created new work item", {
				itemType,
				externalId: extracted.externalId,
				externalUrl: extracted.externalUrl,
				tool: createTool.toolName,
			});

			await embedJiraCloudImages(
				extracted.externalId,
				extracted.externalUrl,
			);

			// Same readback as the update path — baseline from what the tool stored
			// (HTML tools re-render on create too). Best-effort with fallback.
			const pmCanonicalHash = HTML_DESCRIPTION_TOOLS.has(
				capabilities.detectedType ?? "",
			)
				? await readbackPmCanonicalHash({
						mcpConfigId,
						containerId,
						containerName,
						externalId: extracted.externalId,
						userId,
						organizationId,
					})
				: null;

			await stampPmSyncSuccess({
				itemType,
				itemId,
				title,
				description,
				pmCanonicalHash,
				pmSyncAttemptId,
			});

			logger.info("pm.sync.success", {
				itemType,
				itemId,
				mcpConfigId,
				triggerSource,
				durationMs: Date.now() - startedAt,
			});

			await recordPmSyncLog({
				direction: "push",
				entityType: itemTypeToLogEntityType(itemType),
				entityId: itemId,
				title,
				pmTool: capabilities.detectedType ?? "unknown",
				status: "SUCCESS",
				actorUserId: null,
				durationMs: Date.now() - startedAt,
				externalId: extracted.externalId,
				externalUrl: extracted.externalUrl ?? null,
				organizationId: organizationId ?? null,
				userId: organizationId ? null : userId,
				projectId,
			});

			return {
				status: "SUCCESS",
				externalId: extracted.externalId,
				externalUrl: extracted.externalUrl,
				pmHash: pmCanonicalHash ?? computePmHash(title, description),
				pushedAt: new Date().toISOString(),
			};
		}

		if (isCreateSendDeadlinePassed(createResult)) {
			// Not sent: its send deadline passed before the request went
			// out, so nothing exists. Release the claim so the next push can
			// create; the workflow records the FAILED, which offers a retry.
			logger.warn("pm.sync.create_not_sent", {
				itemType,
				itemId,
				mcpConfigId,
				reason: "send-deadline-passed",
			});
			await releasePmCreateClaim({
				storyId: itemId,
				claimId: pmCreateClaimId,
			});
			throw ApplicationFailure.nonRetryable(
				createDeadlinePassedMessage(toolLabel),
				"PmCreateNotSent",
			);
		}

		const errorOutput = createResult.output as
			| { content?: Array<{ type?: string; text?: string }> }
			| { error?: string }
			| null;
		let errorDetail = `Failed to create ${itemType} in PM tool`;
		if (errorOutput && typeof errorOutput === "object") {
			if ("error" in errorOutput && errorOutput.error) {
				errorDetail = String(errorOutput.error);
			} else if (
				"content" in errorOutput &&
				Array.isArray(errorOutput.content)
			) {
				// Join ALL text content (not just the first) and fall back to
				// the raw output — the ADO MCP wrapper collapses real Azure
				// DevOps errors (e.g. TF401347 invalid AreaPath) down to a
				// generic "Work item was not created", so the first item alone
				// can hide the cause. Mirrors the story-sync create path.
				const errText = errorOutput.content
					.filter((c) => c.type === "text" && c.text)
					.map((c) => c.text)
					.join("\n")
					.trim();
				errorDetail = errText || JSON.stringify(errorOutput);
			}
		}
		logger.error("[Hierarchy Sync] Create failed", {
			itemType,
			itemId,
			tool: createTool.toolName,
			errorDetail,
			failureKind: createResult.failureKind,
			// Full raw output — the trimmed `errorDetail` can hide the real
			// reason when the MCP wrapper swallows it.
			rawOutput: createResult.output,
		});
		if (!isDefiniteMcpCreateRejection(createResult)) {
			// Sent, and not proven to have created nothing (a timeout, a
			// transport failure, or any error result from the server): the
			// card may exist. Keep the claim; returned, not thrown, so
			// nothing retries the create.
			return unconfirmed(
				createIndeterminateMessage(toolLabel, errorDetail),
			);
		}
		// Refused before it was sent (tool not found, Read-only mode,
		// authority, OAuth, no connection), so nothing exists: release the
		// claim so the next push can create.
		await releasePmCreateClaim({
			storyId: itemId,
			claimId: pmCreateClaimId,
		});
		throw ApplicationFailure.nonRetryable(errorDetail, "PmCreateError");
	}

	throw ApplicationFailure.nonRetryable(
		"PM tool does not support task creation",
		"PmCapabilitiesError",
	);
}

export async function getPmSyncBaseline(
	itemType: WorkItemType | "testCase",
	itemId: string,
	projectId: string,
): Promise<string | null> {
	// Test cases hold their own drift baseline on `test_case`.
	if (itemType === "testCase") {
		const testCase = await db.testCase.findFirst({
			where: { id: itemId, projectId },
			select: { lastSyncedPmHash: true },
		});
		return testCase?.lastSyncedPmHash ?? null;
	}
	// Legacy epic/feature item types resolve to "no baseline" — the folder
	// tables were dropped.
	if (itemType !== "story" && itemType !== "bug") {
		return null;
	}
	const row = await getStoryById(itemId, projectId);
	return row?.lastSyncedPmHash ?? null;
}

/**
 * Stamp CONFLICT on a work item or test case. With `pmSyncAttemptId` (the
 * run's attempt id) the stamp applies only while the row still names that
 * attempt; without it the stamp is by id unless the row is PENDING for an
 * attempt (`writePmSyncRunStatus`). Test-case drift stamps the same CONFLICT
 * badge stories use, so the case surfaces for Retry/Dismiss in the Review
 * Center. Resolves `false` when the stamp was skipped, and for the legacy
 * epic/feature types (folder tables dropped).
 */
export async function stampPmSyncConflict(
	itemType: WorkItemType | "testCase",
	itemId: string,
	pmSyncAttemptId?: string,
): Promise<boolean> {
	if (itemType !== "story" && itemType !== "bug" && itemType !== "testCase") {
		return false;
	}
	const wrote = await writePmSyncRunStatus({
		itemType,
		itemId,
		attemptId: pmSyncAttemptId,
		data: {
			lastPmSyncStatus: PmSyncStatus.CONFLICT,
			lastPmSyncAttemptAt: new Date(),
			lastPmSyncError: null,
		},
	});
	if (!wrote) {
		logger.info("pm.sync.conflict.superseded", {
			itemType,
			itemId,
			attemptId: pmSyncAttemptId,
		});
	}
	return wrote;
}

/**
 * Read back the content the PM tool ACTUALLY stored after a push, and hash it
 * the same way the poll does — this is the canonical sync baseline.
 *
 * Why: HTML-description tools (Fizzy / Asana / Monday) re-render content
 * server-side on save (e.g. Rails ActionText turns uploaded images into
 * `<action-text-attachment>` and reshapes tables), so what the tool returns on
 * the next poll is not byte-identical to what we pushed. A baseline hashed from
 * the pushed content therefore never matches the polled content, and every
 * cleanly-synced item false-flags as "content drift". Baselining from this
 * readback makes the baseline equal what the next poll WILL read, so only a
 * GENUINE external edit registers as drift.
 *
 * Reuses the poll's exact fetch (`fetchPMItemsByIds`); title/description pass
 * through `normalizePolledState` unchanged, so `computePmHash` here matches the
 * poll's drift hash byte-for-byte (locked by a unit test). Best-effort: any
 * failure (fetch error, not-found, empty) returns `null` and the caller falls
 * back to hashing the pushed content — never worse than before. Read-only: it
 * issues no write to the PM ticket.
 */
export async function readbackPmCanonicalHash(input: {
	mcpConfigId: string;
	containerId: string;
	containerName?: string;
	externalId: string;
	userId: string;
	organizationId?: string;
}): Promise<string | null> {
	try {
		const result = await fetchPMItemsByIds({
			mcpConfigId: input.mcpConfigId,
			containerId: input.containerId,
			externalIds: [input.externalId],
			additionalContext: input.containerName
				? { project: input.containerName }
				: undefined,
			userId: input.userId,
			organizationId: input.organizationId,
		});
		if (
			result.failedIds?.includes(input.externalId) ||
			result.notFoundIds?.includes(input.externalId)
		) {
			return null;
		}
		const item =
			result.items.find((i) => i.id === input.externalId) ??
			result.items[0];
		if (!item) {
			return null;
		}
		return computePmHash(item.title, item.description);
	} catch (error) {
		logger.warn(
			"[Hierarchy Sync] baseline readback failed; using pushed-content hash",
			{
				externalId: input.externalId,
				error: error instanceof Error ? error.message : String(error),
			},
		);
		return null;
	}
}

export async function stampPmSyncSuccess(input: {
	itemType: WorkItemType;
	itemId: string;
	title: string;
	description?: string | null;
	/**
	 * Baseline hash from a post-push readback of the PM tool's STORED content
	 * (see `readbackPmCanonicalHash`). When set, it is used as `lastSyncedPmHash`
	 * instead of hashing the pushed content — this is what stops re-rendering
	 * HTML tools from false-flagging healthy items as drift. `null`/omitted
	 * (readback failed, or a verbatim tool) → hash the pushed content as before.
	 */
	pmCanonicalHash?: string | null;
	/**
	 * The run's attempt id. The baseline (`lastSyncedPmHash`,
	 * `lastSyncedAt`) is always written by id, because the push happened.
	 * When set, the SUCCESS status lands only while the row still names this
	 * attempt; a newer enqueue's PENDING is left alone (the stuck-sync
	 * watchdog retries it). Unset, it lands unless the row is PENDING for an
	 * attempt, which that attempt's run settles.
	 */
	pmSyncAttemptId?: string;
}): Promise<void> {
	// Legacy epic/feature item types are no-ops — the folder tables were dropped.
	if (input.itemType !== "story" && input.itemType !== "bug") {
		return;
	}
	const pmHash =
		input.pmCanonicalHash ?? computePmHash(input.title, input.description);
	const now = new Date();
	const baseline = { lastSyncedPmHash: pmHash, lastSyncedAt: now };
	const status = {
		lastPmSyncStatus: PmSyncStatus.SUCCESS,
		lastPmSyncError: null,
		lastPmSyncAttemptAt: now,
	};
	try {
		// Baseline first, by id: the PM ticket now holds this push, so the
		// next sync, whichever run owns the status, must diff against it.
		// Then the status (`writePmSyncRunStatus`). A skipped status write is
		// not a failure.
		await db.userStory.update({
			where: { id: input.itemId },
			data: baseline,
		});
		const wrote = await writePmSyncRunStatus({
			itemType: input.itemType,
			itemId: input.itemId,
			attemptId: input.pmSyncAttemptId,
			data: status,
		});
		if (!wrote) {
			logger.info("pm.sync.success.superseded", {
				itemType: input.itemType,
				itemId: input.itemId,
				attemptId: input.pmSyncAttemptId,
			});
		}
	} catch (error) {
		// PM push already succeeded; if we cannot stamp the SUCCESS hash the
		// baseline is stale and the next sync would falsely report CONFLICT.
		// Surface as a non-retryable failure so the workflow records FAILED
		// and the user can recover via retry.
		const message = error instanceof Error ? error.message : String(error);
		logger.warn("[Hierarchy Sync] stampPmSyncSuccess write failed", {
			itemType: input.itemType,
			itemId: input.itemId,
			error: message,
		});
		throw ApplicationFailure.nonRetryable(
			`Failed to stamp PM sync success: ${message}`,
			"PmStampError",
		);
	}
}
