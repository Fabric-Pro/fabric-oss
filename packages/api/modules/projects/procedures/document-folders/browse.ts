import { ORPCError } from "@orpc/server";
import { classifyDocumentFolderFile } from "@repo/database";
import {
	browseGoogleDriveFolder,
	browseGoogleDrivePlaces,
	DOCUMENT_FOLDER_BROWSE_MAX_ITEMS,
	type DocumentFolderConnection,
} from "@repo/integrations/document-folders";
import type {
	DriveFolderItem,
	SharePointDriveList,
	SharePointSite,
	SharePointSiteList,
} from "@repo/integrations/microsoft";
import { logger } from "@repo/logs";
import { z } from "zod";
import { assertInputOrgMatchesProject } from "../../../../lib/authorized-project-tenant";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	callGraph,
	folderSourceInput,
	type GraphCaller,
	googleDriveReader,
	graphCaller,
	LOG,
	loadEnabledProject,
	projectInput,
	readGoogleDrive,
	readGraph,
} from "./shared";

/** A SharePoint site the picker can open. */
interface DocumentFolderBrowseSite {
	siteId: string;
	name: string;
	webUrl: string | null;
}

/** A site's document library, opened at its root. */
interface DocumentFolderBrowseLibrary {
	driveId: string;
	name: string;
	webUrl: string | null;
}

/** A folder the picker can open or choose. */
interface DocumentFolderBrowseFolder {
	driveId: string;
	itemId: string;
	name: string;
	/** Absent for Google Drive, which does not count a folder's children. */
	childCount?: number;
	webUrl: string | null;
}

/** A Google Drive place: My Drive by its root folder's id, or a shared drive. */
interface DocumentFolderBrowsePlace {
	driveId: string;
	name: string;
}

/**
 * One level of the picker. SharePoint answers `unavailable` for an account
 * without it, such as a personal one; at the top level, a followed-sites
 * read that failed is an `error` for SharePoint alone.
 */
type DocumentFolderBrowseResult =
	| {
			level: "roots";
			provider: "microsoft";
			oneDrive: { status: "available" };
			sharePoint:
				| {
						status: "available";
						followedSites: DocumentFolderBrowseSite[];
				  }
				| { status: "unavailable" }
				| { status: "error" };
	  }
	| {
			level: "sites";
			status: "available";
			sites: DocumentFolderBrowseSite[];
	  }
	| { level: "sites"; status: "unavailable" }
	| {
			level: "drives";
			siteId: string;
			status: "available";
			libraries: DocumentFolderBrowseLibrary[];
	  }
	| { level: "drives"; siteId: string; status: "unavailable" }
	| {
			level: "roots";
			provider: "googledrive";
			myDrive: DocumentFolderBrowsePlace;
			/** Empty when the person belongs to no shared drive. */
			sharedDrives: DocumentFolderBrowsePlace[];
	  }
	| {
			level: "folders";
			/** Null for My OneDrive's root. */
			driveId: string | null;
			itemId: string | null;
			folders: DocumentFolderBrowseFolder[];
			/** Files directly at this level the upload vocabulary would import. */
			supportedFileCount: number;
			truncated: boolean;
	  };

function toSite(site: SharePointSite): DocumentFolderBrowseSite {
	return { siteId: site.id, name: site.name, webUrl: site.webUrl };
}

async function browseRoots(
	caller: GraphCaller,
): Promise<DocumentFolderBrowseResult> {
	let followed: SharePointSiteList | null;
	try {
		followed = await callGraph<SharePointSiteList>(
			caller,
			"list_followed_sharepoint_sites",
			{},
		);
	} catch (error) {
		if (error instanceof ORPCError) {
			throw error;
		}
		logger.warn(`${LOG} Followed SharePoint sites could not be read`, {
			errorName: error instanceof Error ? error.name : typeof error,
		});
		followed = null;
	}
	return {
		level: "roots",
		provider: "microsoft",
		oneDrive: { status: "available" },
		sharePoint:
			followed === null
				? { status: "error" }
				: followed.status === "unavailable"
					? { status: "unavailable" }
					: {
							status: "available",
							followedSites: followed.sites.map(toSite),
						},
	};
}

/** Files directly at a level that the upload vocabulary would import. */
function supportedFileCount(
	items: Array<{
		isFolder: boolean;
		name: string;
		mimeType: string | null;
		size: number | null;
	}>,
): number {
	return items.filter(
		(item) =>
			!item.isFolder &&
			classifyDocumentFolderFile(item).status === "PENDING",
	).length;
}

/**
 * One level of the Google Drive picker: My Drive and the shared drives, or
 * a folder's folders. A level opens at its place's root, whose id is the
 * place's, unless a folder inside it is named.
 */
async function browseGoogleDrive(
	reader: DocumentFolderConnection,
	level: z.infer<typeof levelInput>,
): Promise<DocumentFolderBrowseResult> {
	if (level.kind === "roots") {
		const places = await readGoogleDrive("places", () =>
			browseGoogleDrivePlaces(reader),
		);
		return {
			level: "roots",
			provider: "googledrive",
			myDrive: { driveId: places.myDrive.id, name: places.myDrive.name },
			sharedDrives: places.sharedDrives.map((drive) => ({
				driveId: drive.id,
				name: drive.name,
			})),
		};
	}
	if (level.kind !== "folders" || !level.driveId) {
		throw new ORPCError("BAD_REQUEST", {
			message:
				"Google Drive folders are opened from My Drive or a shared drive.",
		});
	}
	const driveId = level.driveId;
	const folderId = level.itemId ?? driveId;
	const listing = await readGoogleDrive("folder", () =>
		browseGoogleDriveFolder(reader, {
			folderId,
			maxItems: DOCUMENT_FOLDER_BROWSE_MAX_ITEMS,
		}),
	);
	return {
		level: "folders",
		driveId,
		itemId: folderId,
		folders: listing.items
			.filter((item) => item.isFolder)
			.map((item) => ({
				driveId,
				itemId: item.id,
				name: item.name,
				webUrl: item.webUrl,
			})),
		supportedFileCount: supportedFileCount(listing.items),
		truncated: listing.truncated,
	};
}

const levelInput = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("roots") }),
	z.object({
		kind: z.literal("sites"),
		search: z.string().trim().min(1).max(200),
	}),
	z.object({ kind: z.literal("drives"), siteId: z.string().min(1) }),
	z.object({
		kind: z.literal("folders"),
		/** Left out for My OneDrive's root. */
		driveId: z.string().min(1).optional(),
		/** Left out for the drive's root. */
		itemId: z.string().min(1).optional(),
	}),
]);

export const browseDocumentFoldersProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/document-folders/browse",
		tags: ["Projects", "Document Folders"],
		summary: "Browse OneDrive, SharePoint and Google Drive folders",
		description:
			"One level of the document-folder picker, read with the caller's own connection. For Microsoft (the default): the top level (My OneDrive and followed SharePoint sites), a SharePoint site search, a site's document libraries, or the folders inside a folder. For Google Drive: My Drive and the caller's shared drives, or the folders inside a folder. A folder level also says how many files at that level would be imported.",
	})
	.input(
		projectInput.extend({
			provider: folderSourceInput,
			level: levelInput,
		}),
	)
	.handler(
		async ({ input, context }): Promise<DocumentFolderBrowseResult> => {
			const project = await loadEnabledProject(input.projectId);
			assertInputOrgMatchesProject(input.organizationId, project);
			const { level } = input;
			if (level.kind === "folders" && level.itemId && !level.driveId) {
				throw new ORPCError("BAD_REQUEST", {
					message: "A folder is opened together with its drive.",
				});
			}
			if (input.provider === "googledrive") {
				return browseGoogleDrive(
					await googleDriveReader(
						context.user.id,
						project.organizationId,
					),
					level,
				);
			}
			const caller = await graphCaller(
				context.user.id,
				project.organizationId,
			);

			switch (level.kind) {
				case "roots":
					return browseRoots(caller);
				case "sites": {
					const found = await readGraph<SharePointSiteList>(
						caller,
						"search_sharepoint_sites",
						{ query: level.search },
					);
					return found.status === "ok"
						? {
								level: "sites",
								status: "available",
								sites: found.sites.map(toSite),
							}
						: { level: "sites", status: "unavailable" };
				}
				case "drives": {
					const found = await readGraph<SharePointDriveList>(
						caller,
						"list_sharepoint_site_drives",
						{ siteId: level.siteId },
					);
					if (found.status === "unavailable") {
						return {
							level: "drives",
							siteId: level.siteId,
							status: "unavailable",
						};
					}
					return {
						level: "drives",
						siteId: level.siteId,
						status: "available",
						libraries: found.drives
							.filter((drive) => drive.provider === "sharepoint")
							.map((drive) => ({
								driveId: drive.id,
								name: drive.name,
								webUrl: drive.webUrl,
							})),
					};
				}
				case "folders": {
					// A library opens at its root; with no drive at all, the tool
					// lists the caller's own OneDrive root.
					const itemId =
						level.itemId ?? (level.driveId ? "root" : undefined);
					const listing = await readGraph<{
						items: DriveFolderItem[];
						truncated: boolean;
					}>(caller, "list_drive_children", {
						driveId: level.driveId,
						itemId,
						maxItems: DOCUMENT_FOLDER_BROWSE_MAX_ITEMS,
					});
					return {
						level: "folders",
						driveId: level.driveId ?? null,
						itemId: itemId ?? null,
						folders: listing.items
							.filter((item) => item.isFolder)
							.map((item) => ({
								driveId: item.driveId,
								itemId: item.id,
								name: item.name,
								childCount: item.childCount ?? 0,
								webUrl: item.webUrl,
							})),
						supportedFileCount: supportedFileCount(
							listing.items.map((item) => ({
								isFolder: item.isFolder,
								name: item.name,
								mimeType: null,
								size: item.size,
							})),
						),
						truncated: listing.truncated,
					};
				}
			}
		},
	);
