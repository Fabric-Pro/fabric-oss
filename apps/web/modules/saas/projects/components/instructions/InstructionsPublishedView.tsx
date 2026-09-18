"use client";

import type { InstructionRejection } from "@repo/database";
import { PageTourButton } from "@saas/get-started/components/PageTourButton";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { ConnectCliDialog } from "@saas/projects/components/cli-connection/ConnectCliDialog";
import { formatRelativeTime } from "@saas/shared/lib/format-time";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	CheckIcon,
	ClipboardCheckIcon,
	DownloadIcon,
	FilePlusIcon,
	HistoryIcon,
	Loader2Icon,
	PlugIcon,
	SettingsIcon,
	UploadIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { AddInstructionFileDialog } from "./AddInstructionFileDialog";
import { InstructionFileView } from "./InstructionFileView";
import { InstructionProposals } from "./InstructionProposals";
import { InstructionsHistory } from "./InstructionsHistory";
import { InstructionsRejectedBanner } from "./InstructionsRejectedBanner";
import { InstructionsSettingsDialog } from "./InstructionsSettingsDialog";
import { InstructionsTree, type TreeFile } from "./InstructionsTree";

const RECEIVING_STATUSES = new Set(["RECEIVING", "VALIDATING"]);

/**
 * `rejection` and `settingsFrozen` are read straight off a Prisma `Json`
 * column (see `ProjectInstructionSnapshot` in schema.prisma), so the oRPC
 * client infers them as generic JSON rather than their actual shape. This
 * type states the real shape the scan/validation activity writes; the
 * caller (`CodingInstructionsTab.tsx`) casts the raw query result into it
 * once, at the boundary, rather than every read site re-deriving it.
 */
export type InstructionsSnapshot = {
	id: string;
	version: number;
	status: string;
	source: string;
	fileCount: number;
	excludedCount: number;
	createdAt: string | Date;
	rejection?: InstructionRejection[] | null;
	user?: { id: string; name: string | null } | null;
	settingsFrozen?: { layer?: string } | null;
	/** Set when this version came from an in-tab edit rather than an upload. */
	baseSnapshotId?: string | null;
	/**
	 * The version this one was edited from. Unlike `baseSnapshotId`, which is
	 * `SetNull` in the database, this survives the base being deleted or
	 * pruned — so it, not the id, is what says a version is an edit at all.
	 */
	baseVersion?: number | null;
	/** Whether this version meant to publish itself when its checks passed. */
	publishOnReady?: boolean;
	/**
	 * When this version last held the published pointer, and null for one
	 * that never has. Nothing clears it, so it is the difference between an
	 * edit that never published and one that published and was then replaced
	 * — which is what the superseded line below turns on.
	 */
	publishedAt?: string | Date | null;
	/** Proposal lifecycle is rendered in the proposal review dialog. */
	proposalStatus?: "PENDING" | "APPROVED" | "REJECTED" | null;
};

function sourceLabel(source: string, t: (key: string) => string): string {
	return source === "REPOSITORY" ? t("sourceRepository") : t("sourceUpload");
}

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
	repositoryBacked = false,
	publishedUnknown = false,
}: {
	projectId: string;
	/** Named in the "Connect your agent" starter instruction. */
	projectName: string;
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
	 * Whether this viewer may change the published files. A UI gate only:
	 * `derive` re-checks `INSTRUCTION_CREATE` server-side on every save.
	 */
	canEdit?: boolean;
	/** Whether this viewer may approve or reject file proposals. */
	canReview?: boolean;
	/**
	 * The project's instructions come from its repository (spec §6.12), so
	 * they are changed in git and refreshed by sync. The server refuses an
	 * edit for such a project; hiding the actions is how the tab says so
	 * before someone tries.
	 */
	repositoryBacked?: boolean;
}) {
	const t = useTranslations("projects.codingInstructions.publishedView");
	const [selected, setSelected] = useState<string | null>(null);
	const [addFileOpen, setAddFileOpen] = useState(false);
	const [historyOpen, setHistoryOpen] = useState(false);
	const [proposalsOpen, setProposalsOpen] = useState(false);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [connectOpen, setConnectOpen] = useState(false);
	// Mirrors ProjectReadinessPanel: minting must fail closed. With no
	// organization id there is nothing to mint the key against. An invited
	// guest views this project under the HOST organization's thin record
	// (`isGuest: true`) — they have no membership row there, so the create
	// procedure's host-membership check (packages/api/modules/organizations/procedures/api-keys/create.ts)
	// would refuse them; hide the action instead of surfacing a FORBIDDEN.
	const { organizationId, organizationSlug, isGuest } =
		useOrganizationContext();
	const canConnectAgent = Boolean(organizationId) && !isGuest;

	// Editing is offered only on a published version: a derivation needs a
	// READY base with promoted objects to inherit, and the tab only ever shows
	// the published one's tree.
	const canMutateDirect = canEdit && !repositoryBacked;
	const editable = canMutateDirect && Boolean(published);
	const canReviewProposals = Boolean(canReview) && !repositoryBacked;
	const canPropose = !repositoryBacked && Boolean(published);
	const canBrowseProposals = canReviewProposals || canPropose;

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
	const failed =
		newest && newest.status === "FAILED" && newerThanPublished
			? newest
			: null;
	const checking =
		newest && RECEIVING_STATUSES.has(newest.status) && newerThanPublished
			? newest
			: null;
	// An edit that passed its checks but did NOT publish, because the version
	// it was made from stopped being the published one while it was being
	// checked. The auto-publish is a fast-forward for exactly this reason
	// (`publishInstructionSnapshot`, `requireBaseUnmoved`): publishing it
	// would have reverted whoever got there first, whose change this edit
	// never saw. The edit itself is intact and sits in History.
	//
	// `baseVersion` is what makes this an EDIT — `baseSnapshotId` is null
	// once the base has been deleted or pruned, which is one of the ways the
	// fast-forward is refused and precisely the case with nothing else to
	// explain it.
	//
	// Deliberately only about the NEWEST row. If the two edits finish out of
	// version order the stranded one is not the newest and says nothing here
	// — History still shows it as an unpublished version, which is the
	// durable answer; this line is the cheap one for the ordinary case.
	//
	// `publishedAt == null` is what keeps a ROLLBACK out of this line. After
	// a rollback from v9 to v7, v9 is still the newest READY row, is still
	// newer than the pointer, and its base is no longer published — every
	// condition above holds — but it was not stranded: it published, and a
	// person deliberately replaced it. Telling them it "was not published"
	// would be false, and would invite them to re-publish something they had
	// just chosen to leave behind.
	const supersededCandidate =
		newest &&
		newest.status === "READY" &&
		newerThanPublished &&
		newest.publishOnReady !== false &&
		typeof newest.baseVersion === "number" &&
		newest.baseSnapshotId !== published?.id
			? newest
			: null;
	const superseded =
		supersededCandidate &&
		(supersededCandidate.publishedAt ?? null) === null &&
		typeof supersededCandidate.baseVersion === "number"
			? {
					version: supersededCandidate.version,
					baseVersion: supersededCandidate.baseVersion,
				}
			: null;
	const rejectionRows = rejected?.rejection;
	const settingsLayer = published?.settingsFrozen?.layer;

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
	const treeFiles = (files.data ?? []) as TreeFile[];
	// The selection is a PATH, and a path outlives the version it was chosen
	// in: a Delete file publishes a new version without that path, the poll
	// swaps the version in, and the pane went on asking the new version for
	// a file it does not have ("Could not load this file"). So a path counts
	// as selected only while the version on screen lists it; otherwise the
	// pane shows the pick-a-file prompt. Derived rather than reset in an
	// effect: nothing has to run after render, and a path that comes back
	// in a later version is simply selected again.
	//
	// Gated on the list having LOADED, not merely on `files.data`: between a
	// version change and its list arriving `data` is undefined, and reading
	// that as "no files" flashed the pick-a-file prompt at someone whose file
	// was about to turn out to still be there.
	const fileListLoaded = files.isSuccess;
	const selectedFile =
		fileListLoaded &&
		selected !== null &&
		treeFiles.some((file) => file.path === selected)
			? selected
			: null;
	// The folder a new file lands in by default — the selected file's own
	// folder, which is where someone reading `.claude/skills/review/SKILL.md`
	// and pressing "Add file" means to put it. From the EFFECTIVE selection:
	// a folder the displayed version no longer has is not a default.
	const selectedFolder = selectedFile?.includes("/")
		? selectedFile.slice(0, selectedFile.lastIndexOf("/"))
		: null;

	const retry = useMutation(
		orpc.projects.instructions.finalize.mutationOptions({
			onSuccess: () => onChanged(),
			onError: (error) => toast.error(error.message),
		}),
	);

	const download = useMutation(
		orpc.projects.instructions.createDownloadUrl.mutationOptions({
			onSuccess: (data) => window.open(data.url, "_blank", "noopener"),
			onError: (error) => toast.error(error.message),
		}),
	);

	return (
		<div className="flex h-full min-h-[600px] flex-col gap-4">
			<div className="flex items-start justify-between gap-4">
				<div className="flex flex-col gap-0.5">
					<div className="flex items-center gap-2.5">
						<h1 className="font-semibold text-xl">
							{t("heading")}
						</h1>
						<PageTourButton pageId="coding-instructions" />
						{published ? (
							<span className="inline-flex items-center gap-1.5 rounded-full bg-success/10 px-2.5 py-0.5 font-medium text-success text-xs">
								<CheckIcon
									className="size-3"
									aria-hidden="true"
								/>
								{t("publishedBadge", {
									version: published.version,
								})}
							</span>
						) : null}
					</div>
					{published ? (
						<p className="text-muted-foreground">
							{t("publishedSummary", {
								name:
									published.user?.name ?? t("anonymousUser"),
								time: formatRelativeTime(published.createdAt),
								source: sourceLabel(published.source, t),
								fileCount: published.fileCount.toLocaleString(),
								excludedCount:
									published.excludedCount.toLocaleString(),
								reason: reasonLabel(settingsLayer, t),
							})}
						</p>
					) : checking ? null : (
						<p className="text-muted-foreground">
							{t("emptySummary")}
						</p>
					)}
					{/* Rendered outside the published/empty choice above, not
					    as a third branch of it: a REPLACE upload is checked
					    while the previous version is still published, so as a
					    branch this line was unreachable in the one case that
					    needs it and the tab looked untouched until the poll
					    swapped the new version in. `aria-live` because it
					    appears on a poll, with no interaction to announce it.
					    With nothing published yet it replaces the empty-state
					    line rather than sitting under it. Styled as a pill
					    in the primary colour with a spinner, like the
					    published badge above: as a plain muted sentence it
					    sat under the summary and read as part of it. The
					    element is always rendered so the live region exists
					    before the text arrives; the pill classes apply only
					    while there is something to say. */}
					<p
						aria-live="polite"
						className={
							checking
								? "inline-flex w-fit items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-1 font-medium text-primary text-sm"
								: "text-sm"
						}
					>
						{checking ? (
							<Loader2Icon
								className="size-3.5 animate-spin"
								aria-hidden="true"
							/>
						) : null}
						{checking ? t("checkingSummary") : ""}
					</p>
				</div>
				<div className="flex shrink-0 gap-2">
					{canBrowseProposals ? (
						<Button
							variant="outline"
							onClick={() => setProposalsOpen(true)}
						>
							<ClipboardCheckIcon
								className="size-4"
								aria-hidden="true"
							/>
							{t(
								canReviewProposals
									? "reviewProposalsButton"
									: "proposalsButton",
							)}
						</Button>
					) : null}
					<Button
						variant="outline"
						data-onboarding-target="coding-instructions-history"
						onClick={() => setHistoryOpen(true)}
					>
						<HistoryIcon className="size-4" aria-hidden="true" />
						{t("historyButton")}
					</Button>
					{published ? (
						<Button
							variant="outline"
							onClick={() =>
								download.mutate({
									projectId,
									snapshotId: published.id,
								})
							}
							disabled={download.isPending}
						>
							<DownloadIcon
								className="size-4"
								aria-hidden="true"
							/>
							{t("downloadButton")}
						</Button>
					) : null}
					<Button
						variant="outline"
						onClick={() => setSettingsOpen(true)}
					>
						<SettingsIcon className="size-4" aria-hidden="true" />
						{t("settingsButton")}
					</Button>
					{/* Fails closed: with no organization id there is nothing
					    to mint the key against, and an invited guest has no
					    membership row in the host organization to mint one
					    with either (mirrors ProjectReadinessPanel). */}
					{canConnectAgent ? (
						<Button
							variant="outline"
							data-onboarding-target="coding-instructions-connect"
							onClick={() => setConnectOpen(true)}
						>
							<PlugIcon className="size-4" aria-hidden="true" />
							{t("connectButton")}
						</Button>
					) : null}
					{editable || canPropose ? (
						<Button
							variant="outline"
							onClick={() => setAddFileOpen(true)}
						>
							<FilePlusIcon
								className="size-4"
								aria-hidden="true"
							/>
							{editable
								? t("addFileButton")
								: t("proposeFileButton")}
						</Button>
					) : null}
					{editable ? (
						<Button onClick={onReplaceClick}>
							<UploadIcon className="size-4" aria-hidden="true" />
							{published ? t("replaceButton") : t("uploadButton")}
						</Button>
					) : null}
				</div>
			</div>
			{rejectionRows ? (
				<InstructionsRejectedBanner
					rejection={rejectionRows}
					onUploadAgain={onReplaceClick}
				/>
			) : null}
			{failed ? (
				<div
					role="alert"
					className="flex flex-col gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-4"
				>
					<h2 className="font-semibold text-destructive">
						{t("failedTitle")}
					</h2>
					<p className="text-muted-foreground text-sm">
						{t("failedBody", { version: failed.version })}
					</p>
					{canMutateDirect ? (
						<div className="flex gap-2">
							<Button
								variant="outline"
								disabled={retry.isPending}
								onClick={() =>
									retry.mutate({
										projectId,
										snapshotId: failed.id,
									})
								}
							>
								{t("tryAgainButton")}
							</Button>
							<Button variant="ghost" onClick={onReplaceClick}>
								{t("uploadAgainButton")}
							</Button>
						</div>
					) : null}
				</div>
			) : null}
			{superseded && published ? (
				// `role="status"`, not `alert`: nothing was lost and there is
				// nothing to do urgently. It appears on a poll, with no
				// interaction of the viewer's own to announce it.
				<div
					role="status"
					className="flex flex-col gap-2 rounded-lg border border-border bg-muted/40 p-4"
				>
					<p className="text-muted-foreground text-sm">
						{t("supersededBody", {
							version: superseded.version,
							baseVersion: superseded.baseVersion,
							publishedVersion: published.version,
						})}
					</p>
					<div>
						<Button
							variant="outline"
							onClick={() => setHistoryOpen(true)}
						>
							<HistoryIcon
								className="size-4"
								aria-hidden="true"
							/>
							{t("supersededHistoryButton")}
						</Button>
					</div>
				</div>
			) : null}
			{published ? (
				<div className="grid min-h-0 flex-1 grid-cols-[340px_minmax(0,1fr)] gap-4">
					<div data-onboarding-target="coding-instructions-tree">
						<InstructionsTree
							files={treeFiles}
							selectedPath={selectedFile}
							onSelect={setSelected}
						/>
					</div>
					<div
						data-onboarding-target="coding-instructions-file-view"
						className="min-h-0 min-w-0"
					>
						{selectedFile ? (
							<InstructionFileView
								projectId={projectId}
								snapshotId={published.id}
								path={selectedFile}
								canEdit={editable}
								canPropose={canPropose}
								onChanged={onChanged}
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
					proposalOnly={!editable}
					canPropose={editable}
					onAdded={onChanged}
				/>
			) : null}
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
				onChanged={onChanged}
			/>
			{canBrowseProposals ? (
				<InstructionProposals
					projectId={projectId}
					open={proposalsOpen}
					onOpenChange={setProposalsOpen}
					onChanged={onChanged}
					canReview={canReviewProposals}
				/>
			) : null}
			<InstructionsSettingsDialog
				projectId={projectId}
				open={settingsOpen}
				onOpenChange={setSettingsOpen}
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
					// The `fabric instructions` line is offered only when
					// Fabric authors these files. A repository-backed project
					// refreshes them with `git pull`, and the CLI refuses to
					// install a hook that would fight it.
					localSyncAvailable={!repositoryBacked}
				/>
			) : null}
		</div>
	);
}
