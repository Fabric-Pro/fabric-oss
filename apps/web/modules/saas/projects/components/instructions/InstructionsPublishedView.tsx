"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { ConnectCliDialog } from "@saas/projects/components/cli-connection/ConnectCliDialog";
import { useDiscardUpload } from "@saas/projects/hooks/use-discard-upload";
import { useInstructionActionError } from "@saas/projects/hooks/use-instruction-action-error";
import { useMigrationPauseReason } from "@saas/projects/hooks/use-migration-pause-reason";
import { canDiscardUpload } from "@saas/projects/lib/instructions-discardable-upload";
import { formatRelativeTime } from "@saas/shared/lib/format-time";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckIcon, Loader2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import {
	type BaseComparison,
	changeMarks,
} from "../../lib/instructions-base-changes";
import { defaultSelectedPath } from "../../lib/instructions-default-file";
import { leftOutListing } from "../../lib/instructions-left-out";
import { publishConvergenceEndedByRun } from "../../lib/instructions-poll";
import {
	countAwaitingDecision,
	PROPOSALS_PAGE_SIZE,
} from "../../lib/instructions-proposal-review";
import {
	localSetupRouteFor,
	offersSyncFromRepository,
	offersSyncNow,
	type RepositorySyncControls,
	repositorySyncOwnsSnapshotProgress,
	shortCommit,
} from "../../lib/instructions-repository-sync";
import type { InstructionsSnapshot } from "../../lib/instructions-snapshot";
import { supersededEdit } from "../../lib/instructions-superseded";
import { AddInstructionFileDialog } from "./AddInstructionFileDialog";
import { InstructionFileView } from "./InstructionFileView";
import { InstructionProposals } from "./InstructionProposals";
import type { InstructionsActions } from "./InstructionsActionBar";
import { InstructionsCheckingStatus } from "./InstructionsCheckingStatus";
import { InstructionsCommits } from "./InstructionsCommits";
import { InstructionsCompareDialog } from "./InstructionsCompareDialog";
import { InstructionsDeferredScanAlerts } from "./InstructionsDeferredScanAlerts";
import { InstructionsFailedChecksBanner } from "./InstructionsFailedChecksBanner";
import { InstructionsHistory } from "./InstructionsHistory";
import { InstructionsPageFrame } from "./InstructionsPageFrame";
import {
	InstructionsRejectedBanner,
	REJECTED_BANNER_ID,
} from "./InstructionsRejectedBanner";
import { InstructionsSettingsDialog } from "./InstructionsSettingsDialog";
import { InstructionsStatusStrip } from "./InstructionsStatusStrip";
import { InstructionsSupersededNotice } from "./InstructionsSupersededNotice";
import { InstructionsTree, type TreeFile } from "./InstructionsTree";
import { RepositoryPublishedSummary } from "./RepositoryPublishedSummary";
import { RepositorySyncRuns } from "./RepositorySyncRuns";
import { RepositorySyncSettingsSection } from "./RepositorySyncSettingsSection";
import { RepositorySyncStatus } from "./RepositorySyncStatus";
import { useInstructionsFileView } from "./useInstructionsFileView";

const RECEIVING_STATUSES = new Set(["RECEIVING", "VALIDATING"]);

export type { InstructionsSnapshot };

function reasonLabel(
	layer: string | undefined,
	t: (key: string) => string,
): string {
	if (layer === "fabricignore") {
		return t("reasonFabricignore");
	}
	if (layer === "project") {
		return t("reasonProject");
	}
	return t("reasonDefault");
}

/**
 * The tab's published state: the plain-English published-version summary,
 * a rejected-upload banner when the newest upload failed checks (while the
 * previous version stays published underneath it), the file tree + reader,
 * and the History/Settings entry points.
 */
export function InstructionsPublishedView({
	projectId,
	projectName,
	published,
	snapshots,
	onReplaceClick,
	onChanged,
	canEdit = false,
	canReview = false,
	canRead = false,
	repositoryBacked = false,
	repositoryConfirmed,
	repositorySync,
	publishedUnknown = false,
	awaitingPublish = false,
	readOnlyMode = false,
	onCommitted,
	syncingCommit = null,
	notice = null,
}: {
	projectId: string;
	/** Named in the "Connect your agent" dialog. */
	projectName: string;
	/** A notice the tab puts above everything else, such as a failed settings read. */
	notice?: ReactNode;
	published: InstructionsSnapshot | null;
	snapshots: InstructionsSnapshot[];
	onReplaceClick: () => void;
	onChanged: () => void;
	/**
	 * The pointer query FAILED, as opposed to there being nothing published.
	 * Both arrive here as `published: null`, and only History needs to tell
	 * them apart — it cannot say whether a version is a publish or a rollback
	 * without knowing what is published now.
	 */
	publishedUnknown?: boolean;
	/**
	 * The newest version passed its checks and is set to publish itself, and
	 * the tab is still waiting for the published pointer to catch up
	 * (`instructionsAwaitsPublish`). Bounded by the tab, so "Publishing…" is
	 * never left up for a version whose publish was refused.
	 */
	awaitingPublish?: boolean;
	/**
	 * The project is in Read-only mode, which refuses every write to its
	 * connected sources: no commit to the branch, however the member is
	 * permitted. A UI gate; the server refuses it too.
	 */
	readOnlyMode?: boolean;
	/** A commit landed on the synced branch: the tab keeps reading until Fabric's copy has it. */
	onCommitted?: (commit: { sha: string; ref: string }) => void;
	/** A commit made from this tab that Fabric's copy has not taken yet. */
	syncingCommit?: { sha: string; ref: string } | null;
	/**
	 * Whether this viewer may change the published files. A UI gate only:
	 * `derive` re-checks `INSTRUCTION_CREATE` server-side on every save.
	 */
	canEdit?: boolean;
	/** Whether this viewer may approve or reject file proposals. */
	canReview?: boolean;
	/**
	 * Whether this viewer may read the project's coding instructions
	 * (INSTRUCTION_READ). On a repository-backed project a reader may suggest
	 * a change once `allowReaderProposals` is on (Fizzy #2563 spec §12).
	 */
	canRead?: boolean;
	/**
	 * The project's instructions come from its repository (spec §6.12), so
	 * they are changed in git and refreshed by sync. The server refuses an
	 * edit for such a project; hiding the actions is how the tab says so
	 * before someone tries.
	 */
	repositoryBacked?: boolean;
	/**
	 * The loaded settings name the repository as the source of truth.
	 * `repositoryBacked` fails closed (true while settings load or after
	 * they fail), which is right for hiding actions but not for copy: the
	 * rejected banner only tells someone to change files in the repository
	 * when this is known. Defaults to `repositoryBacked`.
	 */
	repositoryConfirmed?: boolean;
	/**
	 * The tab's repository-sync state and actions (design 2026-09-23 §7).
	 * Absent, the view renders exactly as before.
	 */
	repositorySync?: RepositorySyncControls;
}) {
	const actionError = useInstructionActionError();
	const t = useTranslations("projects.codingInstructions.publishedView");
	const [selected, setSelected] = useState<string | null>(null);
	const [addFileOpen, setAddFileOpen] = useState(false);
	const [historyOpen, setHistoryOpen] = useState(false);
	const [proposalsOpen, setProposalsOpen] = useState(false);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [connectOpen, setConnectOpen] = useState(false);
	const [compareOpen, setCompareOpen] = useState(false);
	// One switch for the two places that offer the left-out files: the status
	// strip's Show/Hide and the tree footer's toggle.
	const [leftOutShown, setLeftOutShown] = useState(false);
	// Mirrors ProjectReadinessPanel: minting must fail closed. With no
	// organization id there is nothing to mint the key against. An invited
	// guest views this project under the HOST organization's thin record
	// (`isGuest: true`) — they have no membership row there, so the create
	// procedure's host-membership check (packages/api/modules/organizations/procedures/api-keys/create.ts)
	// would refuse them; hide the action instead of surfacing a FORBIDDEN.
	const { organizationId, organizationSlug, isGuest } =
		useOrganizationContext();
	const canConnectAgent = Boolean(organizationId) && !isGuest;
	// A move of the uploaded instructions into a repository pauses every way of
	// changing them (Fizzy #2878 §9); the controls stay and say why.
	const pausedReason = useMigrationPauseReason(
		Boolean(repositorySync?.state.migration),
		repositorySync?.migration?.read?.migration ?? null,
	);
	const discardUpload = useDiscardUpload({ projectId, onChanged });

	// Editing is offered only on a published version: a derivation needs a
	// READY base with promoted objects to inherit, and the tab only ever shows
	// the published one's tree.
	const canMutateDirect = canEdit && !repositoryBacked;
	const editable = canMutateDirect && Boolean(published);
	// Approve and Reject stay FABRIC-only: a repository-backed project's
	// suggestions are decided on their pull requests (Fizzy #2563 spec §12).
	const canReviewProposals = Boolean(canReview) && !repositoryBacked;
	// How many proposals wait for this viewer's decision, for the Review button
	// in the header. The page the proposals dialog opens on, so both read one
	// cache entry; the tab's invalidations refresh it with the rest.
	const awaitingReview = useQuery({
		...orpc.projects.instructions.proposals.list.queryOptions({
			input: { projectId, limit: PROPOSALS_PAGE_SIZE },
		}),
		enabled: canReviewProposals,
		select: (page) => countAwaitingDecision(page.items),
	});
	// Publishing before the scan (Fizzy #2737) is a direct, publishing save,
	// so it needs both what an edit needs and the publish permission, which
	// is what `canReview` carries (INSTRUCTION_UPDATE).
	const canPublishBeforeScan = editable && Boolean(canReview);
	// A repository-backed proposal opens a pull request into the configured
	// repository, so it is offered only once repository mode is CONFIRMED and
	// a configuration names that repository: `repositoryBacked` fails closed
	// while settings load, which is right for hiding direct edits but would
	// offer a suggestion nobody can yet say the target of. CREATE proposes by
	// default; a reader needs the project's opt-in (spec §16.1). The server
	// re-checks all of it at admission.
	const repositoryModeConfirmed =
		repositoryBacked && (repositoryConfirmed ?? repositoryBacked);
	const repositoryConfiguration = repositoryModeConfirmed
		? (repositorySync?.state.configured ?? null)
		: null;
	const repositoryTarget = repositoryConfiguration
		? {
				repository: `${repositoryConfiguration.repositoryOwner}/${repositoryConfiguration.repositoryName}`,
				ref: repositoryConfiguration.ref,
			}
		: null;
	// "Commit to <branch>" (Fizzy #2878 §10): a member with write rights on a
	// repository project whose branch is confirmed commits straight to it, as
	// they would with git, instead of saving a version. The server re-checks
	// INSTRUCTION_CREATE, and a reader never gets it whatever the opt-in.
	const canCommit =
		Boolean(canEdit) &&
		!readOnlyMode &&
		repositoryTarget !== null &&
		Boolean(published);
	const canPropose =
		Boolean(published) &&
		(repositoryBacked
			? repositoryTarget !== null &&
				(Boolean(canEdit) ||
					(Boolean(canRead) &&
						Boolean(repositoryConfiguration?.allowReaderProposals)))
			: true);
	// A reader keeps their own earlier suggestions in view after the opt-in
	// is turned off, and after the sync configuration is removed while
	// repository mode remains: only proposing needs a configured target.
	// The list only ever shows a non-reviewer their own rows.
	const canBrowseProposals =
		Boolean(canReview) ||
		canPropose ||
		(repositoryModeConfirmed && Boolean(canRead));

	// Proposal lifecycle uses its own review UI. Feeding a proposal into the
	// direct-upload banners would call it "your upload" and could offer the
	// direct retry path, both of which misstate the approval workflow.
	const newest =
		snapshots.find((snapshot) => snapshot.proposalStatus == null) ?? null;
	const newerThanPublished =
		!!newest && (!published || newest.version > published.version);
	const rejected =
		newest && newest.status === "REJECTED" && newerThanPublished
			? newest
			: null;
	// A snapshot the validation workflow could not finish (R30). Distinct
	// from REJECTED, which is a verdict about the files: FAILED means the
	// check itself broke, the staged bytes are still there, and re-running
	// `finalize` is a real recovery rather than a re-upload.
	//
	// Not for a direct commit: its watcher reports a failed commit where the
	// person made it, and "Try again" here would re-check files nobody uploads.
	const failed =
		newest &&
		newest.status === "FAILED" &&
		newerThanPublished &&
		newest.proposalDestination !== "REPOSITORY_COMMIT"
			? newest
			: null;
	// `finalize` re-checks the staged files in place, which serves an upload
	// version in upload mode and a synced version once repository mode is
	// confirmed. Any other pairing cannot be published, so it gets no button.
	const canRetryFailed =
		canEdit &&
		failed !== null &&
		((!repositoryBacked && failed.source === "UPLOAD") ||
			(repositoryModeConfirmed && failed.source === "REPOSITORY"));
	const checking =
		newest && RECEIVING_STATUSES.has(newest.status) && newerThanPublished
			? newest
			: null;
	// The snapshot list backs off while the sync response continues polling.
	// Let the sync status own its snapshot's progress instead of showing both.
	const repositorySyncOwnsNewest = Boolean(
		newest &&
			repositorySync &&
			repositorySyncOwnsSnapshotProgress(repositorySync.state, newest),
	);
	const checkingInSync = Boolean(checking && repositorySyncOwnsNewest);
	// The checks passed and the tab is waiting for the pointer to move onto
	// this version. Not for a proposal, which publishes only through review.
	const publishing =
		!checking &&
		awaitingPublish &&
		newest !== null &&
		newest.status === "READY" &&
		newerThanPublished &&
		!publishConvergenceEndedByRun(
			newest.id,
			repositorySync?.state.latestRun,
		);
	const publishingInSync = publishing && repositorySyncOwnsNewest;
	const superseded = supersededEdit({
		newest,
		published,
		newerThanPublished,
	});
	const rejectionRows = rejected?.rejection;
	const settingsLayer = published?.settingsFrozen?.layer;
	const syncConfigured = repositorySync?.state.configured ?? null;
	// The Connect dialog's local-checkout route: `null`/upload/repository,
	// computed by the one helper the tab's empty-state call site also uses
	// (Fizzy #2721) so both surfaces agree on when the CLI route is offered.
	const localSetup = localSetupRouteFor({
		repositoryBacked,
		repositoryConfirmed: Boolean(repositoryConfirmed),
		configured: syncConfigured,
	});
	const syncBusy = Boolean(
		repositorySync &&
			(repositorySync.state.running || repositorySync.syncNowPending),
	);
	// Named only when the published version came from the integration still
	// configured; a version synced before a re-point says "the repository".
	const publishedRepository =
		syncConfigured &&
		published?.repositoryIntegrationId ===
			syncConfigured.repositoryIntegrationId
			? `${syncConfigured.repositoryOwner}/${syncConfigured.repositoryName}`
			: null;
	const summaryRepository = publishedRepository ?? t("repositoryUnknown");
	const leftOutFiles = published?.excludedPaths ?? [];
	const leftOut = leftOutListing(published?.excludedCount ?? 0, leftOutFiles);

	// listFiles is only ever queried here against the PUBLISHED snapshot,
	// which is always READY, so the server always returns the full per-file
	// shape (see list-files.ts) rather than the reduced `{ id, path }`
	// variant it serves for a RECEIVING/VALIDATING snapshot.
	const files = useQuery({
		...orpc.projects.instructions.listFiles.queryOptions({
			input: { projectId, snapshotId: published?.id ?? "" },
		}),
		enabled: Boolean(published),
	});
	const treeFiles: TreeFile[] = (files.data ?? []).flatMap((file) =>
		"kind" in file
			? [
					{
						path: file.path,
						kind: file.kind,
						name: file.name,
						description: file.description,
					},
				]
			: [],
	);
	const treePaths = new Set(treeFiles.map((file) => file.path));
	// The selection is a PATH, and a path outlives the version it was chosen
	// in: a Delete file publishes a new version without that path, the poll
	// swaps the version in, and the pane went on asking the new version for
	// a file it does not have ("Could not load this file"). So a path counts
	// as selected only while the version on screen lists it; otherwise the
	// tab opens on the project's entry file (root CLAUDE.md, else AGENTS.md),
	// and shows the pick-a-file prompt when there is neither. Derived rather
	// than reset in an effect: nothing has to run after render, and a path that
	// comes back in a later version is simply selected again.
	//
	// Gated on the list having LOADED, not merely on `files.data`: between a
	// version change and its list arriving `data` is undefined, and reading
	// that as "no files" flashed the pick-a-file prompt at someone whose file
	// was about to turn out to still be there.
	const fileListLoaded = files.isSuccess;
	const selectedFile = !fileListLoaded
		? null
		: selected !== null && treeFiles.some((file) => file.path === selected)
			? selected
			: defaultSelectedPath(treeFiles);
	const { fileView, onDraftStateChange } = useInstructionsFileView({
		projectId,
		published,
		selectedFile,
		fileListLoaded,
	});
	// The folder a new file lands in by default — the selected file's own
	// folder, which is where someone reading `.claude/skills/review/SKILL.md`
	// and pressing "Add file" means to put it. From the EFFECTIVE selection:
	// a folder the displayed version no longer has is not a default.
	const selectedFolder = selectedFile?.includes("/")
		? selectedFile.slice(0, selectedFile.lastIndexOf("/"))
		: null;

	// What this published version changed relative to the version it was
	// EDITED FROM. Only an edit has a base at all; an uploaded folder answers
	// no such question, so the strip's "Since version" fact and the tree's
	// markers simply do not appear for one.
	//
	// `retry: false` and a silent failure on purpose: `baseSnapshotId` is
	// `SetNull`, and a base that was deleted or pruned out of the kept window
	// makes `compare` 404 — a normal, expected state for an old version, not
	// something to retry or to show an error about. The rest of the page is
	// its real content and stays whole either way.
	const baseSnapshotId = published?.baseSnapshotId ?? null;
	const changedFromBase = useQuery({
		...orpc.projects.instructions.compare.queryOptions({
			input: {
				projectId,
				fromSnapshotId: baseSnapshotId ?? "",
				toSnapshotId: published?.id ?? "",
			},
		}),
		enabled: Boolean(baseSnapshotId) && Boolean(published),
		retry: false,
	});
	const baseComparison = changedFromBase.data as BaseComparison | undefined;
	const marks = changeMarks(baseComparison);

	const retry = useMutation(
		orpc.projects.instructions.finalize.mutationOptions({
			onSuccess: (result) => {
				// The previous execution is still closing, so nothing restarted.
				if (result.status === "FAILED") {
					toast.info(t("retryChecksStillClosing"));
				}
				onChanged();
			},
			onError: (error) => toast.error(actionError(error)),
		}),
	);

	const download = useMutation(
		orpc.projects.instructions.createDownloadUrl.mutationOptions({
			onSuccess: (data) => window.open(data.url, "_blank", "noopener"),
			onError: (error) => toast.error(actionError(error)),
		}),
	);

	// The status block's "See findings": take the reader to the rejected
	// banner that lists them.
	function seeFindings() {
		const banner = document.getElementById(REJECTED_BANNER_ID);
		banner?.scrollIntoView?.({ behavior: "smooth", block: "start" });
		banner?.focus();
	}

	const actions: InstructionsActions = {
		upload: editable
			? {
					published: Boolean(published),
					onClick: onReplaceClick,
					pausedReason,
				}
			: undefined,
		history: {
			onOpen: () => setHistoryOpen(true),
			commits: repositoryConfiguration !== null,
		},
		download: published
			? {
					pending: download.isPending,
					onDownload: () =>
						download.mutate({
							projectId,
							snapshotId: published.id,
						}),
				}
			: undefined,
		proposals: canBrowseProposals
			? {
					label: repositoryBacked
						? "suggestionsButton"
						: canReviewProposals
							? "reviewProposalsButton"
							: "proposalsButton",
					onOpen: () => setProposalsOpen(true),
					awaitingReview: canReviewProposals
						? (awaitingReview.data ?? 0)
						: 0,
				}
			: undefined,
		syncNow:
			repositorySync && offersSyncNow(repositorySync.state)
				? {
						running: repositorySync.state.running,
						busy: syncBusy,
						onSync: repositorySync.onSyncNow,
					}
				: undefined,
		syncFromRepository:
			repositorySync && offersSyncFromRepository(repositorySync.state)
				? { onOpen: repositorySync.onConfigure }
				: undefined,
		// A repository-backed project is never `editable` (it has no versions
		// to save). Someone who may commit adds a file to the branch; anyone
		// else can only suggest it as a pull request.
		addFile: canCommit
			? { mode: "add", onOpen: () => setAddFileOpen(true), pausedReason }
			: canPropose && repositoryTarget
				? {
						mode: "suggest",
						onOpen: () => setAddFileOpen(true),
						pausedReason,
					}
				: editable || canPropose
					? {
							mode: editable ? "add" : "propose",
							onOpen: () => setAddFileOpen(true),
							pausedReason,
						}
					: undefined,
		settings: { onOpen: () => setSettingsOpen(true) },
	};

	// The repository's sync runs, listed under History (or Commits) as they
	// have always been.
	const syncRunsList =
		repositorySync &&
		(repositorySync.state.configured || repositorySync.state.latestRun) ? (
			<RepositorySyncRuns
				projectId={projectId}
				running={repositorySync.state.running}
			/>
		) : null;

	return (
		<InstructionsPageFrame
			actions={actions}
			notice={notice}
			badge={
				published ? (
					<span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-success/10 px-2.5 py-0.5 font-medium text-success text-xs">
						<CheckIcon className="size-3" aria-hidden="true" />
						{published.source === "REPOSITORY" &&
						published.sourceRef &&
						published.sourceCommitSha
							? t("publishedBadgeRepository", {
									ref: published.sourceRef,
									sha7:
										shortCommit(
											published.sourceCommitSha,
										) ?? "",
								})
							: t("publishedBadge", {
									version: published.version,
								})}
					</span>
				) : null
			}
			summary={
				published || checking || publishing ? null : (
					<p className="text-muted-foreground">{t("emptySummary")}</p>
				)
			}
		>
			<div className="flex flex-col gap-3">
				{published ? (
					<InstructionsStatusStrip
						published={published}
						repository={summaryRepository}
						reason={reasonLabel(settingsLayer, t)}
						publishedBy={
							published.source === "REPOSITORY" &&
							published.sourceRef ? (
								<RepositoryPublishedSummary
									projectId={projectId}
									commitSha={
										published.sourceCommitSha ?? null
									}
									version={published.version}
									fallbackName={
										published.user?.name ??
										t("anonymousUser")
									}
									fallbackTime={published.createdAt}
									enabled={repositoryConfiguration !== null}
								/>
							) : (
								<span>
									{t("statusPublishedBy", {
										name:
											published.user?.name ??
											t("anonymousUser"),
										time: formatRelativeTime(
											published.createdAt,
										),
									})}
								</span>
							)
						}
						comparison={baseComparison}
						leftOutShown={leftOutShown}
						onToggleLeftOut={() =>
							setLeftOutShown((shown) => !shown)
						}
						onCompare={() => setCompareOpen(true)}
						onConnect={
							canConnectAgent
								? () => setConnectOpen(true)
								: undefined
						}
					/>
				) : null}
				<InstructionsCheckingStatus
					checking={checkingInSync ? null : checking}
					publishing={publishing && !publishingInSync}
					// An upload that never finished (its browser could not
					// reach storage, or its tab was closed) stays here with
					// nothing to move it: the way out is to discard it.
					onDiscard={
						checking && canEdit && canDiscardUpload(checking)
							? () => discardUpload.discard(checking.id)
							: undefined
					}
					discarding={discardUpload.pending}
				/>
				{repositorySync ? (
					<RepositorySyncStatus
						projectId={projectId}
						state={repositorySync.state}
						publishing={publishingInSync}
						migration={repositorySync.migration}
						// Cancel move and Retry write what Move writes:
						// they need create and update.
						canManageMigration={Boolean(canEdit && canReview)}
						onMigrationChanged={repositorySync.onChanged}
						publishedVersion={published?.version ?? null}
						published={
							published && published.source === "REPOSITORY"
								? {
										sourceCommitSha:
											published.sourceCommitSha ?? null,
										sourceRef: published.sourceRef ?? null,
									}
								: null
						}
						syncingCommit={syncingCommit}
						onSeeFindings={rejectionRows ? seeFindings : undefined}
						onSyncNow={
							repositorySync.state.canConfigure
								? repositorySync.onSyncNow
								: undefined
						}
						onConfigure={
							repositorySync.state.canConfigure
								? repositorySync.onConfigure
								: undefined
						}
					/>
				) : null}
			</div>
			{rejectionRows ? (
				<InstructionsRejectedBanner
					rejection={rejectionRows}
					// Spec §4: no uploads while a repository is the source of
					// truth — the server refuses them, so never offer one.
					onUploadAgain={
						repositoryBacked ? undefined : onReplaceClick
					}
					repositoryBacked={repositoryConfirmed ?? repositoryBacked}
					publishedVersion={published?.version ?? null}
					mode={
						rejected?.source === "REPOSITORY"
							? "repository"
							: rejected?.proposalDestination ===
									"REPOSITORY_COMMIT"
								? "commit"
								: "upload"
					}
					branch={repositoryTarget?.ref ?? null}
					commit={rejected?.sourceCommitSha ?? null}
					publishedCommit={
						published?.source === "REPOSITORY"
							? (published.sourceCommitSha ?? null)
							: null
					}
					onSyncAgain={
						repositorySync && offersSyncNow(repositorySync.state)
							? repositorySync.onSyncNow
							: undefined
					}
				/>
			) : null}
			{failed ? (
				<InstructionsFailedChecksBanner
					version={failed.version}
					publishedVersion={published?.version ?? null}
					mode={
						failed.source === "REPOSITORY" ? "repository" : "upload"
					}
					canRetry={canRetryFailed}
					stale={
						(failed.source === "UPLOAD" &&
							repositoryModeConfirmed) ||
						(failed.source === "REPOSITORY" && !repositoryBacked)
					}
					canEdit={canEdit}
					retrying={retry.isPending}
					onRetry={() =>
						retry.mutate({ projectId, snapshotId: failed.id })
					}
					onUploadAgain={canMutateDirect ? onReplaceClick : undefined}
				/>
			) : null}
			{published ? (
				<InstructionsDeferredScanAlerts
					published={published}
					onOpenHistory={() => setHistoryOpen(true)}
				/>
			) : null}
			{superseded && published ? (
				<InstructionsSupersededNotice
					superseded={superseded}
					publishedVersion={published.version}
					onOpenHistory={() => setHistoryOpen(true)}
				/>
			) : null}
			{published ? (
				<div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[280px_minmax(0,1fr)] xl:grid-cols-[340px_minmax(0,1fr)]">
					{/* Side by side only where the file keeps a reading width:
					    at md the app's sidebar leaves it ~110px beside a 340px
					    tree. */}
					<div>
						<InstructionsTree
							files={treeFiles}
							selectedPath={selectedFile}
							onSelect={setSelected}
							changes={
								baseComparison && marks.size > 0
									? {
											baseVersion:
												baseComparison.from.version,
											marks,
										}
									: undefined
							}
							leftOut={
								leftOut.listable
									? {
											files: leftOutFiles,
											shown: leftOutShown,
											onToggle: () =>
												setLeftOutShown(
													(shown) => !shown,
												),
										}
									: undefined
							}
						/>
					</div>
					<div
						data-onboarding-target="coding-instructions-file-view"
						className="min-h-0 min-w-0"
					>
						{fileView ? (
							<InstructionFileView
								key={projectId}
								projectId={projectId}
								snapshotId={fileView.snapshot.id}
								currentSnapshotId={published.id}
								path={fileView.path}
								change={
									fileView.current
										? (marks.get(fileView.path) ?? null)
										: null
								}
								publishedVersion={fileView.snapshot.version}
								canEdit={fileView.current && editable}
								canCommit={fileView.current && canCommit}
								canPropose={fileView.current && canPropose}
								repositoryTarget={repositoryTarget}
								existingPaths={treePaths}
								pausedReason={pausedReason}
								onChanged={onChanged}
								onCommitted={onCommitted}
								onDraftStateChange={onDraftStateChange}
								onOpenPath={setSelected}
								onRenamed={setSelected}
							/>
						) : fileListLoaded ? (
							<div className="flex h-full items-center justify-center rounded-lg border border-border text-muted-foreground">
								{t("selectFilePrompt")}
							</div>
						) : (
							// The list for this version is still on its way;
							// neither a file nor the prompt is the honest
							// answer yet.
							<div
								aria-busy="true"
								className="flex h-full items-center justify-center rounded-lg border border-border text-muted-foreground"
							>
								<Loader2Icon
									className="size-4 animate-spin"
									aria-hidden="true"
								/>
							</div>
						)}
					</div>
				</div>
			) : null}
			{(editable || canPropose) && published ? (
				<AddInstructionFileDialog
					projectId={projectId}
					baseSnapshotId={published.id}
					open={addFileOpen}
					onOpenChange={setAddFileOpen}
					folder={selectedFolder}
					proposalOnly={!editable && !canCommit}
					canPropose={editable || canCommit}
					canCommit={canCommit}
					repositoryTarget={repositoryTarget}
					canPublishBeforeScan={canPublishBeforeScan}
					onAdded={onChanged}
					onCommitted={onCommitted}
				/>
			) : null}
			{published && baseSnapshotId ? (
				<InstructionsCompareDialog
					projectId={projectId}
					fromSnapshotId={baseSnapshotId}
					toSnapshotId={published.id}
					publishedSide="to"
					open={compareOpen}
					onOpenChange={setCompareOpen}
				/>
			) : null}
			{repositoryConfiguration ? (
				// Mounted only while open: a fresh list every time, and nothing
				// is read from the repository until someone asks for it.
				historyOpen ? (
					<InstructionsCommits
						projectId={projectId}
						open
						onOpenChange={setHistoryOpen}
						provider={repositoryConfiguration.provider}
						branch={repositoryConfiguration.ref}
						rootPath={repositoryConfiguration.rootPath}
						published={{
							sha:
								published?.source === "REPOSITORY"
									? (published.sourceCommitSha ?? null)
									: null,
							version: published?.version ?? null,
						}}
						canRevert={Boolean(canEdit) && !readOnlyMode}
						pausedReason={pausedReason}
						canCompare={Boolean(canEdit)}
						syncRuns={syncRunsList}
						onChanged={onChanged}
						onCommitted={onCommitted}
					/>
				) : null
			) : (
				<InstructionsHistory
					projectId={projectId}
					open={historyOpen}
					onOpenChange={setHistoryOpen}
					snapshots={snapshots}
					publishedId={published?.id ?? null}
					// Both straight off the published row this view already holds.
					// History must not re-derive the version by matching the id
					// against the list: when the pointer query has failed there is
					// no id to match and the miss is indistinguishable from
					// "nothing published", which silently mislabels every rollback
					// as a forward publish.
					publishedVersion={published?.version ?? null}
					publishedUnknown={publishedUnknown}
					canMutate={canMutateDirect}
					canPublish={canMutateDirect}
					repositoryBacked={repositoryBacked}
					// An open sync run with no snapshot yet has no row in the list
					// to stand for the publish it will make.
					syncRunPendingPublish={
						repositorySync?.state.running &&
						(repositorySync.state.inFlightSnapshot ?? null) === null
					}
					syncRuns={syncRunsList}
					onChanged={onChanged}
				/>
			)}
			{canBrowseProposals ? (
				<InstructionProposals
					projectId={projectId}
					open={proposalsOpen}
					onOpenChange={setProposalsOpen}
					onChanged={onChanged}
					// Every card and its diff for a reviewer; Approve and
					// Reject only where this project can still publish them.
					canReview={Boolean(canReview)}
					canDecide={canReviewProposals}
					repositoryBacked={repositoryBacked}
					repositoryProvider={
						repositoryConfiguration?.provider ?? null
					}
				/>
			) : null}
			<InstructionsSettingsDialog
				projectId={projectId}
				open={settingsOpen}
				onOpenChange={setSettingsOpen}
				canEdit={canEdit}
				pausedReason={pausedReason}
				repositorySection={
					repositorySync ? (
						<RepositorySyncSettingsSection
							projectId={projectId}
							state={repositorySync.state}
							migration={repositorySync.migration}
							onChange={() => {
								setSettingsOpen(false);
								repositorySync.onConfigure();
							}}
							onChanged={async () => {
								await repositorySync.onChanged();
								setSettingsOpen(false);
							}}
							// Moving writes the sync configuration and carries the
							// published version into a repository: it needs both
							// create and update, a published version, and a project
							// whose source is confirmed to be uploads.
							onMove={
								canEdit &&
								canReview &&
								published &&
								!repositoryBacked &&
								repositorySync.onMove
									? () => {
											setSettingsOpen(false);
											repositorySync.onMove?.();
										}
									: undefined
							}
						/>
					) : null
				}
			/>
			{canConnectAgent && organizationId ? (
				<ConnectCliDialog
					open={connectOpen}
					onOpenChange={setConnectOpen}
					organizationId={organizationId}
					organizationSlug={organizationSlug ?? undefined}
					projectName={projectName}
					purpose="coding-instructions"
					projectId={projectId}
					// `localSetupRouteFor` above: the upload route for an
					// upload project, the repository's own `git clone` route
					// once a sync names one, or nothing while that is not yet
					// resolvable (Fizzy #2721).
					localSetup={localSetup}
				/>
			) : null}
		</InstructionsPageFrame>
	);
}
