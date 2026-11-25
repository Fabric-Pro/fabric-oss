"use client";

/**
 * The Document folders section of the Context tab (Fizzy #2808): each
 * connected OneDrive, SharePoint or Google Drive folder with its place,
 * description, counts, one state and the next step.
 *
 * Editors also see who the folder is read as, the files that need attention,
 * and the actions: edit the description, sync now, reconnect, confirm held
 * removals and disconnect. Viewers and guests see the place, description,
 * counts and state only; the list never sends them the reader or the drive.
 */

import { useFeatureFlag } from "@saas/shared/components/FeatureFlagProvider";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQueryClient } from "@tanstack/react-query";
import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ui/components/alert-dialog";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import { Label } from "@ui/components/label";
import { Progress } from "@ui/components/progress";
import { Textarea } from "@ui/components/textarea";
import { cn } from "@ui/lib";
import { formatDistanceToNow } from "date-fns";
import {
	AlertTriangleIcon,
	Building2Icon,
	CheckCircle2Icon,
	ClockIcon,
	CloudIcon,
	ExternalLinkIcon,
	Loader2Icon,
	MoreHorizontalIcon,
	PauseCircleIcon,
} from "lucide-react";
import { type ComponentType, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { DocumentFolderFiles } from "./DocumentFolderFiles";
import {
	accountFor,
	connectAccount,
	connectionName,
	DESCRIPTION_MAX,
	type DocumentFolder,
	type FolderState,
	errorCode,
	filesLabel,
	folderPlace,
	folderState,
	googleDriveConnectNeeded,
	isEditorFolder,
	isMicrosoftNotConnected,
	messageOf,
	providerName,
	useDocumentFolders,
	useReturnFocus,
} from "./use-document-folders";

type ConfirmKind = "reconnect" | "disconnect" | "confirmRemovals";

interface StateCopy {
	label: string;
	next: string;
	icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
	tone: "busy" | "problem" | "waiting" | "done";
}

const IMPORTING_NEXT = "Files appear in the context list as they are imported.";

function problemCopy(
	code: string,
	provider: string,
	editorReader: string | null,
): { label: string; editorNext: string; viewerNext: string } {
	const place = providerName(provider);
	switch (code) {
		case "RECONNECT":
			return {
				label: "Reconnect needed",
				editorNext: `Fabric can no longer read it with ${editorReader ?? "its reader"}'s ${connectionName(provider)} connection. Reconnect to read it with yours.`,
				viewerNext: "A project editor needs to reconnect it.",
			};
		case "NO_ACCESS":
			return {
				label: `No access to this folder in ${place}`,
				editorNext:
					"Its reader can no longer open it. Reconnect with an account that can, or disconnect it.",
				viewerNext: "A project editor needs to reconnect it.",
			};
		case "FOLDER_GONE":
			return {
				label: `Folder not found in ${place}`,
				editorNext:
					"It was moved or deleted. Disconnect it, then connect the folder where it is now.",
				viewerNext: "A project editor needs to connect it again.",
			};
		case "SYNC_START_FAILED":
			return {
				label: "Reading could not start",
				editorNext: "Use Sync now to try again.",
				viewerNext: "A project editor can try again.",
			};
		default:
			return {
				label: "Reading stopped",
				editorNext: "Use Sync now or Reconnect to try again.",
				viewerNext: "A project editor can try again.",
			};
	}
}

function stateCopy(
	folder: DocumentFolder,
	state: FolderState,
	canEdit: boolean,
): StateCopy {
	switch (state.kind) {
		case "reading":
			return {
				label: "Reading folder",
				next: IMPORTING_NEXT,
				icon: Loader2Icon,
				tone: "busy",
			};
		case "importing":
			return {
				label: `Importing ${filesLabel(state.count)}`,
				next: IMPORTING_NEXT,
				icon: Loader2Icon,
				tone: "busy",
			};
		case "problem": {
			const copy = problemCopy(
				state.code,
				folder.provider,
				isEditorFolder(folder) ? folder.readerName : null,
			);
			return {
				label: copy.label,
				next: canEdit ? copy.editorNext : copy.viewerNext,
				icon: AlertTriangleIcon,
				tone: "problem",
			};
		}
		case "throttled":
			return {
				label: `${providerName(folder.provider)} asked Fabric to slow down`,
				// A next read time is named only while it is still ahead.
				next:
					state.nextReadAfter &&
					state.nextReadAfter.getTime() > Date.now()
						? `The next read is ${formatDistanceToNow(state.nextReadAfter, { addSuffix: true })}. Removals wait until a complete read.`
						: "Removals wait until the next complete read.",
				icon: ClockIcon,
				tone: "waiting",
			};
		case "held":
			return {
				label: `${filesLabel(state.count)} ${state.count === 1 ? "is" : "are"} no longer in the folder`,
				next: canEdit
					? "Their context stays until you confirm the removal."
					: "Their context stays until a project editor confirms the removal.",
				icon: PauseCircleIcon,
				tone: "waiting",
			};
		case "paused":
			return state.code === "TOO_LARGE"
				? {
						label: "Removals paused: the folder holds too many files",
						next: "Fabric lists at most 5,000 items in a folder. Connect a narrower folder so removals stay in step.",
						icon: PauseCircleIcon,
						tone: "waiting",
					}
				: {
						label: "Removals paused: part of the folder could not be read",
						next: "Removals resume after a complete read.",
						icon: PauseCircleIcon,
						tone: "waiting",
					};
		case "upToDate":
			return {
				label: "Up to date",
				next: "Fabric checks the folder again every 30 minutes.",
				icon: CheckCircle2Icon,
				tone: "done",
			};
	}
}

function describeCounts(folder: DocumentFolder): string {
	const { found, imported, skipped, failed } = folder.counts;
	return [
		`${found} found${folder.discoveryComplete ? "" : " so far"}`,
		`${imported} imported`,
		`${skipped} skipped`,
		`${failed} failed`,
	].join(" · ");
}

function placeLine(folder: DocumentFolder): string {
	const path =
		folder.drivePath && folder.drivePath !== "/"
			? ` · ${folder.drivePath}`
			: "";
	return `${folderPlace(folder)}${path}`;
}

function FolderCard({
	folder,
	canEdit,
	syncStarting,
	refusal,
	onEdit,
	onSyncNow,
	onConfirm,
}: {
	folder: DocumentFolder;
	canEdit: boolean;
	/** Why the last reconnect was refused, such as a folder the editor cannot open. */
	refusal: string | null;
	/** A Sync now request is on its way; it reads every folder. */
	syncStarting: boolean;
	onEdit: (opener: HTMLElement | null) => void;
	onSyncNow: () => Promise<void>;
	onConfirm: (kind: ConfirmKind, opener: HTMLElement | null) => void;
}) {
	const titleId = useId();
	const syncReasonId = useId();
	const menuTrigger = useRef<HTMLButtonElement>(null);
	const state = folderState(folder);
	const copy = stateCopy(folder, state, canEdit);
	const StateIcon = copy.icon;
	const ProviderIcon =
		folder.provider === "sharepoint" ? Building2Icon : CloudIcon;
	const editor = canEdit && isEditorFolder(folder) ? folder : null;
	const reading = folder.reading;
	const { found, imported, skipped, failed, excluded } = folder.counts;
	const settled = imported + skipped + failed + excluded;
	const busy = state.kind === "reading" || state.kind === "importing";

	return (
		<li
			aria-labelledby={titleId}
			className="space-y-3 rounded-lg border bg-card p-4"
		>
			<div className="flex flex-wrap items-start justify-between gap-2">
				<div className="flex min-w-0 items-start gap-2">
					<ProviderIcon
						aria-hidden="true"
						className="mt-0.5 size-4 shrink-0 text-muted-foreground"
					/>
					<div className="min-w-0">
						<div className="flex items-center gap-1.5">
							<h3
								id={titleId}
								className="truncate font-medium text-sm"
							>
								{folder.name}
							</h3>
							{editor?.webUrl && (
								<a
									href={editor.webUrl}
									target="_blank"
									rel="noopener noreferrer"
									aria-label={`Open ${folder.name} in ${providerName(folder.provider)}`}
									className="text-muted-foreground hover:text-foreground"
								>
									<ExternalLinkIcon
										aria-hidden="true"
										className="size-3.5"
									/>
								</a>
							)}
						</div>
						<p className="break-all text-muted-foreground text-xs">
							{placeLine(folder)}
						</p>
					</div>
				</div>
				{editor && (
					<>
						<div className="hidden flex-wrap gap-2 sm:flex">
							<Button
								variant="outline"
								size="sm"
								onClick={(event) => onEdit(event.currentTarget)}
							>
								Edit description
							</Button>
							<Button
								variant="outline"
								size="sm"
								disabled={reading || syncStarting}
								aria-describedby={
									reading ? syncReasonId : undefined
								}
								onClick={onSyncNow}
							>
								Sync now
							</Button>
							<Button
								variant="outline"
								size="sm"
								onClick={(event) =>
									onConfirm("reconnect", event.currentTarget)
								}
							>
								Reconnect
							</Button>
							<Button
								variant="ghost"
								size="sm"
								className="text-destructive"
								onClick={(event) =>
									onConfirm("disconnect", event.currentTarget)
								}
							>
								Disconnect
							</Button>
						</div>
						<div className="sm:hidden">
							<DropdownMenu modal={false}>
								<DropdownMenuTrigger asChild>
									<Button
										ref={menuTrigger}
										variant="outline"
										size="icon-sm"
										aria-label={`Actions for ${folder.name}`}
									>
										<MoreHorizontalIcon aria-hidden="true" />
									</Button>
								</DropdownMenuTrigger>
								<DropdownMenuContent align="end">
									<DropdownMenuItem
										onSelect={() =>
											onEdit(menuTrigger.current)
										}
									>
										Edit description
									</DropdownMenuItem>
									<DropdownMenuItem
										disabled={reading || syncStarting}
										onSelect={() => {
											void onSyncNow();
										}}
									>
										Sync now
									</DropdownMenuItem>
									<DropdownMenuItem
										onSelect={() =>
											onConfirm(
												"reconnect",
												menuTrigger.current,
											)
										}
									>
										Reconnect
									</DropdownMenuItem>
									<DropdownMenuItem
										className="text-destructive focus:text-destructive"
										onSelect={() =>
											onConfirm(
												"disconnect",
												menuTrigger.current,
											)
										}
									>
										Disconnect
									</DropdownMenuItem>
								</DropdownMenuContent>
							</DropdownMenu>
						</div>
					</>
				)}
			</div>

			{folder.description ? (
				<p className="whitespace-pre-wrap text-sm">
					{folder.description}
				</p>
			) : (
				<p className="text-muted-foreground text-sm">No description.</p>
			)}

			<div
				className={cn(
					"flex items-start gap-2 rounded-md border px-3 py-2 text-sm",
					copy.tone === "problem" &&
						"border-highlight/50 bg-highlight/10",
				)}
			>
				<StateIcon
					aria-hidden={true}
					className={cn(
						"mt-0.5 size-4 shrink-0",
						copy.tone === "busy" &&
							"text-muted-foreground motion-safe:animate-spin",
						copy.tone === "problem" && "text-highlight-ink",
						copy.tone === "waiting" && "text-muted-foreground",
						copy.tone === "done" && "text-success",
					)}
				/>
				<div className="min-w-0 grow space-y-1">
					<p className="font-medium">{copy.label}</p>
					<p className="text-muted-foreground">{copy.next}</p>
					{editor && refusal && (
						<p role="alert" className="text-destructive">
							{refusal}
						</p>
					)}
					{editor && reading && (
						<p id={syncReasonId} className="text-muted-foreground">
							A read is running. Sync now is available when it
							ends.
						</p>
					)}
					{editor && state.kind === "held" && (
						<Button
							variant="outline"
							size="sm"
							onClick={(event) =>
								onConfirm(
									"confirmRemovals",
									event.currentTarget,
								)
							}
						>
							Confirm removal
						</Button>
					)}
				</div>
			</div>

			<div className="space-y-1">
				<p className="text-muted-foreground text-sm">
					{describeCounts(folder)}
				</p>
				{busy && found > 0 && (
					<Progress
						value={Math.min(100, (settled / found) * 100)}
						aria-label={`${settled} of ${found} files done`}
					/>
				)}
			</div>

			<p className="text-muted-foreground text-xs">
				{editor
					? `Read as ${editor.readerName ?? "the person who connected it"} · `
					: ""}
				{folder.lastReadAt
					? `Last read ${formatDistanceToNow(new Date(folder.lastReadAt), { addSuffix: true })}`
					: "Not read yet"}
			</p>

			{editor && (
				<DocumentFolderFiles
					provider={folder.provider}
					attention={editor.attention}
					counts={folder.counts}
				/>
			)}
		</li>
	);
}

function DescriptionDialog({
	folder,
	open,
	onOpenChange,
	onCloseAutoFocus,
	onSave,
}: {
	folder: DocumentFolder;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onCloseAutoFocus: (event: Event) => void;
	onSave: (description: string | null) => Promise<boolean>;
}) {
	const fieldId = useId();
	const countId = useId();
	const [text, setText] = useState(folder.description ?? "");
	const [saving, setSaving] = useState(false);
	const tooLong = text.length > DESCRIPTION_MAX;

	const save = async () => {
		setSaving(true);
		try {
			const trimmed = text.trim();
			if (await onSave(trimmed ? trimmed : null)) {
				onOpenChange(false);
			}
		} finally {
			setSaving(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				className="sm:max-w-md"
				onCloseAutoFocus={onCloseAutoFocus}
			>
				<DialogHeader>
					<DialogTitle>Describe {folder.name}</DialogTitle>
					<DialogDescription>
						The AI reads this as guidance for every file imported
						from this folder. A file's own instructions, set in the
						context list, win over it.
					</DialogDescription>
				</DialogHeader>
				<div className="grid gap-2">
					<div className="flex items-center justify-between">
						<Label htmlFor={fieldId}>Description</Label>
						<span
							id={countId}
							className={cn(
								"text-xs",
								tooLong
									? "text-destructive"
									: "text-muted-foreground",
							)}
						>
							{text.length}/{DESCRIPTION_MAX}
						</span>
					</div>
					<Textarea
						id={fieldId}
						value={text}
						onChange={(event) => setText(event.target.value)}
						maxLength={DESCRIPTION_MAX}
						rows={4}
						aria-describedby={countId}
						aria-invalid={tooLong || undefined}
					/>
				</div>
				<DialogFooter>
					<Button variant="ghost" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button
						onClick={save}
						disabled={tooLong || saving}
						loading={saving}
					>
						Save
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** Files waiting for an editor to confirm their removal; 0 when none are. */
function heldRemovals(folder: DocumentFolder): number {
	return folder.pausedRemovalsCode === "MASS_REMOVAL"
		? (folder.heldRemovalCount ?? 0)
		: 0;
}

function confirmCopy(
	kind: ConfirmKind,
	folder: DocumentFolder,
	removalCount: number,
) {
	switch (kind) {
		case "reconnect":
			return {
				title: `Reconnect ${folder.name}?`,
				body: `You become this folder's reader: Fabric reads it with your ${connectionName(folder.provider)} connection from now on, and the files imported from it become yours. Its description stays.`,
				action: "Reconnect",
				destructive: false,
			};
		case "disconnect":
			return {
				title: `Disconnect ${folder.name}?`,
				body: "Fabric stops reading it. Files already imported stay in the project as ordinary context, but this folder's description no longer applies to them.",
				action: "Disconnect",
				destructive: true,
			};
		case "confirmRemovals": {
			const count = removalCount;
			if (count === 0) {
				return {
					title: "Nothing to remove",
					body: "The folder changed, and no files are waiting to be removed now.",
					action: "Remove files",
					destructive: true,
				};
			}
			return {
				title: `Remove ${filesLabel(count)}?`,
				body: `${count === 1 ? "It is" : "They are"} no longer in the folder. Removing deletes ${count === 1 ? "its" : "their"} context, search entries and stored copies from the project.`,
				action: "Remove files",
				destructive: true,
			};
		}
	}
}

interface DocumentFolderListProps {
	projectId: string;
	organizationId: string | null;
	/**
	 * Told the ids of the connected folders whenever they change, so the
	 * context list can tell a file from a connected folder from one whose
	 * folder was disconnected.
	 */
	onConnectedFolderIdsChange?: (folderIds: readonly string[]) => void;
}

function DocumentFolderSection({
	projectId,
	organizationId,
	onConnectedFolderIdsChange,
}: DocumentFolderListProps) {
	const queryClient = useQueryClient();
	const headingId = useId();
	const { view, folders, expectRead } = useDocumentFolders({
		projectId,
		organizationId,
	});
	// Keyed on the ids, not the array, which is new on every render.
	const connectedIds = folders.map((folder) => folder.id).join("\n");
	useEffect(() => {
		onConnectedFolderIdsChange?.(
			connectedIds ? connectedIds.split("\n") : [],
		);
	}, [connectedIds, onConnectedFolderIdsChange]);
	const canEdit = view === "editor";
	const editFocus = useReturnFocus();
	const confirmFocus = useReturnFocus();
	const [editing, setEditing] = useState<DocumentFolder | null>(null);
	const [confirming, setConfirming] = useState<{
		kind: ConfirmKind;
		folder: DocumentFolder;
		/** The held removals the confirmation showed when it opened. */
		openedCount: number;
	} | null>(null);
	const [confirmPending, setConfirmPending] = useState(false);
	// The server refused a removal because the held files changed.
	const [removalsChanged, setRemovalsChanged] = useState(false);
	// What the confirmation shows, from the folder as the list last read it.
	// Held while a request runs and through the close, so the count the
	// editor approves is the one sent and the dialog does not change as it
	// goes.
	const shownConfirm = useRef<{
		kind: ConfirmKind;
		folder: DocumentFolder;
		openedCount: number;
		removalCount: number;
	} | null>(null);
	if (confirming && !confirmPending) {
		const live =
			folders.find((folder) => folder.id === confirming.folder.id) ??
			confirming.folder;
		shownConfirm.current = {
			...confirming,
			folder: live,
			removalCount: heldRemovals(live),
		};
	}

	const refresh = () =>
		queryClient.invalidateQueries({
			queryKey: orpc.projects.documentFolders.list.key(),
		});

	const scope = { projectId, organizationId };

	// Why a folder's last reconnect was refused, by folder id, shown on its
	// card until a reconnect succeeds.
	const [refusals, setRefusals] = useState<Record<string, string>>({});
	const setRefusal = (folderId: string, message: string | null) =>
		setRefusals((previous) => {
			const { [folderId]: _cleared, ...rest } = previous;
			return message ? { ...rest, [folderId]: message } : rest;
		});

	// Aborted when the section goes away, so a connect flow still
	// open in its popup neither retries nor toasts on another screen.
	const mounted = useRef<AbortController | null>(null);
	useEffect(() => {
		const controller = new AbortController();
		mounted.current = controller;
		return () => controller.abort();
	}, []);

	// Sync now reads every folder, so one request at a time for the whole
	// section. The ref stops a second click before the disabled state renders.
	const [syncStarting, setSyncStarting] = useState(false);
	const syncInFlight = useRef(false);
	const syncNow = async () => {
		if (syncInFlight.current) {
			return;
		}
		syncInFlight.current = true;
		setSyncStarting(true);
		try {
			try {
				await orpcClient.projects.documentFolders.syncNow(scope);
				expectRead();
				toast.success("Reading the project's document folders now.");
			} catch (error) {
				toast.error(messageOf(error, "The sync could not be started."));
			}
			await refresh();
		} finally {
			syncInFlight.current = false;
			setSyncStarting(false);
		}
	};

	const saveDescription = async (
		folder: DocumentFolder,
		description: string | null,
	) => {
		try {
			await orpcClient.projects.documentFolders.updateDescription({
				...scope,
				folderId: folder.id,
				description,
			});
		} catch (error) {
			toast.error(
				messageOf(error, "The description could not be saved."),
			);
			return false;
		}
		toast.success("Description saved.");
		await refresh();
		return true;
	};

	const reconnect = async (folder: DocumentFolder) => {
		const call = () =>
			orpcClient.projects.documentFolders.reconnect({
				...scope,
				folderId: folder.id,
			});
		const failed = `${folder.name} could not be reconnected.`;
		const account = connectionName(folder.provider);
		// A Google Drive folder the editor cannot open is said on its card,
		// where Reconnect stays; any other refusal is a toast.
		const refuse = (error: unknown) => {
			if (errorCode(error) === "GOOGLE_DRIVE_FOLDER_UNREADABLE") {
				setRefusal(folder.id, messageOf(error, failed));
			} else {
				toast.error(messageOf(error, failed));
			}
		};
		let result: Awaited<ReturnType<typeof call>>;
		try {
			result = await call();
		} catch (error) {
			const needsConnect =
				folder.provider === "googledrive"
					? googleDriveConnectNeeded(error) !== null
					: isMicrosoftNotConnected(error);
			if (!needsConnect) {
				refuse(error);
				return;
			}
			// No connection to read it with: connect one the way
			// Settings → Integrations does, then try again.
			const signal = mounted.current?.signal;
			let connected: boolean;
			try {
				connected = await connectAccount(
					accountFor(folder.provider),
					organizationId,
					signal,
				);
			} catch (connectError) {
				if (signal?.aborted) {
					return;
				}
				toast.error(
					messageOf(
						connectError,
						`${account} could not be connected.`,
					),
				);
				return;
			}
			if (signal?.aborted) {
				return;
			}
			if (!connected) {
				toast.error(
					`${account} was not connected, so the folder was not reconnected.`,
				);
				return;
			}
			try {
				result = await call();
			} catch (retryError) {
				refuse(retryError);
				return;
			}
		}
		setRefusal(folder.id, null);
		expectRead();
		if (result.importStarted) {
			toast.success(`${folder.name} reconnected. Reading it now.`);
		} else {
			toast.warning(
				`${folder.name} reconnected, but reading could not be started. Use Sync now to try again.`,
			);
		}
		await refresh();
	};

	const disconnect = async (folder: DocumentFolder) => {
		try {
			await orpcClient.projects.documentFolders.disconnect({
				...scope,
				folderId: folder.id,
			});
		} catch (error) {
			toast.error(
				messageOf(error, `${folder.name} could not be disconnected.`),
			);
			return;
		}
		toast.success(
			`${folder.name} disconnected. Its files stay in the project.`,
		);
		await refresh();
	};

	/**
	 * Removes the held files the editor was shown, if they are still the ones
	 * held. "changed" when the server holds a different set now: the list is
	 * read again and the editor is asked again with the new count.
	 */
	const confirmRemovals = async (
		folder: DocumentFolder,
		expectedCount: number,
	): Promise<"done" | "changed"> => {
		try {
			const result =
				await orpcClient.projects.documentFolders.confirmRemovals({
					...scope,
					folderId: folder.id,
					expectedCount,
				});
			if (result.status === "confirmed") {
				expectRead();
				toast.success(
					`${filesLabel(result.retired)} removed from the project.`,
				);
			} else if (
				result.status === "stale" &&
				result.heldRemovalCount > 0
			) {
				setRemovalsChanged(true);
				await refresh();
				return "changed";
			} else {
				toast.info("Nothing is waiting to be removed.");
			}
		} catch (error) {
			toast.error(
				messageOf(error, "The files could not be removed. Try again."),
			);
		}
		await refresh();
		return "done";
	};

	const runConfirmed = async () => {
		const current = shownConfirm.current;
		if (!current || confirmPending) {
			return;
		}
		setConfirmPending(true);
		let keepOpen = false;
		try {
			if (current.kind === "reconnect") {
				await reconnect(current.folder);
			} else if (current.kind === "disconnect") {
				await disconnect(current.folder);
			} else {
				keepOpen =
					(await confirmRemovals(
						current.folder,
						current.removalCount,
					)) === "changed";
			}
		} finally {
			setConfirmPending(false);
			if (!keepOpen) {
				setConfirming(null);
			}
		}
	};

	if (folders.length === 0) {
		return null;
	}

	const shown = shownConfirm.current;
	const shownConfirmCopy = shown
		? confirmCopy(shown.kind, shown.folder, shown.removalCount)
		: null;
	const changedNotice =
		shown?.kind === "confirmRemovals" &&
		shown.removalCount > 0 &&
		(removalsChanged || shown.removalCount !== shown.openedCount)
			? `The folder changed — ${filesLabel(shown.removalCount)} ${shown.removalCount === 1 ? "is" : "are"} now waiting to be removed.`
			: null;
	const announcement = folders
		.map(
			(folder) =>
				`${folder.name}: ${stateCopy(folder, folderState(folder), canEdit).label}`,
		)
		.join(". ");

	return (
		<section aria-labelledby={headingId} className="space-y-3">
			<div>
				<h2 id={headingId} className="font-semibold text-base">
					Document folders
				</h2>
				<p className="text-muted-foreground text-sm">
					Supported files in these OneDrive, SharePoint and Google
					Drive folders are imported as project context and kept in
					step with the folder.
				</p>
			</div>
			<output aria-live="polite" className="sr-only">
				{announcement}
			</output>
			<ul className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-2">
				{folders.map((folder) => (
					<FolderCard
						key={folder.id}
						folder={folder}
						canEdit={canEdit}
						syncStarting={syncStarting}
						refusal={refusals[folder.id] ?? null}
						onEdit={(opener) => {
							editFocus.remember(opener);
							setEditing(folder);
						}}
						onSyncNow={syncNow}
						onConfirm={(kind, opener) => {
							confirmFocus.remember(opener);
							setRemovalsChanged(false);
							setConfirming({
								kind,
								folder,
								openedCount: heldRemovals(folder),
							});
						}}
					/>
				))}
			</ul>

			{/* Mounted only while open, so each opening starts from the
			    stored description rather than a draft that was cancelled. */}
			{canEdit && editing && (
				<DescriptionDialog
					key={editing.id}
					folder={editing}
					open
					onOpenChange={(open) => {
						if (!open) {
							setEditing(null);
						}
					}}
					onCloseAutoFocus={editFocus.onCloseAutoFocus}
					onSave={(description) =>
						saveDescription(editing, description)
					}
				/>
			)}

			{canEdit && shownConfirmCopy && (
				<AlertDialog
					open={confirming !== null}
					onOpenChange={(open) => {
						if (!open && !confirmPending) {
							setConfirming(null);
						}
					}}
				>
					<AlertDialogContent
						onCloseAutoFocus={confirmFocus.onCloseAutoFocus}
					>
						<AlertDialogHeader>
							<AlertDialogTitle>
								{shownConfirmCopy.title}
							</AlertDialogTitle>
							<AlertDialogDescription>
								{shownConfirmCopy.body}
							</AlertDialogDescription>
							{changedNotice && (
								<p role="alert" className="font-medium text-sm">
									{changedNotice}
								</p>
							)}
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel disabled={confirmPending}>
								Cancel
							</AlertDialogCancel>
							<Button
								variant={
									shownConfirmCopy.destructive
										? "destructive"
										: "default"
								}
								onClick={runConfirmed}
								loading={confirmPending}
								disabled={
									shown?.kind === "confirmRemovals" &&
									shown.removalCount === 0
								}
							>
								{shownConfirmCopy.action}
							</Button>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			)}
		</section>
	);
}

/**
 * The section, while the feature is on for the project's organization. Off,
 * nothing renders and nothing is read.
 */
export function DocumentFolderList(props: DocumentFolderListProps) {
	const enabled = useFeatureFlag("CLOUD_DRIVE_FOLDERS");
	return enabled ? <DocumentFolderSection {...props} /> : null;
}
