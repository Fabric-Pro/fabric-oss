/**
 * GitLab REST-fallback per-story sync.
 *
 * `syncStoryToPM` (in `./story-sync`) drives the MCP-heavy pipeline for
 * pinned MCP configs. When a GitLab project has no `mcpConfigId` (the REST
 * fallback path), it delegates here. This routine performs the same logical
 * push / pull / self-heal contract using the provider-agnostic
 * `callPmToolWithFallback` dispatcher and the shared label↔status helpers,
 * so a feature round-trips cleanly between Fabric and GitLab issues.
 *
 * Imports types and pure helpers from `./story-sync`; `story-sync` reaches
 * back via a dynamic `import()` to avoid a static circular dependency.
 */

import {
	createPmAttachmentSyncFailedNotification,
	db,
	formatBackLinkForProvider,
	getStoryAttachmentsForSync,
	importPulledStoryAttachment,
	recordStoryAttachmentSyncIssue,
	getStoryById,
	isProjectReadOnly,
	updateStoryAttachmentSyncState,
} from "@repo/database";
import {
	applyLabelStatusMapOnPull,
	computeLabelDeltaOnPush,
	readLabelStatusMap,
} from "@repo/integrations/pm";
import {
	buildGitLabIngestOptions,
	ingestPulledImages,
	stripFailedMediaPlaceholders,
	stripGitLabImageAttributes,
} from "@repo/integrations/pm/pull-image-ingest";
import { createStoryMediaPullStore } from "@repo/integrations/pm/pull-image-store";
import { logger } from "@repo/logs";
import { READ_ONLY_MODE_MESSAGE } from "@repo/utils";
import { resolveAttachmentLimits } from "@repo/utils/attachment-limits";
import { isPmAttachmentSyncEnabled } from "@repo/utils/feature-flag";
import { ApplicationFailure } from "@temporalio/activity";
import { PMSourceNotFound, resolvePmSource } from "../pm-source";
import { callPmToolWithFallback } from "../pm-tool-fallback";
import { createGitLabAttachmentAdapter } from "./gitlab-attachment-adapter";
import {
	appendAttachmentBlock,
	renderAttachmentBlock,
	stripAttachmentBlock,
} from "./gitlab-attachment-block";
import {
	getPmSyncBaseline,
	stampPmSyncConflict,
	stampPmSyncSuccess,
} from "./hierarchy-sync";
import { computePmHash } from "./pm-sync-hash";
import { updateStoryFromPm as updateStory } from "./pm-update-story";
import {
	type ReconcileResult,
	reconcilePulledStoryAttachments,
	reconcileStoryAttachments,
	summarizeAttachmentFailures,
} from "./reconcile-story-attachments";
// #1360: STORY terminal-status reconcile leaf module. It imports ONLY
// `@repo/database` + `recordAudit` (never `./story-sync`), so importing it
// statically here introduces no cycle.
import { reconcileStoryTerminalStatus } from "./reconcile-story-terminal-status";
import {
	type RecordPmSyncLogInput,
	recordPmSyncLog,
} from "./record-pm-sync-log";
import {
	buildStoryDescription,
	type PMWorkItemSummary,
	type StorySyncInput,
	type StorySyncResult,
} from "./story-sync";
import {
	convertEmbeddedHtmlTablesToMarkdown,
	extractStoryMediaKeysFromContent,
	looksFabricAuthored,
	replaceHtmlImagesWithMarkdown,
	resolveStoryMediaSignedUrls,
	rewriteStoryMediaSourcesToSignedUrls,
	uploadGitLabFileAttachmentsAndRewrite,
	uploadGitLabImagesAndRewriteDescription,
} from "./story-sync-media";

/** Shape returned by the GitLab REST create/update adapters. */
type WriteResult = {
	externalId: string;
	externalUrl: string | null;
	title: string;
};

/** Shape returned by the GitLab REST fetch adapter. */
type FetchResult = {
	title: string;
	description: string | null;
	externalUrl: string | null;
	labels: string[];
	/**
	 * #1360: native GitLab issue state ("opened" | "closed") for terminal
	 * detection. The adapter (`getGitLabIssueForPM` → `GitLabPMFullItem`)
	 * already returns this; it was simply omitted from this LOCAL type. Optional
	 * because the MCP-server path may not surface a `state` field.
	 */
	state?: string;
};

const LINK_REMOVED_MESSAGE =
	"The external item was not found in the current PM tool. The sync link has been removed.";

/**
 * Classify a pull error as a "remote item no longer exists" signal.
 *
 * Mirrors the not-found classification the MCP pull path uses in
 * `story-sync.ts` (`/not found|does not exist|404|no such|cannot read prop/i`)
 * so the REST fallback only clears a sync link on a true not-found, and
 * preserves the link on transient/auth/rate-limit failures.
 */
function isNotFoundError(message: string): boolean {
	return /not found|does not exist|404|no such|cannot read prop/i.test(
		message,
	);
}

/**
 * Sync a single user story to GitLab via the REST fallback path.
 *
 * Mirrors the behavioural contract of the MCP path in `syncStoryToPM`:
 * push (create/update), pull (with self-heal on a missing remote), and
 * tool-mismatch handling — but routes every remote call through the GitLab
 * REST adapter instead of an MCP server.
 */
/**
 * One line describing what did not import (Fizzy #1745, AC-9).
 *
 * Every surface this reaches is single-line — the sync log's `statusDetail`
 * collapses `errorPayload` to one string, and the notification snippet is
 * rendered truncated — so the cap keeps a story that refused fifty files
 * readable. The structured per-file list travels alongside in `files`, and
 * each file also has its own durable `StoryAttachmentSyncIssue` row, so
 * nothing is actually lost to the cap.
 */
function summarize(list: Array<{ detail: string }>): string {
	const NAMED = 3;
	const named = list
		.slice(0, NAMED)
		.map((i) => i.detail)
		.join(" ");
	return list.length > NAMED
		? `${named} And ${list.length - NAMED} more.`
		: named;
}

export async function syncGitLabStoryViaRest(
	input: StorySyncInput,
): Promise<StorySyncResult> {
	const {
		storyId,
		projectId,
		mcpServerId,
		containerId,
		additionalContext,
		direction,
		userId,
		organizationId,
		overrideMismatch = false,
		forceHashOverride = false,
	} = input;

	const startedAt = Date.now();

	if (!mcpServerId) {
		throw ApplicationFailure.nonRetryable(
			"syncGitLabStoryViaRest: mcpServerId is required for the REST-GitLab path",
		);
	}

	// 1. Resolve the REST source. PMSourceNotFound is a user-actionable
	//    state (GitLab not connected / token expired), not a crash.
	let source: Awaited<ReturnType<typeof resolvePmSource>>;
	try {
		source = await resolvePmSource({
			mcpServerId,
			mcpConfigId: null,
			userId,
			organizationId: organizationId ?? null,
			containerId: containerId ?? null,
		});
	} catch (error) {
		if (error instanceof PMSourceNotFound) {
			logger.warn("[GitLab REST Sync] PM source not resolvable", {
				storyId,
				reason: error.reason,
			});
			return {
				success: false,
				error: "GitLab is not connected for this project. Connect GitLab and try again.",
				syncedAt: new Date(),
				direction,
			};
		}
		throw error;
	}

	if (source.kind !== "rest-gitlab") {
		throw ApplicationFailure.nonRetryable(
			`syncGitLabStoryViaRest: expected rest-gitlab source, got ${source.kind}`,
		);
	}

	// 2. Fetch the story.
	const story = await getStoryById(storyId, projectId);
	if (!story) {
		throw ApplicationFailure.nonRetryable(
			`Story ${storyId} not found in project ${projectId}`,
		);
	}

	const orgIdOrNull = organizationId ?? null;
	const activeServerId = mcpServerId;

	let externalId = story.externalId ?? undefined;
	let externalUrl = story.externalUrl ?? undefined;

	// Record one PmSyncLog row per attempt so GitLab REST syncs show up in the
	// Sync History tab — the MCP path (`syncStoryToPM`) logs the same way, but
	// this REST fallback previously logged nothing, leaving GitLab invisible in
	// the audit log. `recordPmSyncLog` is NON-FATAL (it swallows its own write
	// errors), and the closure reads the current `externalId`/`externalUrl` so a
	// freshly-created issue is captured. `pmTool` is the literal "gitlab": the
	// REST path has no MCP capabilities to derive a `detectedType` from.
	const logOutcome = (
		status: "SUCCESS" | "FAILURE",
		errorPayload?: RecordPmSyncLogInput["errorPayload"],
	): Promise<void> =>
		recordPmSyncLog({
			direction: direction === "pull" ? "pull" : "push",
			entityType: "STORY",
			entityId: storyId,
			title: story.title,
			pmTool: "gitlab",
			status,
			errorPayload: errorPayload ?? null,
			actorUserId: userId,
			externalId: externalId ?? null,
			externalUrl: externalUrl ?? null,
			organizationId: orgIdOrNull,
			userId: orgIdOrNull ? null : userId,
			projectId,
		});

	// 3. Tool-mismatch handling: the story is linked to a different server.
	if (
		story.externalMcpServerId &&
		story.externalMcpServerId !== activeServerId
	) {
		const canMigrate =
			(direction === "push" || direction === "bidirectional") &&
			overrideMismatch;
		if (canMigrate) {
			logger.info("[GitLab REST Sync] Migrating link to active server", {
				storyId,
				from: story.externalMcpServerId,
				to: activeServerId,
			});
			await updateStory(storyId, projectId, {
				externalId: null,
				externalUrl: null,
				externalMcpServerId: null,
			});
			externalId = undefined;
			externalUrl = undefined;
		} else {
			await logOutcome("FAILURE", {
				errorCode: "PM_TOOL_MISMATCH",
				errorMessage:
					"Feature is linked to a different PM tool — re-link it to sync with GitLab.",
			});
			return {
				success: false,
				error: "This feature is linked to a different PM tool. Re-link it to push to GitLab.",
				errorCode: "PM_TOOL_MISMATCH",
				syncedAt: new Date(),
				direction,
			};
		}
	}

	const labelStatusMap = readLabelStatusMap(additionalContext);

	// 4. Push (push | bidirectional).
	if (direction === "push" || direction === "bidirectional") {
		// Read-only mode: the GitLab REST path is reached via
		// syncStoryToPM's `mcpConfigId == null` delegation, which happens BEFORE
		// syncStoryToPM's own read-only gate — and the image/file uploads below
		// POST bytes to GitLab's /uploads endpoint ahead of the gated
		// create/update in callPmToolWithFallback. So this early gate is what
		// stops an outbound write (e.g. the import back-link push-back on a
		// read-only GitLab-REST project) from ever touching GitLab.
		if (await isProjectReadOnly(projectId)) {
			return {
				success: false,
				error: READ_ONLY_MODE_MESSAGE,
				syncedAt: new Date(),
				direction,
			};
		}
		// Self-heal (Fizzy #1745, R16): strip any attachment block that reached
		// Fabric's story description by a route we have not anticipated,
		// BEFORE it becomes the base every downstream rewriter touches and our
		// own block gets appended below. `stripAttachmentBlock` is global and
		// non-greedy, so this also cleans up an already-accumulated duplicate
		// rather than letting it grow on every push.
		const baseDescription = stripAttachmentBlock(
			formatBackLinkForProvider(buildStoryDescription(story), "gitlab"),
		);
		// Resolve story-media S3 keys → 7-day signed URLs, then convert any
		// embedded Tiptap `<table>` HTML to GFM markdown when the description
		// looks Fabric-authored. Pulled-from-GitLab descriptions (no Tiptap
		// markers, no story-media keys) pass through verbatim. Mirrors the
		// MCP path in `story-sync.ts:syncStoryToPM`.
		const mediaKeys = extractStoryMediaKeysFromContent(baseDescription);
		const signedUrlMap = await resolveStoryMediaSignedUrls(mediaKeys);
		const { content: withResolvedMedia, unresolvedKeys } =
			rewriteStoryMediaSourcesToSignedUrls(baseDescription, signedUrlMap);
		if (unresolvedKeys.length > 0) {
			logger.warn(
				"[GitLab REST Sync] Some story-media keys did not resolve",
				{
					storyId,
					unresolvedCount: unresolvedKeys.length,
					sampleKey: unresolvedKeys[0],
				},
			);
		}
		// GitLab renders GitLab Flavored Markdown: convert embedded tables to
		// GFM and standalone <img> to markdown images (consistent with the
		// MCP markdown-tool path; GitLab also renders raw <img>, but markdown
		// images keep the body portable).
		const markdownDescription = looksFabricAuthored(withResolvedMedia)
			? replaceHtmlImagesWithMarkdown(
					convertEmbeddedHtmlTablesToMarkdown(withResolvedMedia),
				)
			: withResolvedMedia;
		// GitLab BLOCKS `data:` image URLs and won't durably keep Fabric's signed
		// story-media S3 URLs (they expire), so images shipped as `![](data:…)`
		// or `![](https://…signed…)` render broken (GitLab issue #10). Upload each
		// to the project's `/uploads` endpoint and rewrite to the native
		// `/uploads/{secret}/{file}` link. Best-effort — failures keep the
		// original markdown so the rest of the description still ships.
		// Strip "could not be imported" placeholders BEFORE pushing. A failed-pull
		// placeholder pushed back to GitLab OVERWRITES the live attachment link
		// there (permanent data loss — the original `/uploads/…` reference becomes
		// inert text). Stripping keeps the source intact so a transient failure
		// self-heals on the next pull.
		const cleanedDescription =
			stripFailedMediaPlaceholders(markdownDescription);
		// Upload images AND non-image file attachments to GitLab's /uploads so
		// neither ships as a `data:` URL (GitLab blocks them) nor a
		// localhost/expiring story-media signed URL (GitLab can't resolve them).
		const withGitLabImages = await uploadGitLabImagesAndRewriteDescription(
			cleanedDescription,
			{
				token: source.token,
				projectId: source.projectId,
				baseUrl: source.baseUrl,
			},
		);
		const description = await uploadGitLabFileAttachmentsAndRewrite(
			withGitLabImages,
			{
				token: source.token,
				projectId: source.projectId,
				baseUrl: source.baseUrl,
			},
		);

		// Attachment push (Fizzy #1745, AC-1/2/3). Runs AFTER the media
		// uploaders above so their rewriting never sees our block, and the
		// block itself is markdown because those uploaders only match
		// markdown link/image forms. `project` is fetched here — not earlier
		// — so the read costs nothing when the flag is off.
		let descriptionWithAttachments = description;
		// Held, not emitted, until the work item is actually written below.
		// The push-time conflict guard returns early and the create/update
		// call can throw; reporting "attachments failed to sync" from here
		// would tell the reader the rest of the push landed when none of it
		// did. See the emit site after this branch closes.
		let attachmentFailureReport: {
			summary: string;
			failures: ReconcileResult["failures"];
		} | null = null;
		if (isPmAttachmentSyncEnabled()) {
			const attachmentProject = await db.project.findUnique({
				where: { id: projectId },
				select: { syncAttachments: true },
			});
			if (attachmentProject?.syncAttachments === true) {
				const rows = await getStoryAttachmentsForSync(
					storyId,
					projectId,
				);
				const reconciled = await reconcileStoryAttachments({
					rows,
					adapter: createGitLabAttachmentAdapter({
						token: source.token,
						projectId: source.projectId,
						baseUrl: source.baseUrl,
					}),
					direction: "push",
					isTerminal: story.pmTicketTerminal === true,
					persist: (id, data) =>
						updateStoryAttachmentSyncState(id, data),
				});
				if (reconciled.failures.length > 0) {
					logger.warn(
						"[GitLab REST Sync] attachment upload failures",
						{
							storyId,
							failures: reconciled.failures,
						},
					);
					// Capture only. The emit happens after the work item is
					// written, so a conflict return or a throw below leaves
					// no row claiming a push that never happened.
					attachmentFailureReport = {
						summary: summarizeAttachmentFailures(reconciled),
						failures: reconciled.failures,
					};
				}
				descriptionWithAttachments = appendAttachmentBlock(
					description,
					renderAttachmentBlock({
						links: reconciled.links,
						excluded: reconciled.excluded,
					}),
				);
			}
		}

		const delta = computeLabelDeltaOnPush(
			story.lastSyncedStatusId ?? null,
			story.statusId,
			story.labels ?? [],
			labelStatusMap,
		);

		if (externalId) {
			// Push-time conflict guard (T2 parity with the MCP path's
			// `syncWorkItemToPM` at hierarchy-sync.ts:863). Before overwriting
			// the GitLab issue, fetch its live content and compare to our
			// stamped baseline. If GitLab has been modified since our last
			// successful sync, stamp CONFLICT, log it, and surface the conflict
			// to the user instead of clobbering their PM-side edits.
			//
			// Skipped when:
			//  - `forceHashOverride` is set (the user explicitly chose "use
			//    Fabric version" in the resolve dialog — push unconditionally).
			//  - No baseline exists yet (first-ever sync, or pre-baseline-
			//    stamping legacy rows — there's nothing to compare against).
			//  - The fetch fails (transient/auth error): we don't want to block
			//    push on a flaky read; surface the conflict via the next
			//    successful attempt instead. Mirrors the MCP path's `if
			//    (snapshot)` guard at hierarchy-sync.ts:878.
			if (!forceHashOverride) {
				const baseline = await getPmSyncBaseline(
					"story",
					storyId,
					projectId,
				);
				if (baseline) {
					let livePm: FetchResult | null = null;
					try {
						livePm = (await callPmToolWithFallback({
							source,
							userId,
							organizationId: orgIdOrNull,
							call: { tool: "fetchItem", externalId },
						})) as FetchResult;
					} catch (error) {
						logger.warn(
							"[GitLab REST Sync] Conflict-guard fetch failed; proceeding with push",
							{
								storyId,
								externalId,
								error:
									error instanceof Error
										? error.message
										: String(error),
							},
						);
					}
					if (livePm) {
						// Strip the Fabric-owned attachment block before hashing
						// (Fizzy #1745) — otherwise the block's mere presence
						// (or an excluded-file list changing) would register as
						// remote drift and false-flag every push as a conflict.
						// Scoped to this GitLab call site deliberately:
						// `computePmHash` is shared by ADO, Jira and Fizzy, and
						// changing it there would move their conflict-detection
						// behaviour too.
						const currentHash = computePmHash(
							livePm.title,
							livePm.description
								? stripAttachmentBlock(livePm.description)
								: livePm.description,
						);
						if (currentHash !== baseline) {
							await stampPmSyncConflict("story", storyId);
							logger.info("pm.sync.conflict", {
								itemType: "story",
								itemId: storyId,
								pmTool: "gitlab",
								triggerSource: "gitlab-rest-push",
							});
							await recordPmSyncLog({
								direction: "push",
								entityType: "STORY",
								entityId: storyId,
								title: story.title,
								pmTool: "gitlab",
								status: "CONFLICT",
								errorPayload: {
									reason: "push-time-hash-drift",
									pmCurrentTitle: livePm.title,
								},
								actorUserId: userId,
								durationMs: Date.now() - startedAt,
								externalId,
								externalUrl:
									livePm.externalUrl ?? externalUrl ?? null,
								organizationId: orgIdOrNull,
								userId: orgIdOrNull ? null : userId,
								projectId,
							});
							return {
								success: false,
								error: "Remote GitLab issue was modified since the last sync. Resolve the conflict to continue.",
								errorCode: "PM_SYNC_CONFLICT",
								syncedAt: new Date(),
								direction,
							};
						}
					}
				}
			}

			await callPmToolWithFallback({
				source,
				userId,
				organizationId: orgIdOrNull,
				fabricProjectId: projectId,
				call: {
					tool: "updateItem",
					externalId,
					payload: {
						title: story.title,
						description: descriptionWithAttachments,
						addLabels: delta.addLabels,
						removeLabels: delta.removeLabels,
					},
				},
			});
			// Stamp the post-push baseline so the next push has something to
			// compare against. Deliberately hashes `description` (BEFORE the
			// attachment block is appended), not the literal payload we sent:
			// the push-time conflict check below (Fizzy #1745) strips the
			// block from the live-fetched content before hashing, so the
			// baseline must be block-free too, or every push after this one
			// would false-flag a conflict purely from the block's presence.
			// `description` never contains a block of its own, so this is
			// equivalent to stripping it.
			await stampPmSyncSuccess({
				itemType: "story",
				itemId: storyId,
				title: story.title,
				description,
			});
		} else {
			// Create path: still full-set the labels — the issue doesn't exist
			// yet, so there's nothing to delta against.
			const labels = [...(story.labels ?? []), ...delta.addLabels];
			const created = (await callPmToolWithFallback({
				source,
				userId,
				organizationId: orgIdOrNull,
				fabricProjectId: projectId,
				call: {
					tool: "createItem",
					payload: {
						title: story.title,
						description: descriptionWithAttachments,
						labels,
					},
				},
			})) as WriteResult;
			externalId = created.externalId;
			externalUrl = created.externalUrl ?? undefined;
			await updateStory(storyId, projectId, {
				externalId: created.externalId,
				externalUrl: created.externalUrl ?? null,
				externalMcpServerId: activeServerId,
			});
			// Stamp the baseline for the freshly-created issue so subsequent
			// pushes engage the conflict guard. Block-free for the same
			// reason as the update path's stamp above.
			await stampPmSyncSuccess({
				itemType: "story",
				itemId: storyId,
				title: story.title,
				description,
			});
		}

		// Attachment failure reporting (Fizzy #1745, AC-4). Emitted HERE, at
		// the point both the update and the create path have written the work
		// item and stamped their baseline — never earlier. The push-time
		// conflict guard above returns before this, and either write can
		// throw, so reporting from inside the reconcile branch produced a row
		// (and an inbox notification) saying files failed to sync onto a push
		// that never landed at all.
		//
		// This is a SEPARATE row from the run's own outcome, deliberately:
		// the work item itself synced, so flipping the terminal `logOutcome`
		// to FAILURE would misreport it — and `PmSyncLogStatus` has no
		// PARTIAL to express "the item landed, some files did not". Two rows
		// is what the enum affords, and Sync History filters by status so the
		// failure is findable on its own.
		//
		// `errorMessage` carries the whole summary because
		// `list-pm-sync-log.ts` reduces `errorPayload` to exactly one line
		// and reads that key first; `failures` keeps the per-file breakdown
		// (including each one's `kind`) for operators reading the raw row.
		// One summary string feeds BOTH surfaces, so the sync log and the
		// inbox can never tell a person different stories.
		if (attachmentFailureReport) {
			await recordPmSyncLog({
				direction: "push",
				entityType: "STORY",
				entityId: storyId,
				title: story.title,
				pmTool: "gitlab",
				status: "FAILURE",
				errorPayload: {
					reason: "attachment-push-failed",
					errorMessage: attachmentFailureReport.summary,
					failures: attachmentFailureReport.failures,
				},
				actorUserId: userId,
				externalId: externalId ?? null,
				externalUrl: externalUrl ?? null,
				organizationId: orgIdOrNull,
				userId: orgIdOrNull ? null : userId,
				projectId,
			});

			// The sync log alone is not enough — nobody opens Sync History
			// for a push they believe succeeded. The helper never throws by
			// contract, but that is a separate package's promise, so guard
			// here too: a notification outage must not turn "two of three
			// files uploaded" into a failed push.
			try {
				await createPmAttachmentSyncFailedNotification({
					actorUserId: userId,
					organizationId: orgIdOrNull,
					projectId,
					storyId,
					storyTitle: story.title,
					pmToolLabel: "GitLab",
					failureSummary: attachmentFailureReport.summary,
					link: `projects/${projectId}/stories/${storyId}`,
				});
			} catch (notifyError) {
				logger.warn(
					"[GitLab REST Sync] attachment failure notification dispatch failed",
					{ storyId, error: notifyError },
				);
			}
		}
	}

	// #1360: terminal-status lifecycle outcome from the per-item pull reconcile.
	// Populated only on a successful pull that ran the STORY reconcile; stays
	// null on push and when the (non-fatal) reconcile threw. `lifecycleReconciled`
	// flips to false (non-fatally) if the reconcile throws.
	let lifecycle: {
		terminalApplied: boolean;
		action: string;
		terminalStatusLabel: string | null;
	} | null = null;
	let lifecycleReconciled = true;

	// 5. Pull (pull | bidirectional) when an external link exists.
	if ((direction === "pull" || direction === "bidirectional") && externalId) {
		let fetched: FetchResult;
		try {
			fetched = (await callPmToolWithFallback({
				source,
				userId,
				organizationId: orgIdOrNull,
				call: { tool: "fetchItem", externalId },
			})) as FetchResult;
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			// #1360 three-rule not-found contract (mirrors the MCP pull path in
			// story-sync.ts). A true not-found means the remote item is gone, but
			// who owns the unlink depends on the link's provenance:
			//  - STAMPED link (`externalMcpServerId` set): PRESERVE it. Deletion
			//    is owned by the scheduled poll's source-scoped streak + human
			//    Accept, so Pull only surfaces a retryable not-found.
			//  - NULL-provenance (legacy) link: keep the existing self-heal
			//    unlink. The poll's `reconcileMissingTickets` skips null
			//    provenance, so preserving it would strand the user forever.
			// Transient/auth/rate-limit errors (the non-not-found `else` below)
			// already PRESERVE the link regardless of provenance.
			if (isNotFoundError(errorMessage)) {
				if (story.externalMcpServerId) {
					logger.warn(
						"[GitLab REST Sync] Pull not-found on stamped link — preserving (deletion owned by poll)",
						{
							storyId,
							identifier: story.identifier,
							externalId,
							error: errorMessage,
						},
					);
					await logOutcome("FAILURE", {
						errorCode: "EXTERNAL_ID_NOT_FOUND",
						errorMessage,
					});
					return {
						success: false,
						error: "The linked ticket was not found in GitLab. The link is kept; if it was deleted, the scheduled sync will flag it for review.",
						errorCode: "EXTERNAL_ID_NOT_FOUND",
						linkPreserved: true,
						syncedAt: new Date(),
						direction,
					};
				}
				// Null-provenance legacy link — keep the existing self-heal unlink
				// (the poll's source-scoped streak can't flag a null-provenance row).
				logger.warn(
					"[GitLab REST Sync] Pull not-found on legacy link — clearing stale link",
					{
						storyId,
						identifier: story.identifier,
						externalId,
						error: errorMessage,
					},
				);
				await updateStory(storyId, projectId, {
					externalId: null,
					externalUrl: null,
					externalMcpServerId: null,
				});
				await logOutcome("FAILURE", {
					errorCode: "EXTERNAL_ID_NOT_FOUND",
					errorMessage: LINK_REMOVED_MESSAGE,
				});
				return {
					success: false,
					error: LINK_REMOVED_MESSAGE,
					errorCode: "EXTERNAL_ID_NOT_FOUND",
					syncedAt: new Date(),
					direction,
				};
			}
			// Transient/unknown error — preserve the link and surface a
			// retryable failure with no errorCode.
			logger.warn("[GitLab REST Sync] Pull failed — preserving link", {
				storyId,
				identifier: story.identifier,
				externalId,
				error: errorMessage,
			});
			await logOutcome("FAILURE", { errorMessage });
			return {
				success: false,
				error: errorMessage,
				syncedAt: new Date(),
				direction,
			};
		}

		const projectStatuses = await db.projectStoryStatus.findMany({
			where: { projectId },
			select: { id: true },
		});
		const validStatusIds = new Set(projectStatuses.map((s) => s.id));

		const pull = applyLabelStatusMapOnPull(
			fetched.labels,
			labelStatusMap,
			validStatusIds,
		);

		externalUrl = fetched.externalUrl ?? externalUrl;

		// Pull-direction image ingest (GitLab): the fetched markdown references
		// images via `/uploads/{hash}` links that require the OAuth token a
		// browser can't send (broken icon). Download each with the integration
		// token, store it in Fabric, and rewrite to a Fabric-hosted <img> so it
		// renders. Mirror of the ADO pull path in story-sync.ts. NON-FATAL — on
		// any failure the original description is kept so the pull still lands.
		let pulledDescription = fetched.description;
		// Strip the Fabric-owned attachment block (Fizzy #1745) BEFORE the
		// image ingest below, not after. `ingestPulledImages` matches
		// markdown `[label](url)` links filtered on GitLab's
		// `/uploads/{32hex}/…` form — exactly what `renderAttachmentBlock`
		// emits — so left in place it would download and re-host Fabric's
		// own attachments into story media on every pull, only to have the
		// result discarded when the block was stripped afterward. Stripping
		// here also means the block never reaches Fabric's editor at all.
		if (pulledDescription) {
			pulledDescription = stripAttachmentBlock(pulledDescription);
		}
		if (
			typeof pulledDescription === "string" &&
			pulledDescription.length > 0
		) {
			// Strip GitLab image-attribute blocks (`![](url){width=…}`) BEFORE the
			// ingest — Fabric's markdown-it renders the `{…}` as literal text
			// otherwise (GitLab issue #9). The image URL itself is left for the
			// ingester to re-host.
			pulledDescription = stripGitLabImageAttributes(pulledDescription);
			try {
				const ingest = await ingestPulledImages({
					description: pulledDescription,
					projectId,
					storyId,
					store: createStoryMediaPullStore(),
					...buildGitLabIngestOptions(
						source.token,
						source.projectId,
						source.baseUrl,
					),
				});
				pulledDescription = ingest.description ?? pulledDescription;
				if (ingest.ingested || ingest.reused || ingest.failed) {
					logger.info("[GitLab REST Sync] pull image ingest", {
						storyId,
						ingested: ingest.ingested,
						reused: ingest.reused,
						failed: ingest.failed,
						skipped: ingest.skipped,
					});
				}
			} catch (err) {
				logger.warn("[GitLab REST Sync] pull image ingest failed", {
					storyId,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		await updateStory(storyId, projectId, {
			title: fetched.title,
			description: pulledDescription,
			externalUrl: fetched.externalUrl ?? undefined,
			labels: pull.remainingLabels,
			...(pull.kind === "matched" ? { statusId: pull.statusId } : {}),
		});
		// Stamp the post-pull baseline against the content we just received.
		// Without this, the next push would see a stale baseline (from before
		// the pull) and falsely report a conflict even though Fabric now
		// mirrors GitLab exactly. Block-stripped (Fizzy #1745): the push-time
		// conflict check above strips the block from the live-fetched
		// description before hashing, so a baseline stamped WITH the block
		// (present whenever this story was pushed with attachments before)
		// would never match again and every subsequent push would
		// false-flag a conflict.
		await stampPmSyncSuccess({
			itemType: "story",
			itemId: storyId,
			title: fetched.title,
			description: fetched.description
				? stripAttachmentBlock(fetched.description)
				: fetched.description,
		});

		// Attachment pull (Fizzy #1745, AC-5..AC-9). Runs AFTER the story and
		// its baseline are written, for the same reason the push half reports
		// after its write: an attachment problem must never be reported
		// against a pull that did not land.
		//
		// Reads `fetched.description` — the RAW body as GitLab returned it —
		// not `pulledDescription`, which by this point has had the Fabric
		// block stripped and its images rewritten to Fabric-hosted URLs. The
		// raw body is the only authoritative record of what is attached to the
		// issue.
		if (isPmAttachmentSyncEnabled()) {
			const attachmentProject = await db.project.findUnique({
				where: { id: projectId },
				select: { syncAttachments: true },
			});
			if (attachmentProject?.syncAttachments === true) {
				// Collected as they are forwarded: the durable
				// StoryAttachmentSyncIssue row has no free-text column, so the
				// human-readable `detail` — which AC-9 requires name both the
				// file and the limit — would otherwise be lost before it could
				// reach the sync log and the inbox.
				const issues: Array<{
					filename: string;
					kind: string;
					detail: string;
				}> = [];
				const rows = await getStoryAttachmentsForSync(
					storyId,
					projectId,
				);
				const pulled = await reconcilePulledStoryAttachments({
					rows,
					adapter: createGitLabAttachmentAdapter({
						token: source.token,
						projectId: source.projectId,
						baseUrl: source.baseUrl,
					}),
					description: fetched.description ?? "",
					// The SAME resolver the API upload path uses, so the two
					// doors into the attachment store cannot enforce different
					// numbers.
					limits: resolveAttachmentLimits(),
					importAttachment: async (data) => {
						await importPulledStoryAttachment({
							storyId,
							projectId,
							filename: data.filename,
							mimeType: data.contentType,
							data: data.data,
							contentHash: data.contentHash,
							externalAttachmentId: data.externalAttachmentId,
							uploaderUserId: userId,
						});
					},
					recordIssue: async (issue) => {
						issues.push(issue);
						await recordStoryAttachmentSyncIssue({
							storyId,
							sourceTool: "gitlab",
							filename: issue.filename,
							reason: issue.kind,
						});
					},
				});

				if (issues.length > 0 || pulled.failures.length > 0) {
					logger.warn("[GitLab REST Sync] attachment pull issues", {
						storyId,
						issues,
						failures: pulled.failures,
					});
				}

				// AC-8 asks specifically for a CONFLICT entry in the sync log,
				// and `PmSyncLogStatus` has that status — so conflicts get
				// their own row rather than being folded into a FAILURE that
				// Sync History's status filter would file under the wrong
				// heading. Everything else (refused imports, download
				// failures) is a FAILURE.
				const conflicts = issues.filter((i) => i.kind === "CONFLICT");
				const problems = [
					...issues.filter((i) => i.kind !== "CONFLICT"),
					...pulled.failures.map((f) => ({
						filename: f.filename,
						kind: "DOWNLOAD_FAILED",
						detail: `"${f.filename}" could not be imported: ${f.message}`,
					})),
				];

				const logRow = (
					status: "CONFLICT" | "FAILURE",
					reason: string,
					list: Array<{ filename: string; detail: string }>,
				) =>
					recordPmSyncLog({
						direction: "pull",
						entityType: "STORY",
						entityId: storyId,
						title: fetched.title ?? story.title,
						pmTool: "gitlab",
						status,
						errorPayload: {
							reason,
							errorMessage: summarize(list),
							files: list,
						},
						actorUserId: userId,
						externalId: externalId ?? null,
						externalUrl: externalUrl ?? null,
						organizationId: orgIdOrNull,
						userId: orgIdOrNull ? null : userId,
						projectId,
					});

				if (conflicts.length > 0) {
					await logRow(
						"CONFLICT",
						"attachment-pull-conflict",
						conflicts,
					);
				}
				if (problems.length > 0) {
					await logRow("FAILURE", "attachment-pull-failed", problems);
					// AC-9 requires the user be NOTIFIED, not merely logged —
					// nobody opens Sync History for a pull they believe
					// succeeded. Reuses the push half's notification type: the
					// reader's situation ("attachments did not sync on this
					// item") is the same in both directions, and a second enum
					// value would need a migration to say nothing new.
					try {
						await createPmAttachmentSyncFailedNotification({
							actorUserId: userId,
							organizationId: orgIdOrNull,
							projectId,
							storyId,
							storyTitle: fetched.title ?? story.title,
							pmToolLabel: "GitLab",
							failureSummary: summarize(problems),
							link: `projects/${projectId}/stories/${storyId}`,
						});
					} catch (notifyError) {
						logger.warn(
							"[GitLab REST Sync] attachment pull notification dispatch failed",
							{ storyId, error: notifyError },
						);
					}
				}
			}
		}

		// #1360: run the STORY terminal-status reconcile using the issue `state`
		// the fetch adapter already returned (no extra remote roundtrip). The
		// raw GitLab `state`/`labels` carry the closure signal into the
		// `rest-gitlab` normalize branch (state "closed" → isClosed:true). Mirrors
		// the MCP pull wiring in `story-sync.ts`. NON-FATAL: a reconcile failure
		// NEVER fails the content pull.
		try {
			// `extract-pm-item-state` imports runtime helpers FROM `story-sync`,
			// which reaches this module via a dynamic import — so a static import
			// back would close a cycle. Import `normalizePolledState` lazily
			// (matches the MCP path's pattern).
			const { normalizePolledState } = await import(
				"./extract-pm-item-state"
			);
			const summary: PMWorkItemSummary = {
				id: externalId,
				title: fetched.title,
				description: fetched.description,
				raw: { state: fetched.state, labels: fetched.labels },
			};
			const n = normalizePolledState(summary, { kind: "rest-gitlab" });

			const reconcileStory = await getStoryById(storyId, projectId);
			const project = await db.project.findUnique({
				where: { id: projectId },
				select: {
					pmTerminalStatuses: true,
					pmAutoCloseEnabled: true,
					organizationId: true,
					userId: true,
				},
			});
			if (reconcileStory && project) {
				const terminalSet =
					project.pmTerminalStatuses &&
					project.pmTerminalStatuses.length > 0
						? project.pmTerminalStatuses
						: ["Closed", "Done", "Removed"];
				const r = await reconcileStoryTerminalStatus({
					projectId,
					item: {
						externalId,
						state: n.statusString ?? "",
						stateChangedDate: n.changedDate
							? n.changedDate.toISOString()
							: null,
						isClosed: n.isClosed,
						labels: n.labels,
					},
					fabricItem: {
						entityType: "STORY",
						entityId: storyId,
						draftingStage: reconcileStory.draftingStage,
						pmAutoHidden: reconcileStory.pmAutoHidden ?? false,
						lastSyncedPmHash: null,
						lastPmSyncStatus: null,
					},
					terminalLc: new Set(
						terminalSet.map((s) => s.toLowerCase()),
					),
					autoCloseEnabled: project.pmAutoCloseEnabled ?? false,
					tenant: {
						organizationId: project.organizationId ?? null,
						userId: project.userId ?? null,
					},
				});
				lifecycle = {
					terminalApplied: r.terminalApplied,
					action: r.action,
					terminalStatusLabel: r.terminalStatusLabel,
				};
			}
		} catch (lifecycleError) {
			lifecycleReconciled = false;
			logger.warn(
				"[GitLab REST Sync] terminal-status reconcile failed (non-fatal)",
				{
					storyId,
					error:
						lifecycleError instanceof Error
							? lifecycleError.message
							: String(lifecycleError),
				},
			);
		}
	}

	await logOutcome("SUCCESS");

	return {
		success: true,
		externalId,
		externalUrl,
		syncedAt: new Date(),
		direction,
		// #1360 — terminal-status lifecycle fields (pull only; null on push and
		// when the non-fatal reconcile threw). `lifecycleReconciled` is true
		// unless the reconcile threw.
		terminalApplied: lifecycle?.terminalApplied,
		lifecycleAction: lifecycle?.action,
		lifecycleReconciled,
		terminalStatusLabel: lifecycle?.terminalStatusLabel,
	};
}
