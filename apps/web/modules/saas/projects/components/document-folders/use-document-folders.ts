"use client";

/**
 * A project's OneDrive and SharePoint document folders (Fizzy #2808): the
 * list, read again while a folder is busy, and what each folder's card says.
 *
 * Every state and reason is worked out from the fixed codes the list returns,
 * never from Graph's own error text.
 */

import { ORPCError } from "@orpc/client";
import { openOAuthPopup, POPUP_BLOCKED_MESSAGE } from "@shared/lib/oauth-popup";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useRef } from "react";

type DocumentFolderList = Awaited<
	ReturnType<typeof orpcClient.projects.documentFolders.list>
>;

/** What anyone who can see the project sees of a folder. */
export type DocumentFolder = DocumentFolderList["folders"][number];

/** What an editor sees: also the reader, identifiers and problem files. */
export type EditorDocumentFolder = Extract<
	DocumentFolderList,
	{ view: "editor" }
>["folders"][number];

type DocumentFolderProviderId = "onedrive" | "sharepoint";

export function isEditorFolder(
	folder: DocumentFolder,
): folder is EditorDocumentFolder {
	return "readerUserId" in folder;
}

/** Read again quickly while a folder is being read or imported. */
const POLL_WHILE_BUSY_MS = 5_000;
/**
 * A scheduled read can find new files or a stopped connection at any time, so
 * connected folders are read again slowly even when nothing is happening.
 */
const POLL_WHILE_CONNECTED_MS = 60_000;
/**
 * After Sync now, a reconnect or a confirmed removal, the read it asked for
 * starts a moment later, so the list is read quickly for this long.
 */
const POLL_AFTER_ACTION_MS = 30_000;

export const DESCRIPTION_MAX = 500;

/**
 * Folder levels below a connected folder that a read opens, as
 * `DRIVE_TREE_MAX_DEPTH` in the integrations package's drive folder reader.
 * That constant is not exported, so nothing holds the two equal yet.
 */
export const DOCUMENT_FOLDER_READ_DEPTH = 5;

/**
 * Files a folder imports, the most recently modified first, as the
 * database's `DOCUMENT_FOLDER_IMPORT_CAP`, which the client bundle must not
 * import. A test holds the two equal.
 */
export const DOCUMENT_FOLDER_IMPORT_LIMIT = 500;

export function filesLabel(count: number): string {
	return count === 1 ? "1 file" : `${count} files`;
}

/** A procedure's own message, which is fixed text, or the fallback. */
export function messageOf(error: unknown, fallback: string): string {
	return error instanceof Error && error.message ? error.message : fallback;
}

export function providerName(provider: string): "OneDrive" | "SharePoint" {
	return provider === "sharepoint" ? "SharePoint" : "OneDrive";
}

/** Where a folder lives: OneDrive, or the SharePoint site and library. */
export function folderPlace(folder: {
	provider: string;
	siteName: string | null;
	libraryName: string | null;
}): string {
	if (folder.provider !== "sharepoint") {
		return "OneDrive";
	}
	return ["SharePoint", folder.siteName, folder.libraryName]
		.filter((part): part is string => Boolean(part))
		.join(" · ");
}

export type FolderState =
	| { kind: "reading" }
	| { kind: "problem"; code: string }
	| { kind: "throttled"; nextReadAfter: Date | null }
	| { kind: "held"; count: number }
	| { kind: "paused"; code: string }
	| { kind: "importing"; count: number }
	| { kind: "upToDate" };

/**
 * Connected and not read yet, with nothing standing in the way: what a folder
 * looks like the moment connect returns, before its read has started.
 */
function awaitingFirstRead(folder: DocumentFolder): boolean {
	return (
		folder.lastReadAt === null &&
		folder.problemCode === null &&
		folder.pausedRemovalsCode === null &&
		folder.nextReadAfter === null
	);
}

/**
 * The one state a folder's card shows. A running read comes first, then a
 * problem that stops reads, then throttling, removals held for confirmation,
 * removals paused, a first read about to start, files still importing, and
 * last of all up to date.
 */
export function folderState(folder: DocumentFolder): FolderState {
	if (folder.reading) {
		return { kind: "reading" };
	}
	if (folder.problemCode) {
		return { kind: "problem", code: folder.problemCode };
	}
	if (folder.pausedRemovalsCode === "THROTTLED") {
		return {
			kind: "throttled",
			nextReadAfter: folder.nextReadAfter
				? new Date(folder.nextReadAfter)
				: null,
		};
	}
	if (
		folder.pausedRemovalsCode === "MASS_REMOVAL" &&
		(folder.heldRemovalCount ?? 0) > 0
	) {
		return { kind: "held", count: folder.heldRemovalCount ?? 0 };
	}
	if (
		folder.pausedRemovalsCode === "TOO_LARGE" ||
		folder.pausedRemovalsCode === "PARTIAL_READ"
	) {
		return { kind: "paused", code: folder.pausedRemovalsCode };
	}
	if (awaitingFirstRead(folder)) {
		return { kind: "reading" };
	}
	if (folder.counts.inProgress > 0) {
		return { kind: "importing", count: folder.counts.inProgress };
	}
	return { kind: "upToDate" };
}

/** Being read, importing, or about to be read for the first time. */
export function isFolderBusy(folder: DocumentFolder): boolean {
	return (
		folder.reading ||
		folder.counts.inProgress > 0 ||
		awaitingFirstRead(folder)
	);
}

function pathSegments(path: string | null): string[] | null {
	if (path === null) {
		return null;
	}
	return path
		.trim()
		.toLowerCase()
		.split("/")
		.filter((segment) => segment.length > 0);
}

/**
 * How `folder` sits against `other` in one drive: the same folder, inside
 * it, or holding it. Paths compare by segment and without case, as the
 * server's overlap refusal does, so `/Sales` does not hold `/Sales 2`. An
 * unknown path never overlaps.
 */
export function folderRelation(
	folder: { driveId: string; drivePath: string | null },
	other: { driveId: string; drivePath: string | null },
): "same" | "inside" | "contains" | null {
	if (folder.driveId !== other.driveId) {
		return null;
	}
	const mine = pathSegments(folder.drivePath);
	const theirs = pathSegments(other.drivePath);
	if (!mine || !theirs) {
		return null;
	}
	const [shorter, longer] =
		mine.length <= theirs.length ? [mine, theirs] : [theirs, mine];
	if (!shorter.every((segment, index) => longer[index] === segment)) {
		return null;
	}
	if (mine.length === theirs.length) {
		return "same";
	}
	return mine.length > theirs.length ? "inside" : "contains";
}

/**
 * `metadata.provider` of a context imported from a document folder, as the
 * database's `DOCUMENT_FOLDER_CONTEXT_PROVIDER` writes it.
 */
const CONTEXT_PROVIDERS: Record<string, DocumentFolderProviderId> = {
	"onedrive-documents": "onedrive",
	"sharepoint-documents": "sharepoint",
};

/** The drive a context was imported from, or null for any other context. */
export function documentFolderProvenance(
	metadata: unknown,
): DocumentFolderProviderId | null {
	const provider = (metadata as { provider?: unknown } | null)?.provider;
	return typeof provider === "string"
		? (CONTEXT_PROVIDERS[provider] ?? null)
		: null;
}

/**
 * How often the list is read again: quickly while a folder is busy or until
 * `fastUntil` (a time in ms), slowly while any folder is connected.
 */
export function documentFolderPollInterval({
	folders,
	fastUntil,
	now,
}: {
	folders: readonly DocumentFolder[];
	fastUntil: number;
	now: number;
}): number | false {
	if (folders.length === 0) {
		return false;
	}
	if (now < fastUntil || folders.some(isFolderBusy)) {
		return POLL_WHILE_BUSY_MS;
	}
	return POLL_WHILE_CONNECTED_MS;
}

/**
 * The project's folders, read again quickly while any of them is busy and for
 * a while after an action asks for a read.
 */
export function useDocumentFolders({
	projectId,
	organizationId,
}: {
	projectId: string;
	organizationId: string | null;
}) {
	const fastUntil = useRef(0);
	const { data, isLoading } = useQuery({
		...orpc.projects.documentFolders.list.queryOptions({
			input: { projectId, organizationId },
		}),
		refetchInterval: (query) =>
			documentFolderPollInterval({
				folders: query.state.data?.folders ?? [],
				fastUntil: fastUntil.current,
				now: Date.now(),
			}),
	});
	/**
	 * An action asked for a read that has not started yet: read the list
	 * quickly for a while so it shows. Call before refreshing the list, whose
	 * answer is what applies the faster interval.
	 */
	const expectRead = useCallback(() => {
		fastUntil.current = Date.now() + POLL_AFTER_ACTION_MS;
	}, []);
	return {
		view: data?.view ?? "viewer",
		folders: (data?.folders ?? []) as DocumentFolder[],
		isLoading,
		expectRead,
	};
}

/** The connect prompt a procedure answers when the caller has no Microsoft connection. */
export function isMicrosoftNotConnected(error: unknown): boolean {
	return (
		error instanceof ORPCError &&
		(error.data as { code?: string } | undefined)?.code ===
			"MICROSOFT_NOT_CONNECTED"
	);
}

/**
 * Runs the Microsoft connect flow Settings → Integrations uses, in a popup.
 * Resolves once the popup reports success or is closed, so the caller can
 * try again and let the server say whether a connection now exists; false
 * when the popup reported a failure. Once `signal` aborts, as when the
 * calling screen goes away, it stops listening and resolves false; the
 * caller checks the signal before acting on the answer.
 */
export async function connectMicrosoftAccount(
	organizationId: string | null,
	signal?: AbortSignal,
): Promise<boolean> {
	const { authorizationUrl } = await orpcClient.integrations.oauth.start({
		provider: "MICROSOFT_GRAPH",
		redirectUri: `${window.location.origin}/api/integrations/oauth/callback`,
		// Relative on purpose: the callback page rejects absolute URLs.
		returnUrl:
			window.location.pathname +
			window.location.search +
			window.location.hash,
		organizationId,
	});
	if (signal?.aborted) {
		return false;
	}
	const popup = openOAuthPopup({
		url: authorizationUrl,
		name: "microsoft_graph-oauth",
	});
	if (!popup) {
		throw new Error(POPUP_BLOCKED_MESSAGE);
	}
	return new Promise<boolean>((resolve) => {
		const finish = (connected: boolean) => {
			window.removeEventListener("message", onMessage);
			window.clearInterval(closedPoll);
			signal?.removeEventListener("abort", onAbort);
			resolve(connected);
		};
		const onAbort = () => finish(false);
		const onMessage = (event: MessageEvent) => {
			if (event.origin !== window.location.origin) {
				return;
			}
			const type = (event.data as { type?: unknown } | null)?.type;
			if (type === "oauth_success") {
				finish(true);
			} else if (type === "oauth_error") {
				finish(false);
			}
		};
		window.addEventListener("message", onMessage);
		const closedPoll = window.setInterval(() => {
			if (popup.closed) {
				finish(true);
			}
		}, 500);
		signal?.addEventListener("abort", onAbort);
	});
}

/**
 * Focus to put back when a dialog closes. Radix returns focus only to a
 * `DialogTrigger`; these dialogs open from buttons and menu items, so the
 * opener is remembered when the dialog opens.
 */
export function useReturnFocus() {
	const opener = useRef<HTMLElement | null>(null);
	const remember = useCallback((element: HTMLElement | null) => {
		opener.current = element;
	}, []);
	const onCloseAutoFocus = useCallback((event: Event) => {
		const element = opener.current;
		if (element?.isConnected) {
			event.preventDefault();
			element.focus();
		}
	}, []);
	return { remember, onCloseAutoFocus };
}
