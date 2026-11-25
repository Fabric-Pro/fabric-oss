"use client";

/**
 * The levels of the document-folder picker (Fizzy #2808): places, SharePoint
 * sites, a site's libraries, Google shared drives, and a folder's subfolders
 * as a tree that works from the keyboard. Each level reads with the caller's
 * own Microsoft or Google Drive connection.
 */

import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Checkbox } from "@ui/components/checkbox";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import {
	Building2Icon,
	ChevronRightIcon,
	CloudIcon,
	FolderIcon,
	HardDriveIcon,
	Loader2Icon,
	UsersIcon,
} from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import {
	connectAccount,
	type DocumentFolderSource,
	type EditorDocumentFolder,
	googleDriveConnectNeeded,
	isMicrosoftNotConnected,
	messageOf,
} from "../use-document-folders";
import {
	blockedBy,
	type Chosen,
	type Crumb,
	childPath,
	type FocusTarget,
	type FolderCrumb,
	keyOf,
	type Site,
} from "./folder-picker-paths";

const NOT_CONNECTED =
	"Connect your Microsoft account in Settings → Integrations to choose OneDrive or SharePoint folders.";

type Scope = { projectId: string; organizationId: string | null };

function useBrowse(
	scope: Scope,
	level:
		| { kind: "roots" }
		| { kind: "sites"; search: string }
		| { kind: "drives"; siteId: string }
		| { kind: "folders"; driveId?: string; itemId?: string },
	{
		enabled = true,
		source = "microsoft",
	}: { enabled?: boolean; source?: DocumentFolderSource } = {},
) {
	return useQuery({
		...orpc.projects.documentFolders.browse.queryOptions({
			// A Microsoft browse sends no provider, as before Google Drive.
			input: {
				...scope,
				...(source === "googledrive" ? { provider: source } : {}),
				level,
			},
		}),
		enabled,
		retry: false,
	});
}

type BrowseData = ReturnType<typeof useBrowse>["data"];

/** The SharePoint part of the Microsoft top level, once it has loaded. */
function sharePointOf(data: BrowseData) {
	return data?.level === "roots" && data.provider !== "googledrive"
		? data.sharePoint
		: null;
}

/** The Google Drive places: My Drive and the shared drives. */
function useGooglePlaces(scope: Scope) {
	const roots = useBrowse(
		scope,
		{ kind: "roots" },
		{ source: "googledrive" },
	);
	const places =
		roots.data?.level === "roots" && roots.data.provider === "googledrive"
			? roots.data
			: null;
	return { roots, places };
}

function LevelError({ error, fallback }: { error: unknown; fallback: string }) {
	return (
		<p
			role="alert"
			className="rounded-md border border-destructive/30 px-3 py-2 text-destructive text-sm"
		>
			{isMicrosoftNotConnected(error)
				? NOT_CONNECTED
				: messageOf(error, fallback)}
		</p>
	);
}

/**
 * A Google Drive level that could not be read, with the way on: connect
 * Google Drive, reconnect it to grant folder access, or try again. Connecting
 * runs the Settings → Integrations flow in a popup, then reads again.
 */
function GoogleLevelError({
	error,
	organizationId,
	fallback,
	onRetry,
}: {
	error: unknown;
	organizationId: string | null;
	fallback: string;
	onRetry: () => void;
}) {
	const needed = googleDriveConnectNeeded(error);
	const [connecting, setConnecting] = useState(false);
	const [connectError, setConnectError] = useState<string | null>(null);
	// Aborted when the level goes away, so a popup still open neither reads
	// again nor sets state on a screen that is gone.
	const mounted = useRef<AbortController | null>(null);
	useEffect(() => {
		const controller = new AbortController();
		mounted.current = controller;
		return () => controller.abort();
	}, []);

	const connect = async () => {
		const signal = mounted.current?.signal;
		setConnecting(true);
		setConnectError(null);
		try {
			await connectAccount("GOOGLE_DRIVE", organizationId, signal);
			if (!signal?.aborted) {
				onRetry();
			}
		} catch (connectFailure) {
			if (!signal?.aborted) {
				setConnectError(
					messageOf(
						connectFailure,
						"Google Drive could not be connected.",
					),
				);
			}
		} finally {
			if (!signal?.aborted) {
				setConnecting(false);
			}
		}
	};

	return (
		<div className="space-y-2">
			<p
				role="alert"
				className="rounded-md border border-destructive/30 px-3 py-2 text-destructive text-sm"
			>
				{connectError ??
					(needed === "connect"
						? "Connect your Google Drive account to choose folders."
						: needed === "reconnect"
							? "Reconnect Google to grant folder access. Fabric needs to read your Drive folders."
							: messageOf(error, fallback))}
			</p>
			{needed ? (
				<Button
					variant="outline"
					size="sm"
					onClick={connect}
					loading={connecting}
				>
					{needed === "connect"
						? "Connect Google"
						: "Reconnect Google"}
				</Button>
			) : (
				<Button variant="outline" size="sm" onClick={onRetry}>
					Retry
				</Button>
			)}
		</div>
	);
}

function Loading({ children }: { children: string }) {
	return (
		<p className="flex items-center gap-2 text-muted-foreground text-sm">
			<Loader2Icon
				aria-hidden="true"
				className="size-4 motion-safe:animate-spin"
			/>
			{children}
		</p>
	);
}

/** One row that opens the next level. Its name is its label alone. */
function OpenRow({
	icon: Icon,
	label,
	onOpen,
}: {
	icon: typeof FolderIcon;
	label: string;
	onOpen: () => void;
}) {
	return (
		<li>
			<button
				type="button"
				onClick={onOpen}
				className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors duration-150 hover:bg-muted focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
			>
				<Icon
					aria-hidden="true"
					className="size-4 shrink-0 text-muted-foreground"
				/>
				<span className="min-w-0 grow truncate">{label}</span>
				<ChevronRightIcon
					aria-hidden="true"
					className="size-4 shrink-0 text-muted-foreground"
				/>
			</button>
		</li>
	);
}

export function PlacesLevel({
	scope,
	onOpen,
}: {
	scope: { projectId: string; organizationId: string | null };
	onOpen: (crumb: Crumb) => void;
}) {
	const roots = useBrowse(scope, { kind: "roots" });
	const sharePoint = sharePointOf(roots.data);

	return (
		<div className="space-y-2">
			<ul className="divide-y rounded-lg border">
				<OpenRow
					icon={CloudIcon}
					label="My OneDrive"
					onOpen={() =>
						onOpen({
							kind: "folder",
							place: "onedrive",
							name: "My OneDrive",
							path: "/",
						})
					}
				/>
				{sharePoint && sharePoint.status !== "unavailable" && (
					<OpenRow
						icon={Building2Icon}
						label="SharePoint"
						onOpen={() => onOpen({ kind: "sharepoint" })}
					/>
				)}
			</ul>
			{roots.isLoading && <Loading>Checking SharePoint…</Loading>}
			{roots.error && (
				<LevelError
					error={roots.error}
					fallback="Microsoft could not be reached. Try again in a moment."
				/>
			)}
			{sharePoint?.status === "unavailable" && (
				<p className="text-muted-foreground text-sm">
					SharePoint is not available for this Microsoft account.
					Personal accounts have OneDrive only.
				</p>
			)}
		</div>
	);
}

/** My Drive's root, or a shared drive's, as the folder level it opens. */
function googleDriveCrumb(place: { driveId: string; name: string }): Crumb {
	return {
		kind: "folder",
		place: "googledrive",
		driveId: place.driveId,
		// A drive's root folder has the drive's id.
		itemId: place.driveId,
		name: place.name,
		path: "/",
		driveName: place.name,
		ancestorIds: [],
	};
}

export function GooglePlacesLevel({
	scope,
	onOpen,
}: {
	scope: Scope;
	onOpen: (crumb: Crumb) => void;
}) {
	const { roots, places } = useGooglePlaces(scope);
	if (roots.isLoading) {
		return <Loading>Reading Google Drive…</Loading>;
	}
	if (roots.error) {
		return (
			<GoogleLevelError
				error={roots.error}
				organizationId={scope.organizationId}
				fallback="Google Drive could not be reached. Try again in a moment."
				onRetry={() => void roots.refetch()}
			/>
		);
	}
	if (!places) {
		return null;
	}
	return (
		<ul className="divide-y rounded-lg border">
			<OpenRow
				icon={HardDriveIcon}
				label="My Drive"
				onOpen={() =>
					onOpen(
						googleDriveCrumb({
							driveId: places.myDrive.driveId,
							name: places.myDrive.name,
						}),
					)
				}
			/>
			<OpenRow
				icon={UsersIcon}
				label="Shared drives"
				onOpen={() => onOpen({ kind: "sharedDrives" })}
			/>
		</ul>
	);
}

export function SharedDrivesLevel({
	scope,
	onOpen,
}: {
	scope: Scope;
	onOpen: (crumb: Crumb) => void;
}) {
	const { roots, places } = useGooglePlaces(scope);
	if (roots.isLoading) {
		return <Loading>Reading your shared drives…</Loading>;
	}
	if (roots.error) {
		return (
			<GoogleLevelError
				error={roots.error}
				organizationId={scope.organizationId}
				fallback="Your shared drives could not be read. Try again in a moment."
				onRetry={() => void roots.refetch()}
			/>
		);
	}
	const drives = places?.sharedDrives ?? [];
	if (drives.length === 0) {
		return (
			<p className="text-muted-foreground text-sm">
				You are not a member of any shared drive.
			</p>
		);
	}
	return (
		<ul className="divide-y rounded-lg border">
			{drives.map((drive) => (
				<OpenRow
					key={drive.driveId}
					icon={UsersIcon}
					label={drive.name}
					onOpen={() => onOpen(googleDriveCrumb(drive))}
				/>
			))}
		</ul>
	);
}

function SiteList({
	sites,
	onOpenSite,
}: {
	sites: Array<{ siteId: string; name: string }>;
	onOpenSite: (site: Site) => void;
}) {
	return (
		<ul className="divide-y rounded-lg border">
			{sites.map((site) => (
				<OpenRow
					key={site.siteId}
					icon={Building2Icon}
					label={site.name}
					onOpen={() =>
						onOpenSite({ siteId: site.siteId, siteName: site.name })
					}
				/>
			))}
		</ul>
	);
}

export function SharePointLevel({
	scope,
	onOpenSite,
}: {
	scope: { projectId: string; organizationId: string | null };
	onOpenSite: (site: Site) => void;
}) {
	const searchId = useId();
	const [term, setTerm] = useState("");
	const [search, setSearch] = useState<string | null>(null);
	const roots = useBrowse(scope, { kind: "roots" });
	const results = useBrowse(
		scope,
		{ kind: "sites", search: search ?? "" },
		{ enabled: search !== null },
	);
	const followed = sharePointOf(roots.data);
	const found =
		results.data?.level === "sites" && results.data.status === "available"
			? results.data.sites
			: null;

	return (
		<div className="space-y-4">
			<form
				className="space-y-1"
				onSubmit={(event) => {
					event.preventDefault();
					const trimmed = term.trim();
					if (trimmed) {
						setSearch(trimmed);
					}
				}}
			>
				<Label htmlFor={searchId}>Search SharePoint sites</Label>
				<div className="flex gap-2">
					<Input
						id={searchId}
						value={term}
						maxLength={200}
						onChange={(event) => setTerm(event.target.value)}
					/>
					<Button type="submit" variant="outline">
						Search
					</Button>
				</div>
			</form>

			{search !== null && (
				<div className="space-y-2">
					{results.isLoading ? (
						<Loading>Searching…</Loading>
					) : results.error ? (
						<LevelError
							error={results.error}
							fallback="The search could not be run. Try again."
						/>
					) : results.data?.level === "sites" &&
						results.data.status === "unavailable" ? (
						<p className="text-muted-foreground text-sm">
							SharePoint is not available for this Microsoft
							account.
						</p>
					) : found && found.length === 0 ? (
						<p className="text-muted-foreground text-sm">
							No sites match "{search}".
						</p>
					) : found ? (
						<SiteList sites={found} onOpenSite={onOpenSite} />
					) : null}
				</div>
			)}

			<div className="space-y-2">
				<p className="font-medium text-sm">Sites you follow</p>
				{roots.isLoading ? (
					<Loading>Reading the sites you follow…</Loading>
				) : roots.error ? (
					<LevelError
						error={roots.error}
						fallback="Your followed sites could not be read. Search for a site instead."
					/>
				) : followed?.status === "error" ? (
					<p className="text-muted-foreground text-sm">
						Your followed sites could not be read. Search for a site
						instead.
					</p>
				) : followed?.status === "available" &&
					followed.followedSites.length > 0 ? (
					<SiteList
						sites={followed.followedSites}
						onOpenSite={onOpenSite}
					/>
				) : (
					<p className="text-muted-foreground text-sm">
						You don't follow any SharePoint sites yet. Search for
						one above.
					</p>
				)}
			</div>
		</div>
	);
}

export function SiteLevel({
	scope,
	site,
	onOpenLibrary,
}: {
	scope: { projectId: string; organizationId: string | null };
	site: Site;
	onOpenLibrary: (library: { driveId: string; name: string }) => void;
}) {
	const drives = useBrowse(scope, { kind: "drives", siteId: site.siteId });
	const data = drives.data?.level === "drives" ? drives.data : null;

	if (drives.isLoading) {
		return <Loading>Reading the site's libraries…</Loading>;
	}
	if (drives.error) {
		return (
			<LevelError
				error={drives.error}
				fallback="The site's libraries could not be read."
			/>
		);
	}
	if (data?.status === "unavailable") {
		return (
			<p className="text-muted-foreground text-sm">
				This site's libraries could not be read with your Microsoft
				account.
			</p>
		);
	}
	const libraries = data?.status === "available" ? data.libraries : [];
	if (libraries.length === 0) {
		return (
			<p className="text-muted-foreground text-sm">
				This site has no document libraries.
			</p>
		);
	}
	return (
		<ul className="divide-y rounded-lg border">
			{libraries.map((library) => (
				<OpenRow
					key={library.driveId}
					icon={FolderIcon}
					label={library.name}
					onOpen={() => onOpenLibrary(library)}
				/>
			))}
		</ul>
	);
}

function FolderTreeItem({
	folder,
	checked,
	blocked,
	active,
	itemRef,
	onFocus,
	onToggle,
	onOpen,
	onKeyDown,
}: {
	/** Google Drive does not count a folder's children. */
	folder: { name: string; childCount?: number };
	checked: boolean;
	blocked: string | null;
	active: boolean;
	itemRef: (element: HTMLDivElement | null) => void;
	onFocus: () => void;
	onToggle: () => void;
	onOpen: () => void;
	onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
}) {
	const metaId = useId();
	const reasonId = useId();
	const self = useRef<HTMLDivElement | null>(null);
	const hasCount = folder.childCount !== undefined;
	const describedBy =
		[hasCount ? metaId : null, blocked ? reasonId : null]
			.filter(Boolean)
			.join(" ") || undefined;
	// Mouse clicks on the parts below leave focus on the row, where the
	// keyboard handling lives.
	const keepFocus = (event: { preventDefault: () => void }) => {
		event.preventDefault();
		self.current?.focus();
	};

	return (
		<div
			ref={(element) => {
				self.current = element;
				itemRef(element);
			}}
			role="treeitem"
			aria-label={folder.name}
			aria-checked={checked}
			aria-disabled={blocked ? true : undefined}
			aria-describedby={describedBy}
			tabIndex={active ? 0 : -1}
			onFocus={onFocus}
			onKeyDown={onKeyDown}
			className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
		>
			<Checkbox
				tabIndex={-1}
				aria-hidden="true"
				checked={checked}
				disabled={Boolean(blocked)}
				onMouseDown={keepFocus}
				onCheckedChange={onToggle}
			/>
			<button
				type="button"
				tabIndex={-1}
				aria-hidden="true"
				onMouseDown={keepFocus}
				onClick={onOpen}
				className="flex min-w-0 grow items-center gap-2 text-left text-sm"
			>
				<FolderIcon
					aria-hidden="true"
					className="size-4 shrink-0 text-muted-foreground"
				/>
				<span className="truncate">{folder.name}</span>
				{hasCount && (
					<span
						id={metaId}
						className="ml-auto shrink-0 text-muted-foreground text-xs"
					>
						{folder.childCount} item
						{folder.childCount === 1 ? "" : "s"}
					</span>
				)}
				<ChevronRightIcon
					aria-hidden="true"
					className={
						hasCount
							? "size-4 shrink-0 text-muted-foreground"
							: "ml-auto size-4 shrink-0 text-muted-foreground"
					}
				/>
			</button>
			{blocked && (
				<p
					id={reasonId}
					className="w-full pl-7 text-muted-foreground text-xs"
				>
					{blocked}
				</p>
			)}
		</div>
	);
}

export function FolderLevel({
	scope,
	crumb,
	headingId,
	chosen,
	connected,
	focusTarget,
	onFocused,
	focusHeading,
	onToggle,
	onOpenFolder,
	onUp,
}: {
	scope: { projectId: string; organizationId: string | null };
	crumb: FolderCrumb;
	headingId: string;
	chosen: Map<string, Chosen>;
	connected: EditorDocumentFolder[];
	focusTarget: FocusTarget | null;
	onFocused: () => void;
	focusHeading: () => void;
	onToggle: (folder: Omit<Chosen, "description">, checked: boolean) => void;
	onOpenFolder: (crumb: FolderCrumb) => void;
	onUp: () => void;
}) {
	const currentId = useId();
	const currentCountId = useId();
	const currentReasonId = useId();
	const [active, setActive] = useState(0);
	const items = useRef<Array<HTMLDivElement | null>>([]);
	const google = crumb.place === "googledrive";
	const listing = useBrowse(
		scope,
		{
			kind: "folders",
			...(crumb.driveId ? { driveId: crumb.driveId } : {}),
			...(crumb.itemId ? { itemId: crumb.itemId } : {}),
		},
		{ source: google ? "googledrive" : "microsoft" },
	);
	const data = listing.data?.level === "folders" ? listing.data : null;
	const folders = data?.folders ?? [];
	// A Google Drive folder's drive name and the folders above it.
	const googleExtras = (ancestorIds: string[]) =>
		google
			? {
					...(crumb.driveName ? { driveName: crumb.driveName } : {}),
					ancestorIds,
				}
			: {};
	// A Google Drive folder below this one has this folder above it too.
	const childGoogle = googleExtras([
		...(crumb.ancestorIds ?? []),
		...(crumb.itemId ? [crumb.itemId] : []),
	]);
	const currentGoogle = googleExtras(crumb.ancestorIds ?? []);

	const asChosen = (folder: {
		driveId: string;
		itemId: string;
		name: string;
	}): Omit<Chosen, "description"> => ({
		key: keyOf(folder),
		driveId: folder.driveId,
		itemId: folder.itemId,
		name: folder.name,
		path: childPath(crumb.path, folder.name),
		place: crumb.place,
		...(crumb.site ? { site: crumb.site } : {}),
		...(crumb.libraryName ? { libraryName: crumb.libraryName } : {}),
		...childGoogle,
	});

	// My OneDrive's root has no drive id to connect it by, so only a folder
	// that was opened, or a library, can be chosen as a whole.
	const current: Omit<Chosen, "description"> | null = crumb.driveId
		? {
				key: keyOf({
					driveId: crumb.driveId,
					itemId: crumb.itemId ?? "root",
				}),
				driveId: crumb.driveId,
				itemId: crumb.itemId ?? data?.itemId ?? "root",
				name: crumb.name,
				path: crumb.path,
				place: crumb.place,
				...(crumb.site ? { site: crumb.site } : {}),
				...(crumb.libraryName
					? { libraryName: crumb.libraryName }
					: {}),
				...currentGoogle,
			}
		: null;
	const currentBlocked = current
		? blockedBy(current, chosen, connected)
		: null;

	useEffect(() => {
		if (!focusTarget || !data) {
			return;
		}
		const index =
			typeof focusTarget === "object"
				? Math.max(
						0,
						folders.findIndex(
							(folder) => keyOf(folder) === focusTarget.key,
						),
					)
				: 0;
		const item = items.current[index];
		if (item) {
			setActive(index);
			item.focus();
		} else {
			focusHeading();
		}
		onFocused();
	}, [focusTarget, data, folders, onFocused, focusHeading]);

	const focusAt = (index: number) => {
		setActive(index);
		items.current[index]?.focus();
	};

	const openChild = (folder: (typeof folders)[number]) =>
		onOpenFolder({
			kind: "folder",
			place: crumb.place,
			driveId: folder.driveId,
			itemId: folder.itemId,
			name: folder.name,
			path: childPath(crumb.path, folder.name),
			...(crumb.site ? { site: crumb.site } : {}),
			...(crumb.libraryName ? { libraryName: crumb.libraryName } : {}),
			...childGoogle,
		});

	const toggleChild = (folder: (typeof folders)[number]) => {
		const entry = asChosen(folder);
		if (blockedBy(entry, chosen, connected)) {
			return;
		}
		onToggle(entry, !chosen.has(entry.key));
	};

	const handleKey = (
		event: KeyboardEvent<HTMLDivElement>,
		index: number,
		folder: (typeof folders)[number],
	) => {
		if (event.target !== event.currentTarget) {
			return;
		}
		const last = folders.length - 1;
		switch (event.key) {
			case "ArrowDown":
				focusAt(Math.min(index + 1, last));
				break;
			case "ArrowUp":
				focusAt(Math.max(index - 1, 0));
				break;
			case "Home":
				focusAt(0);
				break;
			case "End":
				focusAt(last);
				break;
			case " ":
				toggleChild(folder);
				break;
			case "Enter":
			case "ArrowRight":
				openChild(folder);
				break;
			case "ArrowLeft":
				onUp();
				break;
			default:
				return;
		}
		event.preventDefault();
	};

	if (listing.isLoading) {
		return (
			<Loading>
				{google
					? "Reading Google Drive…"
					: crumb.place === "onedrive"
						? "Reading OneDrive…"
						: "Reading SharePoint…"}
			</Loading>
		);
	}
	if (listing.error && google) {
		return (
			<GoogleLevelError
				error={listing.error}
				organizationId={scope.organizationId}
				fallback="This folder could not be read."
				onRetry={() => void listing.refetch()}
			/>
		);
	}
	if (listing.error) {
		return (
			<LevelError
				error={listing.error}
				fallback="This folder could not be read."
			/>
		);
	}

	return (
		<div className="space-y-3">
			{current && (
				<div className="space-y-1 rounded-md border px-3 py-2 text-sm">
					<div className="flex items-center gap-2">
						<Checkbox
							id={currentId}
							checked={chosen.has(current.key)}
							disabled={Boolean(currentBlocked)}
							aria-describedby={
								currentBlocked
									? `${currentCountId} ${currentReasonId}`
									: currentCountId
							}
							onCheckedChange={(checked) =>
								onToggle(current, checked === true)
							}
						/>
						<Label htmlFor={currentId}>
							{crumb.path !== "/"
								? `Use ${crumb.name}`
								: google
									? `Use all of ${crumb.name}`
									: `Use the whole ${crumb.name} library`}
						</Label>
					</div>
					<p
						id={currentCountId}
						className="pl-6 text-muted-foreground text-xs"
					>
						{data?.supportedFileCount === 1
							? "1 supported file directly in it."
							: `${data?.supportedFileCount ?? 0} supported files directly in it.`}
					</p>
					{currentBlocked && (
						<p
							id={currentReasonId}
							className="pl-6 text-muted-foreground text-xs"
						>
							{currentBlocked}
						</p>
					)}
				</div>
			)}
			{folders.length === 0 ? (
				<p className="text-muted-foreground text-sm">
					No folders inside this one.
				</p>
			) : (
				<div
					role="tree"
					aria-labelledby={headingId}
					aria-multiselectable="true"
					className="divide-y rounded-lg border"
				>
					{folders.map((folder, index) => {
						const entry = asChosen(folder);
						return (
							<FolderTreeItem
								key={entry.key}
								folder={folder}
								checked={chosen.has(entry.key)}
								blocked={blockedBy(entry, chosen, connected)}
								active={index === active}
								itemRef={(element) => {
									items.current[index] = element;
								}}
								onFocus={() => setActive(index)}
								onToggle={() => toggleChild(folder)}
								onOpen={() => openChild(folder)}
								onKeyDown={(event) =>
									handleKey(event, index, folder)
								}
							/>
						);
					})}
				</div>
			)}
			{data?.truncated && (
				<p className="text-muted-foreground text-xs">
					This folder holds more than can be listed here. Open a
					subfolder to find the rest.
				</p>
			)}
		</div>
	);
}
