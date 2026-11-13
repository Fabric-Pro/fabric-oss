"use client";

/**
 * A project's connected OneDrive transcript folders (Fizzy #3507): where each
 * import stands, why a file was skipped, and the reconnect and disconnect
 * actions. Shown in the meeting settings card, which Settings → Knowledge,
 * the Meeting Digest and the Context tab all open, so the folders are managed
 * from the same place everywhere.
 */

import { useConfirmationAlert } from "@saas/shared/components/ConfirmationAlertProvider";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Progress } from "@ui/components/progress";
import { formatDistanceToNow } from "date-fns";
import {
	AlertTriangleIcon,
	ExternalLinkIcon,
	FolderIcon,
	PlusIcon,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ConnectTranscriptFolderDialog } from "./ConnectTranscriptFolderDialog";

const POLL_WHILE_IMPORTING_MS = 5_000;
/**
 * A scheduled read can find new files or a stopped connection at any time, so
 * connected folders are read again slowly even when nothing is importing.
 */
const POLL_WHILE_CONNECTED_MS = 60_000;

export interface TranscriptFolderRow {
	id: string;
	driveId: string;
	itemId: string;
	name: string;
	webUrl: string | null;
	connectedByName: string | null;
	lastSyncAt: string | Date | null;
	lastSyncError: string | null;
	discoveryComplete: boolean;
	counts: {
		discovered: number;
		imported: number;
		skipped: number;
		failed: number;
		inProgress: number;
	};
	problems: Array<{ name: string; status: string; reason: string | null }>;
}

/** Still finding files, or still importing them. */
export function isFolderImporting(folder: TranscriptFolderRow): boolean {
	return !folder.discoveryComplete || folder.counts.inProgress > 0;
}

/** The project's folders, read again while any of them is importing. */
export function useTranscriptFolders({
	projectId,
	organizationId,
}: {
	projectId: string;
	organizationId: string | null;
}) {
	const { data, isLoading } = useQuery({
		...orpc.projects.meetingTranscriptSync.listFolders.queryOptions({
			input: { projectId, organizationId },
		}),
		refetchInterval: (query) => {
			const folders = (query.state.data?.folders ??
				[]) as unknown as TranscriptFolderRow[];
			if (folders.some(isFolderImporting)) {
				return POLL_WHILE_IMPORTING_MS;
			}
			return folders.length > 0 ? POLL_WHILE_CONNECTED_MS : false;
		},
	});
	return {
		folders: (data?.folders ?? []) as unknown as TranscriptFolderRow[],
		isLoading,
	};
}

/** "12 found" while discovery is still going: the total is not final yet. */
export function describeFolderCounts(folder: TranscriptFolderRow): string {
	const { discovered, imported, skipped, failed, inProgress } = folder.counts;
	const found = folder.discoveryComplete
		? `${discovered} file${discovered === 1 ? "" : "s"}`
		: `${discovered} found so far`;
	return [
		found,
		`${imported} imported`,
		...(inProgress > 0 ? [`${inProgress} in progress`] : []),
		...(skipped > 0 ? [`${skipped} skipped`] : []),
		...(failed > 0 ? [`${failed} failed`] : []),
	].join(" · ");
}

function FolderRow({
	folder,
	canEdit,
	onReconnect,
	onDisconnect,
}: {
	folder: TranscriptFolderRow;
	canEdit: boolean;
	onReconnect: (folder: TranscriptFolderRow) => void;
	onDisconnect: (folder: TranscriptFolderRow) => void;
}) {
	const { discovered, imported, skipped, failed } = folder.counts;
	const settled = imported + skipped + failed;
	const empty = folder.discoveryComplete && discovered === 0;

	return (
		<li className="space-y-2 p-3">
			<div className="flex flex-wrap items-start justify-between gap-2">
				<div className="flex min-w-0 items-center gap-2">
					<FolderIcon
						aria-hidden="true"
						className="size-4 shrink-0 text-muted-foreground"
					/>
					<p className="truncate font-medium text-sm">
						{folder.name}
					</p>
					{folder.webUrl && (
						<a
							href={folder.webUrl}
							target="_blank"
							rel="noopener noreferrer"
							aria-label={`Open ${folder.name} in OneDrive`}
							className="text-muted-foreground hover:text-foreground"
						>
							<ExternalLinkIcon
								aria-hidden="true"
								className="size-3.5"
							/>
						</a>
					)}
				</div>
				{canEdit && (
					<Button
						variant="ghost"
						size="sm"
						onClick={() => onDisconnect(folder)}
					>
						Disconnect
					</Button>
				)}
			</div>

			{folder.lastSyncError && (
				<div
					role="alert"
					className="flex flex-wrap items-start gap-2 rounded border border-highlight/50 bg-highlight/10 px-3 py-2 text-sm"
				>
					<AlertTriangleIcon
						aria-hidden="true"
						className="mt-0.5 size-4 shrink-0 text-highlight"
					/>
					<p className="min-w-0 grow">{folder.lastSyncError}</p>
					{canEdit && (
						<Button
							variant="outline"
							size="sm"
							onClick={() => onReconnect(folder)}
						>
							Reconnect
						</Button>
					)}
				</div>
			)}

			{empty ? (
				<p className="text-muted-foreground text-sm">
					No files in this folder yet. Supported transcripts added to
					it are imported automatically.
				</p>
			) : (
				<div className="space-y-1">
					<p className="text-muted-foreground text-sm">
						{describeFolderCounts(folder)}
					</p>
					{isFolderImporting(folder) && discovered > 0 && (
						<Progress
							value={(settled / discovered) * 100}
							aria-label={`Imported ${settled} of ${discovered}${folder.discoveryComplete ? "" : " found so far"}`}
						/>
					)}
				</div>
			)}

			{folder.problems.length > 0 && (
				<ul className="space-y-0.5 text-muted-foreground text-xs">
					{folder.problems.map((problem) => (
						<li key={`${problem.name}-${problem.status}`}>
							{problem.name}: {problem.reason ?? "not imported"}
						</li>
					))}
				</ul>
			)}

			<p className="text-muted-foreground text-xs">
				{folder.connectedByName
					? `Read as ${folder.connectedByName}`
					: "Read as the person who connected it"}
				{folder.lastSyncAt
					? ` · checked ${formatDistanceToNow(new Date(folder.lastSyncAt), { addSuffix: true })}`
					: ""}
			</p>
		</li>
	);
}

export function TranscriptFolderSettings({
	projectId,
	organizationId,
	canEdit = true,
}: {
	projectId: string;
	organizationId: string | null;
	canEdit?: boolean;
}) {
	const queryClient = useQueryClient();
	const { confirm } = useConfirmationAlert();
	const [pickerOpen, setPickerOpen] = useState(false);
	const { folders, isLoading } = useTranscriptFolders({
		projectId,
		organizationId,
	});

	const refresh = () =>
		queryClient.invalidateQueries({
			queryKey: orpc.projects.meetingTranscriptSync.listFolders.key(),
		});

	const reconnect = async (folder: TranscriptFolderRow) => {
		try {
			await orpcClient.projects.meetingTranscriptSync.connectFolders({
				projectId,
				organizationId,
				folders: [
					{
						driveId: folder.driveId,
						itemId: folder.itemId,
						name: folder.name,
						webUrl: folder.webUrl,
					},
				],
			});
			toast.success(`${folder.name} reconnected`);
		} catch (error) {
			toast.error(
				error instanceof Error && error.message
					? error.message
					: `${folder.name} could not be reconnected.`,
			);
		}
		await refresh();
	};

	const disconnect = (folder: TranscriptFolderRow) =>
		confirm({
			title: `Disconnect ${folder.name}?`,
			message:
				"No more files are imported from it. Transcripts already imported stay in the project.",
			confirmLabel: "Disconnect",
			destructive: true,
			onConfirm: async () => {
				try {
					await orpcClient.projects.meetingTranscriptSync.disconnectFolder(
						{
							projectId,
							organizationId,
							folderId: folder.id,
						},
					);
				} catch {
					toast.error(`${folder.name} could not be disconnected.`);
					return;
				}
				await refresh();
			},
		});

	return (
		<div className="space-y-3 border-t p-6">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="min-w-0">
					<p className="font-medium text-foreground">
						OneDrive transcript folders
					</p>
					<p className="text-muted-foreground text-sm">
						Transcripts in a connected folder are imported, and so
						are new ones added to it.
					</p>
				</div>
				{canEdit && (
					<Button
						variant="outline"
						size="sm"
						onClick={() => setPickerOpen(true)}
					>
						<PlusIcon
							aria-hidden="true"
							className="mr-1.5 size-4"
						/>
						Connect folder
					</Button>
				)}
			</div>

			{folders.length > 0 ? (
				<ul className="divide-y rounded-lg border">
					{folders.map((folder) => (
						<FolderRow
							key={folder.id}
							folder={folder}
							canEdit={canEdit}
							onReconnect={reconnect}
							onDisconnect={disconnect}
						/>
					))}
				</ul>
			) : (
				!isLoading && (
					<p className="text-muted-foreground text-sm">
						No folders connected.
					</p>
				)
			)}

			{canEdit && (
				<ConnectTranscriptFolderDialog
					projectId={projectId}
					organizationId={organizationId}
					open={pickerOpen}
					onOpenChange={setPickerOpen}
				/>
			)}
		</div>
	);
}
