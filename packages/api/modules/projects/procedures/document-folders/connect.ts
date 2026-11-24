import { ORPCError } from "@orpc/server";
import {
	connectDocumentFolders,
	DOCUMENT_FOLDER_DESCRIPTION_MAX,
	DOCUMENT_FOLDER_MAX_PER_PROJECT,
	type DocumentFolderSelection,
	db,
	type TranscriptFolderDrivePath,
} from "@repo/database";
import type {
	DriveItemDetailsResult,
	SharePointDriveList,
	SharePointSiteList,
} from "@repo/integrations/microsoft";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import { assertInputOrgMatchesProject } from "../../../../lib/authorized-project-tenant";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	folderConnectRefusal,
	folderDrivePath,
} from "../../lib/folder-connect-refusal";
import {
	callGraph,
	folderNotFound,
	folderResource,
	type GraphCaller,
	graphCaller,
	graphUnreachable,
	loadEnabledProject,
	microsoftNotConnected,
	projectInput,
	readGraph,
	recordSyncNotStarted,
	wakeDocumentFolderSync,
} from "./shared";

const TAGS = ["Projects", "Document Folders"];

/** What the picker names; everything stored about the folder comes from Graph. */
interface FolderChoice {
	driveId: string;
	itemId: string;
	/** The SharePoint site the folder was browsed through. */
	siteId?: string | null;
	/** The site's name as the picker showed it; only a search term here. */
	siteName?: string | null;
}

type FolderPlace = Omit<DocumentFolderSelection, "description">;

/**
 * The SharePoint site's name, from Graph: the picker's name is searched for,
 * and the result with the folder's site id names it. Only a label, so a
 * search that cannot confirm it leaves the site unnamed.
 */
async function confirmedSiteName(
	caller: GraphCaller,
	siteId: string,
	searchFor: string | null | undefined,
): Promise<string | null> {
	const query = searchFor?.trim();
	if (!query) {
		return null;
	}
	try {
		const found = await callGraph<SharePointSiteList>(
			caller,
			"search_sharepoint_sites",
			{ query },
		);
		return found.status === "ok"
			? (found.sites.find((site) => site.id === siteId)?.name ?? null)
			: null;
	} catch {
		return null;
	}
}

/**
 * Where a chosen folder is, read from Graph as the caller: which proves they
 * can read it now, as the sync will. Provider, real ids, name, path and web
 * address come from the item; a SharePoint folder's library must be one of
 * its site's, and is named from that list.
 */
async function placeOf(
	caller: GraphCaller,
	choice: FolderChoice,
): Promise<FolderPlace> {
	const unreadable = () =>
		new ORPCError("BAD_REQUEST", {
			message:
				"A chosen folder could not be read. It may have been moved or deleted, or your Microsoft account cannot open it.",
			data: { driveId: choice.driveId, itemId: choice.itemId },
		});

	const found = await readGraph<DriveItemDetailsResult>(
		caller,
		"get_drive_item",
		{ driveId: choice.driveId, itemId: choice.itemId },
	);
	if (found.status === "failed") {
		if (found.httpStatus === 401) {
			throw microsoftNotConnected();
		}
		if (found.httpStatus === 429 || found.httpStatus >= 500) {
			throw graphUnreachable();
		}
		throw unreadable();
	}
	const item = found.item;
	if (!item.isFolder) {
		throw new ORPCError("BAD_REQUEST", {
			message: "Only folders can be connected.",
			data: { driveId: choice.driveId, itemId: choice.itemId },
		});
	}
	if (!item.provider) {
		throw new ORPCError("BAD_REQUEST", {
			message: "Only OneDrive and SharePoint folders can be connected.",
			data: { driveId: choice.driveId, itemId: choice.itemId },
		});
	}
	const drivePath = folderDrivePath(item);
	const place = {
		provider: item.provider,
		driveId: item.driveId,
		itemId: item.id,
		webUrl: item.webUrl,
		drivePath,
	};

	if (item.provider === "onedrive") {
		return {
			...place,
			name: drivePath === "/" ? "OneDrive" : item.name,
			siteId: null,
			siteName: null,
			libraryName: null,
		};
	}

	const siteId = choice.siteId;
	if (!siteId) {
		throw new ORPCError("BAD_REQUEST", {
			message: "Choose a SharePoint folder through its site.",
			data: { driveId: choice.driveId, itemId: choice.itemId },
		});
	}
	const libraries = await readGraph<SharePointDriveList>(
		caller,
		"list_sharepoint_site_drives",
		{ siteId },
	);
	const library =
		libraries.status === "ok"
			? libraries.drives.find((drive) => drive.id === item.driveId)
			: undefined;
	if (!library) {
		throw new ORPCError("BAD_REQUEST", {
			message: "That folder is not in the chosen SharePoint site.",
			data: { driveId: choice.driveId, itemId: choice.itemId },
		});
	}
	return {
		...place,
		name: drivePath === "/" ? library.name : item.name,
		siteId,
		siteName: await confirmedSiteName(caller, siteId, choice.siteName),
		libraryName: library.name,
	};
}

/**
 * The drive paths of the project's connected transcript folders in the given
 * drives, which only Graph knows, so the overlap refusal can compare them. A
 * transcript folder gone from its drive overlaps nothing; one that cannot be
 * looked up now refuses the connect, to be tried again, rather than skip the
 * check.
 */
async function transcriptFolderPaths(
	caller: GraphCaller,
	projectId: string,
	driveIds: string[],
): Promise<TranscriptFolderDrivePath[]> {
	const transcripts = await db.projectTranscriptFolder.findMany({
		where: { projectId, disconnectedAt: null, driveId: { in: driveIds } },
		select: { driveId: true, itemId: true },
	});
	const paths: TranscriptFolderDrivePath[] = [];
	for (const transcript of transcripts) {
		const found = await readGraph<DriveItemDetailsResult>(
			caller,
			"get_drive_item",
			{ driveId: transcript.driveId, itemId: transcript.itemId },
		);
		if (found.status === "ok") {
			paths.push({
				driveId: transcript.driveId,
				itemId: transcript.itemId,
				drivePath: folderDrivePath(found.item),
			});
		} else if (found.httpStatus !== 404) {
			throw graphUnreachable();
		}
	}
	return paths;
}

interface ConnectRequest {
	project: { id: string; organizationId: string };
	caller: GraphCaller;
	folders: DocumentFolderSelection[];
	context: Parameters<typeof recordAuditFromRequest>[0];
}

/**
 * Connect, or reconnect, folders whose places were read from Graph: refused
 * by name when they overlap another connected folder, then one audit row per
 * folder and a wake for the project's sync. A sync that cannot be started
 * shows on the folders, which are connected all the same.
 */
async function connectAndWake(request: ConnectRequest) {
	const { project, caller, folders, context } = request;
	const driveIds = [...new Set(folders.map((folder) => folder.driveId))];
	const transcriptPaths = await transcriptFolderPaths(
		caller,
		project.id,
		driveIds,
	);

	let connected: Awaited<ReturnType<typeof connectDocumentFolders>>;
	try {
		connected = await connectDocumentFolders({
			projectId: project.id,
			userId: caller.userId,
			organizationId: project.organizationId,
			folders,
			transcriptFolderPaths: transcriptPaths,
		});
	} catch (error) {
		throw folderConnectRefusal(error);
	}

	for (const result of connected) {
		const folder = folders.find(
			(f) => f.driveId === result.driveId && f.itemId === result.itemId,
		);
		const provider = folder?.provider ?? null;
		recordAuditFromRequest(context, {
			action: result.reconnected
				? "project.document_folder.reconnected"
				: "project.document_folder.connected",
			category: "project",
			organizationId: project.organizationId,
			projectId: project.id,
			resource: folderResource({
				id: result.folderId,
				name: result.name,
			}),
			// Never the description's text.
			metadata: result.reconnected
				? {
						provider,
						previousReaderId: result.previousUserId,
						readerId: caller.userId,
					}
				: {
						provider,
						hasDescription: Boolean(folder?.description?.trim()),
					},
		});
	}

	const importStarted = await wakeDocumentFolderSync(project);
	if (!importStarted) {
		await recordSyncNotStarted(connected);
	}
	return { connected, importStarted };
}

export const connectDocumentFoldersProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/document-folders/connect",
		tags: TAGS,
		summary: "Connect OneDrive or SharePoint document folders",
		description:
			"Connects folders to a project, each with an optional description. Their supported files, subfolders included, are imported as project context and kept in step with the drive, read with the caller's Microsoft connection. A folder that is, holds or lies inside another connected folder is refused.",
	})
	.input(
		projectInput.extend({
			folders: z
				.array(
					z.object({
						driveId: z.string().min(1),
						itemId: z.string().min(1),
						siteId: z.string().min(1).nullable().optional(),
						siteName: z.string().max(255).nullable().optional(),
						// Left out, a reconnected folder keeps its description.
						description: z
							.string()
							.max(DOCUMENT_FOLDER_DESCRIPTION_MAX)
							.nullable()
							.optional(),
					}),
				)
				.min(1)
				.max(DOCUMENT_FOLDER_MAX_PER_PROJECT),
		}),
	)
	.handler(async ({ input, context }) => {
		const project = await loadEnabledProject(input.projectId);
		assertInputOrgMatchesProject(input.organizationId, project);
		const caller = await graphCaller(
			context.user.id,
			project.organizationId,
		);
		const folders: DocumentFolderSelection[] = [];
		for (const choice of input.folders) {
			const place = await placeOf(caller, choice);
			folders.push(
				choice.description === undefined
					? place
					: { ...place, description: choice.description },
			);
		}

		const { connected, importStarted } = await connectAndWake({
			project,
			caller,
			folders,
			context,
		});
		return {
			folders: connected.map((result) => ({
				folderId: result.folderId,
				name: result.name,
				reconnected: result.reconnected,
			})),
			importStarted,
		};
	});

export const reconnectDocumentFolderProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/document-folders/reconnect",
		tags: TAGS,
		summary: "Reconnect a document folder",
		description:
			"Makes the caller the folder's reader: it is read with their Microsoft connection from then on, and its imported files become theirs. Its description stays.",
	})
	.input(projectInput.extend({ folderId: z.string().min(1) }))
	.handler(async ({ input, context }) => {
		const project = await loadEnabledProject(input.projectId);
		assertInputOrgMatchesProject(input.organizationId, project);
		const stored = await db.projectDocumentFolder.findFirst({
			where: {
				id: input.folderId,
				projectId: project.id,
				disconnectedAt: null,
			},
			select: {
				driveId: true,
				itemId: true,
				siteId: true,
				siteName: true,
			},
		});
		if (!stored) {
			throw folderNotFound();
		}
		const caller = await graphCaller(
			context.user.id,
			project.organizationId,
		);
		const place = await placeOf(caller, stored);

		const { connected, importStarted } = await connectAndWake({
			project,
			caller,
			folders: [
				{
					...place,
					// The row being reconnected, however Graph spells its ids
					// today, so a reconnect never adds a second folder.
					driveId: stored.driveId,
					itemId: stored.itemId,
					// A site name Graph no longer confirms keeps the stored one.
					siteName: place.siteName ?? stored.siteName,
				},
			],
			context,
		});
		return {
			folderId: connected[0]?.folderId ?? input.folderId,
			importStarted,
		};
	});
