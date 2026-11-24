import { ORPCError } from "@orpc/server";
import {
	confirmDocumentFolderRemovals,
	DOCUMENT_FOLDER_DESCRIPTION_MAX,
	db,
	describeDocumentFolder,
	disconnectDocumentFolder,
	listDocumentFolders,
} from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import { assertInputOrgMatchesProject } from "../../../../lib/authorized-project-tenant";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
	userHasProjectPermission,
} from "../../../../orpc/procedures";
import {
	folderNotFound,
	folderResource,
	loadEnabledProject,
	projectInput,
	wakeDocumentFolderSync,
} from "./shared";

const TAGS = ["Projects", "Document Folders"];

export const listDocumentFoldersProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "POST",
		path: "/projects/{projectId}/document-folders",
		tags: TAGS,
		summary: "List connected document folders",
		description:
			"Lists a project's connected OneDrive and SharePoint document folders with their import counts and state. Editors also get each folder's reader, drive identifiers, web address and the files that need attention.",
	})
	.input(projectInput)
	.handler(async ({ input, context }) => {
		const project = await loadEnabledProject(input.projectId);
		assertInputOrgMatchesProject(input.organizationId, project);
		// Viewers and guests see a folder's place, description, counts and
		// state, never whose connection reads it or where it lives in Graph.
		const editor = await userHasProjectPermission({
			userId: context.user.id,
			projectId: project.id,
			permission: Permissions.PROJECT_UPDATE,
		});
		if (editor) {
			return {
				view: "editor" as const,
				folders: await listDocumentFolders({
					projectId: project.id,
					view: "editor",
				}),
			};
		}
		return {
			view: "viewer" as const,
			folders: await listDocumentFolders({
				projectId: project.id,
				view: "viewer",
			}),
		};
	});

export const updateDocumentFolderDescriptionProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/document-folders/description",
		tags: TAGS,
		summary: "Describe a document folder",
		description:
			"Sets or clears a connected folder's description, which the model sees as the source guidance of every file imported from it. Stored on one line without control characters.",
	})
	.input(
		projectInput.extend({
			folderId: z.string().min(1),
			description: z
				.string()
				.max(DOCUMENT_FOLDER_DESCRIPTION_MAX)
				.nullable(),
		}),
	)
	.handler(async ({ input, context }) => {
		const project = await loadEnabledProject(input.projectId);
		assertInputOrgMatchesProject(input.organizationId, project);
		const result = await describeDocumentFolder({
			projectId: project.id,
			folderId: input.folderId,
			description: input.description,
		});
		if (!result) {
			throw folderNotFound();
		}
		recordAuditFromRequest(context, {
			action: "project.document_folder.updated",
			category: "project",
			organizationId: project.organizationId,
			projectId: project.id,
			resource: folderResource({
				id: input.folderId,
				name: result.name,
			}),
			// Whether there is guidance, never what it says.
			metadata: {
				descriptionSet: result.description !== null,
				previouslySet: result.previous !== null,
			},
		});
		return { description: result.description };
	});

export const syncDocumentFoldersNowProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/document-folders/sync",
		tags: TAGS,
		summary: "Sync document folders now",
		description:
			"Reads the project's connected document folders now, whether or not a sync is running, starting the sync if it had ended.",
	})
	.input(projectInput)
	.handler(async ({ input }) => {
		const project = await loadEnabledProject(input.projectId);
		assertInputOrgMatchesProject(input.organizationId, project);
		const connected = await db.projectDocumentFolder.count({
			where: { projectId: project.id, disconnectedAt: null },
		});
		if (connected === 0) {
			throw new ORPCError("NOT_FOUND", {
				message: "No document folders are connected",
			});
		}
		// Not recorded on the folders: a sync that is running keeps running,
		// and only the caller's request went unanswered.
		if (!(await wakeDocumentFolderSync(project))) {
			throw new ORPCError("SERVICE_UNAVAILABLE", {
				message:
					"The sync could not be started. Try again in a moment.",
			});
		}
		return { syncStarted: true };
	});

export const confirmDocumentFolderRemovalsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/document-folders/confirm-removals",
		tags: TAGS,
		summary: "Confirm a document folder's held removals",
		description:
			"Removes the files a read held back because removing them all at once looked like a mistake: their context, vectors and stored copies are deleted. Names the held count the caller was shown; when the folder now holds a different number, nothing is removed and the current count is returned to confirm again.",
	})
	.input(
		projectInput.extend({
			folderId: z.string().min(1),
			/** The held count the caller was shown. */
			expectedCount: z.number().int().min(0),
		}),
	)
	.handler(async ({ input, context }) => {
		const project = await loadEnabledProject(input.projectId);
		assertInputOrgMatchesProject(input.organizationId, project);
		// Read before confirming, which clears the held count.
		const folder = await db.projectDocumentFolder.findFirst({
			where: {
				id: input.folderId,
				projectId: project.id,
				disconnectedAt: null,
			},
			select: { name: true, heldRemovalCount: true },
		});
		if (!folder) {
			throw folderNotFound();
		}
		const result = await confirmDocumentFolderRemovals({
			projectId: project.id,
			folderId: input.folderId,
			expectedCount: input.expectedCount,
		});
		if (result.status === "not_found") {
			throw folderNotFound();
		}
		if (result.status === "nothing_held") {
			return { status: "nothing_held" as const };
		}
		// A read changed the hold since the caller was shown it: nothing was
		// removed, so there is nothing to audit.
		if (result.status === "stale") {
			return {
				status: "stale" as const,
				heldRemovalCount: result.heldRemovalCount,
			};
		}
		recordAuditFromRequest(context, {
			action: "project.document_folder.removals_confirmed",
			category: "project",
			organizationId: project.organizationId,
			projectId: project.id,
			resource: folderResource({ id: input.folderId, name: folder.name }),
			metadata: {
				heldRemovalCount: folder.heldRemovalCount,
				retiredCount: result.retired,
			},
		});
		// The files are already tombstoned; waking the sync only deletes
		// their context sooner than its next pass would.
		const syncStarted = await wakeDocumentFolderSync(project);
		return {
			status: "confirmed" as const,
			retired: result.retired,
			syncStarted,
		};
	});

export const disconnectDocumentFolderProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/document-folders/disconnect",
		tags: TAGS,
		summary: "Disconnect a document folder",
		description:
			"Stops reading a folder. Files already imported from it stay as ordinary project context, and its description no longer applies to them.",
	})
	.input(projectInput.extend({ folderId: z.string().min(1) }))
	.handler(async ({ input, context }) => {
		const project = await loadEnabledProject(input.projectId);
		assertInputOrgMatchesProject(input.organizationId, project);
		const disconnected = await disconnectDocumentFolder({
			projectId: project.id,
			folderId: input.folderId,
		});
		if (!disconnected) {
			throw folderNotFound();
		}
		recordAuditFromRequest(context, {
			action: "project.document_folder.disconnected",
			category: "project",
			organizationId: project.organizationId,
			projectId: project.id,
			resource: folderResource({
				id: input.folderId,
				name: disconnected.name,
			}),
		});
		return { disconnected: true };
	});
