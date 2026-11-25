"use client";

/**
 * Choosing OneDrive, SharePoint or Google Drive folders whose files a project
 * imports as context (Fizzy #2808).
 *
 * Browsed with the caller's own Microsoft or Google Drive connection, which
 * also reads the folders from then on. Microsoft: My OneDrive, or SharePoint
 * through followed sites and site search, then a site's document libraries,
 * then their folders. Google Drive: My Drive or a shared drive, then their
 * folders, whose overlap is judged by folder id. Folders
 * from any place are chosen together, each with an optional description. A
 * folder inside or holding one already chosen or connected cannot be chosen,
 * and says why. The disclosure is on screen before the button that connects.
 *
 * Built beside the transcript-folder picker rather than sharing its browser:
 * that one lists one OneDrive level with plain checkboxes, and changing it to
 * this tree would change how transcript folders are chosen.
 */

import { CONTEXT_UPLOAD_FORMAT_LABELS } from "@repo/utils";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQueryClient } from "@tanstack/react-query";
import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbList,
	BreadcrumbPage,
	BreadcrumbSeparator,
} from "@ui/components/breadcrumb";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Label } from "@ui/components/label";
import { Textarea } from "@ui/components/textarea";
import { cn } from "@ui/lib";
import {
	Fragment,
	type RefObject,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import {
	FolderLevel,
	GooglePlacesLevel,
	PlacesLevel,
	SharedDrivesLevel,
	SharePointLevel,
	SiteLevel,
} from "./folder-picker/FolderPicker";
import {
	type Chosen,
	type Crumb,
	chosenPlace,
	crumbId,
	crumbLabel,
	type FocusTarget,
	levelTitle,
	PLACES,
} from "./folder-picker/folder-picker-paths";
import {
	DESCRIPTION_MAX,
	DOCUMENT_FOLDER_IMPORT_LIMIT,
	DOCUMENT_FOLDER_READ_DEPTH,
	type DocumentFolderSource,
	isEditorFolder,
	messageOf,
	useDocumentFolders,
} from "./use-document-folders";

const DISCLOSURE = `Fabric reads each folder and its subfolders down to ${DOCUMENT_FOLDER_READ_DEPTH} levels, and imports the ${DOCUMENT_FOLDER_IMPORT_LIMIT} most recently modified supported files (${CONTEXT_UPLOAD_FORMAT_LABELS.join(", ")}). Imported files become visible to everyone with access to this project, whatever their access in OneDrive or SharePoint.`;

/** Google's export of a native file stops at 10 MB, whatever its type's limit. */
const GOOGLE_EXPORT_LIMIT_MB = 10;

const GOOGLE_DISCLOSURE = `Fabric reads each folder and its subfolders down to ${DOCUMENT_FOLDER_READ_DEPTH} levels, and imports the ${DOCUMENT_FOLDER_IMPORT_LIMIT} most recently modified supported files (${CONTEXT_UPLOAD_FORMAT_LABELS.join(", ")}). Google Docs, Sheets and Slides are exported as DOCX, XLSX and PDF, up to ${GOOGLE_EXPORT_LIMIT_MB} MB each; shortcuts are not followed. Imported files become visible to everyone with access to this project, whatever their access in Google Drive.`;

function ChosenRow({
	chosen,
	onDescribe,
	onRemove,
}: {
	chosen: Chosen;
	onDescribe: (description: string) => void;
	onRemove: () => void;
}) {
	const fieldId = useId();
	const countId = useId();
	const tooLong = chosen.description.length > DESCRIPTION_MAX;
	return (
		<li className="space-y-2 rounded-md border p-3">
			<div className="flex items-start justify-between gap-2">
				<div className="min-w-0">
					<p className="font-medium text-sm">{chosen.name}</p>
					<p className="break-all text-muted-foreground text-xs">
						{chosenPlace(chosen)}
					</p>
				</div>
				<Button
					variant="ghost"
					size="sm"
					aria-label={`Remove ${chosen.name}`}
					onClick={onRemove}
				>
					Remove
				</Button>
			</div>
			<div className="grid gap-1">
				<div className="flex items-center justify-between gap-2">
					<Label htmlFor={fieldId}>
						Description for {chosen.name} (optional)
					</Label>
					<span
						id={countId}
						className={cn(
							"shrink-0 text-xs",
							tooLong
								? "text-destructive"
								: "text-muted-foreground",
						)}
					>
						{chosen.description.length}/{DESCRIPTION_MAX}
					</span>
				</div>
				<Textarea
					id={fieldId}
					value={chosen.description}
					onChange={(event) => onDescribe(event.target.value)}
					maxLength={DESCRIPTION_MAX}
					rows={2}
					placeholder="What these files are, and how the AI should use them."
					aria-describedby={countId}
					aria-invalid={tooLong || undefined}
				/>
			</div>
		</li>
	);
}

export function ConnectDocumentFolderDialog({
	projectId,
	organizationId,
	open,
	onOpenChange,
	onConnected,
	returnFocusTo,
	provider = "microsoft",
}: {
	projectId: string;
	organizationId: string | null;
	/** Which drives to browse. Microsoft (OneDrive and SharePoint) by default. */
	provider?: DocumentFolderSource;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onConnected?: () => void;
	/** Focused when the dialog closes; Radix only returns focus to a trigger. */
	returnFocusTo?: RefObject<HTMLElement | null>;
}) {
	const queryClient = useQueryClient();
	const headingId = useId();
	const trayId = useId();
	const reasonId = useId();
	const levelHeading = useRef<HTMLHeadingElement>(null);
	const [trail, setTrail] = useState<Crumb[]>([PLACES]);
	const [chosen, setChosen] = useState<Map<string, Chosen>>(() => new Map());
	const [focusTarget, setFocusTarget] = useState<FocusTarget | null>(null);
	const [connecting, setConnecting] = useState(false);
	const [refusal, setRefusal] = useState<string | null>(null);
	const scope = { projectId, organizationId };
	const { folders } = useDocumentFolders(scope);
	const connected = folders.filter(isEditorFolder);
	const crumb = trail[trail.length - 1] ?? PLACES;
	const google = provider === "googledrive";

	useEffect(() => {
		if (focusTarget === "heading") {
			levelHeading.current?.focus();
			setFocusTarget(null);
		}
	}, [focusTarget]);

	const arriveAt = (next: Crumb[], target?: FocusTarget) => {
		setTrail(next);
		const last = next[next.length - 1];
		setFocusTarget(
			target ?? (last?.kind === "folder" ? "first" : "heading"),
		);
	};

	const goUp = () => {
		if (trail.length < 2) {
			return;
		}
		const left = trail[trail.length - 1];
		const next = trail.slice(0, -1);
		const parent = next[next.length - 1];
		arriveAt(
			next,
			parent?.kind === "folder" && left?.kind === "folder" && left.driveId
				? { key: `${left.driveId}:${left.itemId ?? "root"}` }
				: undefined,
		);
	};

	const toggle = (entry: Omit<Chosen, "description">, checked: boolean) => {
		setRefusal(null);
		setChosen((previous) => {
			const next = new Map(previous);
			if (checked) {
				next.set(entry.key, {
					...entry,
					description: previous.get(entry.key)?.description ?? "",
				});
			} else {
				next.delete(entry.key);
			}
			return next;
		});
	};

	const describe = (key: string, description: string) =>
		setChosen((previous) => {
			const entry = previous.get(key);
			if (!entry) {
				return previous;
			}
			return new Map(previous).set(key, { ...entry, description });
		});

	const reset = () => {
		setTrail([PLACES]);
		setChosen(new Map());
		setRefusal(null);
		setFocusTarget(null);
	};

	const close = () => {
		reset();
		onOpenChange(false);
	};

	const entries = Array.from(chosen.values());
	const tooLong = entries.some(
		(entry) => entry.description.length > DESCRIPTION_MAX,
	);

	const connect = async () => {
		setConnecting(true);
		setRefusal(null);
		try {
			const result = await orpcClient.projects.documentFolders.connect({
				...scope,
				// A Microsoft connect sends no provider, as before Google Drive.
				...(google ? { provider } : {}),
				folders: entries.map((entry) => {
					const description = entry.description.trim();
					return {
						driveId: entry.driveId,
						itemId: entry.itemId,
						...(entry.place === "sharepoint" && entry.site
							? {
									siteId: entry.site.siteId,
									siteName: entry.site.siteName,
								}
							: {}),
						...(description ? { description } : {}),
					};
				}),
			});
			const count = result.folders.length;
			if (!result.importStarted) {
				toast.warning(
					"Connected, but reading could not be started. Use Sync now on the folder to try again.",
				);
			} else {
				toast.success(
					count === 1
						? "Folder connected. Fabric is reading it now."
						: `${count} folders connected. Fabric is reading them now.`,
				);
			}
			await queryClient.invalidateQueries({
				queryKey: orpc.projects.documentFolders.list.key(),
			});
			onConnected?.();
			close();
		} catch (error) {
			setRefusal(
				messageOf(
					error,
					"The folders could not be connected. Try again.",
				),
			);
		} finally {
			setConnecting(false);
		}
	};

	const summary =
		entries.length === 0
			? "No folders selected."
			: `${entries.length === 1 ? "1 folder" : `${entries.length} folders`} selected: ${entries.map((entry) => entry.name).join(", ")}.`;

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				// A connect on its way still connects the folders, so the
				// dialog stays until it lands.
				if (!next && connecting) {
					return;
				}
				if (!next) {
					reset();
				}
				onOpenChange(next);
			}}
		>
			<DialogContent
				className="grid-cols-[minmax(0,1fr)] max-h-[90vh] max-w-2xl overflow-y-auto"
				onCloseAutoFocus={(event) => {
					const element = returnFocusTo?.current;
					if (element?.isConnected) {
						event.preventDefault();
						element.focus();
					}
				}}
			>
				<DialogHeader>
					<DialogTitle>
						{google
							? "Connect Google Drive folders"
							: "Connect OneDrive or SharePoint folders"}
					</DialogTitle>
					<DialogDescription>
						Choose folders whose files become project context.
						Fabric keeps them in step with each folder.
					</DialogDescription>
				</DialogHeader>

				<Breadcrumb aria-label="Folder path">
					<BreadcrumbList>
						{trail.map((step, index) => (
							<Fragment key={crumbId(step)}>
								{index > 0 && <BreadcrumbSeparator />}
								<BreadcrumbItem>
									{index === trail.length - 1 ? (
										<BreadcrumbPage>
											{crumbLabel(step)}
										</BreadcrumbPage>
									) : (
										<button
											type="button"
											className="rounded-sm transition-colors duration-150 hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
											onClick={() =>
												arriveAt(
													trail.slice(0, index + 1),
												)
											}
										>
											{crumbLabel(step)}
										</button>
									)}
								</BreadcrumbItem>
							</Fragment>
						))}
					</BreadcrumbList>
				</Breadcrumb>

				<div className="space-y-3">
					<h3
						id={headingId}
						ref={levelHeading}
						tabIndex={-1}
						className="font-medium text-sm focus-visible:outline-hidden"
					>
						{levelTitle(crumb)}
					</h3>
					{crumb.kind === "places" &&
						(google ? (
							<GooglePlacesLevel
								scope={scope}
								onOpen={(next) => arriveAt([...trail, next])}
							/>
						) : (
							<PlacesLevel
								scope={scope}
								onOpen={(next) => arriveAt([...trail, next])}
							/>
						))}
					{crumb.kind === "sharedDrives" && (
						<SharedDrivesLevel
							scope={scope}
							onOpen={(next) => arriveAt([...trail, next])}
						/>
					)}
					{crumb.kind === "sharepoint" && (
						<SharePointLevel
							scope={scope}
							onOpenSite={(site) =>
								arriveAt([...trail, { kind: "site", site }])
							}
						/>
					)}
					{crumb.kind === "site" && (
						<SiteLevel
							scope={scope}
							site={crumb.site}
							onOpenLibrary={(library) =>
								arriveAt([
									...trail,
									{
										kind: "folder",
										place: "sharepoint",
										driveId: library.driveId,
										name: library.name,
										path: "/",
										site: crumb.site,
										libraryName: library.name,
									},
								])
							}
						/>
					)}
					{crumb.kind === "folder" && (
						<FolderLevel
							key={crumbId(crumb)}
							scope={scope}
							crumb={crumb}
							headingId={headingId}
							chosen={chosen}
							connected={connected}
							focusTarget={
								focusTarget === "heading" ? null : focusTarget
							}
							onFocused={() => setFocusTarget(null)}
							focusHeading={() => levelHeading.current?.focus()}
							onToggle={toggle}
							onOpenFolder={(next) => arriveAt([...trail, next])}
							onUp={goUp}
						/>
					)}
				</div>

				{entries.length > 0 && (
					<section aria-labelledby={trayId} className="space-y-2">
						<h3 id={trayId} className="font-medium text-sm">
							Selected folders
						</h3>
						<ul className="space-y-2">
							{entries.map((entry) => (
								<ChosenRow
									key={entry.key}
									chosen={entry}
									onDescribe={(text) =>
										describe(entry.key, text)
									}
									onRemove={() => toggle(entry, false)}
								/>
							))}
						</ul>
					</section>
				)}
				<output
					aria-live="polite"
					className="text-muted-foreground text-sm"
				>
					{summary}
				</output>

				<p className="rounded-md border bg-muted/50 px-3 py-2 text-sm">
					{google ? GOOGLE_DISCLOSURE : DISCLOSURE}
				</p>

				{refusal && (
					<p
						role="alert"
						className="rounded-md border border-destructive/30 px-3 py-2 text-destructive text-sm"
					>
						{refusal}
					</p>
				)}
				{tooLong && (
					<p id={reasonId} className="text-destructive text-sm">
						Descriptions can be at most {DESCRIPTION_MAX}{" "}
						characters.
					</p>
				)}

				<DialogFooter>
					<Button
						variant="outline"
						onClick={close}
						disabled={connecting}
					>
						Cancel
					</Button>
					<Button
						onClick={connect}
						disabled={entries.length === 0 || tooLong || connecting}
						loading={connecting}
						aria-describedby={tooLong ? reasonId : undefined}
					>
						{entries.length > 1
							? `Connect ${entries.length} folders`
							: "Connect folder"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
