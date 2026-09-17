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
	DownloadIcon,
	HistoryIcon,
	PlugIcon,
	SettingsIcon,
	UploadIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { InstructionFileView } from "./InstructionFileView";
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
}: {
	projectId: string;
	/** Named in the "Connect your agent" starter instruction. */
	projectName: string;
	published: InstructionsSnapshot | null;
	snapshots: InstructionsSnapshot[];
	onReplaceClick: () => void;
	onChanged: () => void;
}) {
	const t = useTranslations("projects.codingInstructions.publishedView");
	const [selected, setSelected] = useState<string | null>(null);
	const [historyOpen, setHistoryOpen] = useState(false);
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

	const newest = snapshots[0] ?? null;
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
					    line rather than sitting under it. */}
					<p
						aria-live="polite"
						className="text-muted-foreground text-sm"
					>
						{checking ? t("checkingSummary") : ""}
					</p>
				</div>
				<div className="flex shrink-0 gap-2">
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
					<Button onClick={onReplaceClick}>
						<UploadIcon className="size-4" aria-hidden="true" />
						{published ? t("replaceButton") : t("uploadButton")}
					</Button>
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
				</div>
			) : null}
			{published ? (
				<div className="grid min-h-0 flex-1 grid-cols-[340px_minmax(0,1fr)] gap-4">
					<div data-onboarding-target="coding-instructions-tree">
						<InstructionsTree
							files={treeFiles}
							selectedPath={selected}
							onSelect={setSelected}
						/>
					</div>
					<div
						data-onboarding-target="coding-instructions-file-view"
						className="min-h-0 min-w-0"
					>
						{selected ? (
							<InstructionFileView
								projectId={projectId}
								snapshotId={published.id}
								path={selected}
							/>
						) : (
							<div className="flex h-full items-center justify-center rounded-lg border border-border text-muted-foreground">
								{t("selectFilePrompt")}
							</div>
						)}
					</div>
				</div>
			) : null}
			<InstructionsHistory
				projectId={projectId}
				open={historyOpen}
				onOpenChange={setHistoryOpen}
				snapshots={snapshots}
				publishedId={published?.id ?? null}
				onChanged={onChanged}
			/>
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
				/>
			) : null}
		</div>
	);
}
