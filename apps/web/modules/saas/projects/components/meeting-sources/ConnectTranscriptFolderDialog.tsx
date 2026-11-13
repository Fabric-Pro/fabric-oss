"use client";

/**
 * Choosing OneDrive folders whose transcripts a project imports (Fizzy #3507).
 *
 * The folders shown are the viewer's own OneDrive, read with their Microsoft
 * connection, which is also what the sync will read them with. Folders from
 * different places can be chosen in one go. The card's disclosure is shown
 * before the button that completes the connection, and there is no choice to
 * skip the files already there: connecting imports them.
 */

import { ORPCError } from "@orpc/client";
import { TRANSCRIPT_FOLDER_IMPORT_DISCLOSURE } from "@repo/utils";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Checkbox } from "@ui/components/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { ChevronRightIcon, FolderIcon, Loader2Icon } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";

interface FolderRef {
	driveId: string;
	itemId: string;
	name: string;
	webUrl?: string | null;
}

/** Where the browser is: the OneDrive root, then each folder opened. */
interface Level {
	name: string;
	driveId?: string;
	itemId?: string;
}

const ROOT: Level = { name: "My OneDrive" };

function keyOf(folder: { driveId: string; itemId: string }): string {
	return `${folder.driveId}:${folder.itemId}`;
}

export function ConnectTranscriptFolderDialog({
	projectId,
	organizationId,
	open,
	onOpenChange,
	onConnected,
}: {
	projectId: string;
	organizationId: string | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onConnected?: () => void;
}) {
	const queryClient = useQueryClient();
	const [path, setPath] = useState<Level[]>([ROOT]);
	const [selected, setSelected] = useState<Map<string, FolderRef>>(
		() => new Map(),
	);
	const [connecting, setConnecting] = useState(false);
	const currentCheckboxId = useId();
	const level = path[path.length - 1] ?? ROOT;

	const { data, isLoading, error } = useQuery({
		...orpc.projects.meetingTranscriptSync.browseFolders.queryOptions({
			input: {
				projectId,
				organizationId,
				driveId: level.driveId,
				itemId: level.itemId,
			},
		}),
		enabled: open,
		retry: false,
	});
	const notConnected =
		error instanceof ORPCError &&
		(error.data as { code?: string } | undefined)?.code ===
			"MICROSOFT_NOT_CONNECTED";

	const reset = () => {
		setPath([ROOT]);
		setSelected(new Map());
	};

	const toggle = (folder: FolderRef, checked: boolean) => {
		setSelected((previous) => {
			const next = new Map(previous);
			if (checked) {
				// Only what the connection takes, not the listing's extras.
				next.set(keyOf(folder), {
					driveId: folder.driveId,
					itemId: folder.itemId,
					name: folder.name,
					...(folder.webUrl !== undefined
						? { webUrl: folder.webUrl }
						: {}),
				});
			} else {
				next.delete(keyOf(folder));
			}
			return next;
		});
	};

	const connect = async () => {
		setConnecting(true);
		try {
			const { connected, importStarted } =
				await orpcClient.projects.meetingTranscriptSync.connectFolders({
					projectId,
					organizationId,
					folders: Array.from(selected.values()),
				});
			if (!importStarted) {
				toast.warning(
					"Connected, but importing could not be started. Use Reconnect on the folder to try again.",
				);
			} else
				toast.success(
					connected === 1
						? "Folder connected. Its transcripts are being imported."
						: `${connected} folders connected. Their transcripts are being imported.`,
				);
			await queryClient.invalidateQueries({
				queryKey: orpc.projects.meetingTranscriptSync.listFolders.key(),
			});
			onConnected?.();
			reset();
			onOpenChange(false);
		} catch (connectError) {
			toast.error(
				connectError instanceof Error && connectError.message
					? connectError.message
					: "The folders could not be connected.",
			);
		} finally {
			setConnecting(false);
		}
	};

	const folders = data?.folders ?? [];
	const currentFolder: FolderRef | null =
		level.driveId && level.itemId
			? { driveId: level.driveId, itemId: level.itemId, name: level.name }
			: null;

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next) {
					reset();
				}
				onOpenChange(next);
			}}
		>
			<DialogContent className="grid-cols-[minmax(0,1fr)] max-h-[90vh] max-w-2xl overflow-y-auto">
				<DialogHeader>
					<DialogTitle>Connect transcript folder</DialogTitle>
					<DialogDescription>
						Choose OneDrive folders that hold meeting transcripts.
						Only files directly in a folder are imported, not its
						subfolders.
					</DialogDescription>
				</DialogHeader>

				<nav
					aria-label="Folder path"
					className="flex flex-wrap items-center gap-1 text-sm"
				>
					{path.map((step, index) => (
						<span
							key={`${step.itemId ?? "root"}-${index}`}
							className="flex items-center gap-1"
						>
							{index > 0 && (
								<ChevronRightIcon
									aria-hidden="true"
									className="size-3.5 text-muted-foreground"
								/>
							)}
							{index === path.length - 1 ? (
								<span className="font-medium">{step.name}</span>
							) : (
								<button
									type="button"
									className="underline"
									onClick={() =>
										setPath(path.slice(0, index + 1))
									}
								>
									{step.name}
								</button>
							)}
						</span>
					))}
				</nav>

				{notConnected ? (
					<p
						role="alert"
						className="rounded border px-3 py-2 text-sm"
					>
						Connect your Microsoft account in Settings →
						Integrations to choose OneDrive folders.
					</p>
				) : error ? (
					<p role="alert" className="text-destructive text-sm">
						{error.message || "OneDrive could not be read."}
					</p>
				) : isLoading ? (
					<p className="flex items-center gap-2 text-muted-foreground text-sm">
						<Loader2Icon
							aria-hidden="true"
							className="size-4 animate-spin"
						/>
						Reading OneDrive…
					</p>
				) : (
					<div className="space-y-3">
						{currentFolder && (
							<div className="flex items-center gap-2 rounded border px-3 py-2 text-sm">
								<Checkbox
									id={currentCheckboxId}
									checked={selected.has(keyOf(currentFolder))}
									onCheckedChange={(checked) =>
										toggle(currentFolder, checked === true)
									}
								/>
								<label htmlFor={currentCheckboxId}>
									Use this folder —{" "}
									{data?.transcriptFileCount === 0
										? "no supported transcripts here yet"
										: `${data?.transcriptFileCount ?? 0} supported transcript${data?.transcriptFileCount === 1 ? "" : "s"} here`}
								</label>
							</div>
						)}
						{folders.length === 0 ? (
							<p className="text-muted-foreground text-sm">
								No folders inside this one.
							</p>
						) : (
							<ul className="divide-y rounded-lg border">
								{folders.map((folder) => (
									<li
										key={keyOf(folder)}
										className="flex items-center gap-3 px-3 py-2"
									>
										<Checkbox
											aria-label={`Select ${folder.name}`}
											checked={selected.has(
												keyOf(folder),
											)}
											onCheckedChange={(checked) =>
												toggle(folder, checked === true)
											}
										/>
										<button
											type="button"
											className="flex min-w-0 grow items-center gap-2 text-left text-sm"
											onClick={() =>
												setPath([
													...path,
													{
														name: folder.name,
														driveId: folder.driveId,
														itemId: folder.itemId,
													},
												])
											}
										>
											<FolderIcon
												aria-hidden="true"
												className="size-4 shrink-0 text-muted-foreground"
											/>
											<span className="truncate">
												{folder.name}
											</span>
											<span className="ml-auto shrink-0 text-muted-foreground text-xs">
												{folder.childCount} item
												{folder.childCount === 1
													? ""
													: "s"}
											</span>
										</button>
									</li>
								))}
							</ul>
						)}
						{data?.truncated && (
							<p className="text-muted-foreground text-xs">
								This folder holds more than can be listed here.
							</p>
						)}
					</div>
				)}

				{selected.size > 0 && (
					<p className="text-sm">
						Selected:{" "}
						{Array.from(selected.values())
							.map((folder) => folder.name)
							.join(", ")}
					</p>
				)}

				<p className="rounded border bg-muted/50 px-3 py-2 text-sm">
					{TRANSCRIPT_FOLDER_IMPORT_DISCLOSURE}
				</p>

				<DialogFooter>
					<Button
						variant="outline"
						onClick={() => onOpenChange(false)}
					>
						Cancel
					</Button>
					<Button
						onClick={connect}
						disabled={selected.size === 0 || connecting}
					>
						{connecting && (
							<Loader2Icon
								aria-hidden="true"
								className="mr-1.5 size-4 animate-spin"
							/>
						)}
						Connect{" "}
						{selected.size > 1
							? `${selected.size} folders`
							: "folder"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
