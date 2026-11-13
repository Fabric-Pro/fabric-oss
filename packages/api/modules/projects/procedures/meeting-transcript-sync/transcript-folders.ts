import { ORPCError } from "@orpc/server";
import {
	connectTranscriptFolders,
	db,
	disconnectTranscriptFolder,
	listTranscriptFolders,
	recordTranscriptFolderRead,
	resolveOwnWorkflowIntegrationForProvider,
} from "@repo/database";
import {
	type DriveFolderItem,
	executeMicrosoftTeamsTool,
	isMicrosoftNotConnectedError,
} from "@repo/integrations/microsoft";
import { logger } from "@repo/logs";
import { getTemporalClient } from "@repo/temporal";
import {
	TRANSCRIPT_UPLOAD_MAX_BYTES,
	transcriptUploadFormatOf,
} from "@repo/utils";
import { z } from "zod";
import { assertInputOrgMatchesProject } from "../../../../lib/authorized-project-tenant";
import { withCorrelationMemo } from "../../../../lib/temporal-correlation";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * OneDrive transcript folders (Fizzy #3507).
 *
 * Connecting, listing and disconnecting take the same permission as linking a
 * Teams meeting, PROJECT_UPDATE, since a folder is one more meeting source.
 * The folder is read with the Microsoft connection of whoever connects it, so
 * browsing reads the caller's own OneDrive.
 */

const MICROSOFT_NOT_CONNECTED =
	"Connect your Microsoft account in Settings → Integrations to choose OneDrive folders.";

/**
 * The project, from its own row: the tenant never comes from the input. Each
 * handler checks the input's organization against it itself.
 */
async function loadProject(projectId: string) {
	const project = await db.project.findUnique({
		where: { id: projectId },
		select: { id: true, organizationId: true },
	});
	if (!project) {
		throw new ORPCError("NOT_FOUND", { message: "Project not found" });
	}
	return project;
}

const SYNC_NOT_STARTED =
	"Importing could not be started. Reconnect the folder to try again.";

/**
 * The caller's own Microsoft connection. Not a connection someone shared with
 * the organization: "My OneDrive" has to be the viewer's, and a folder chosen
 * here is read as them from then on.
 */
async function ownMicrosoftConnectionId(
	userId: string,
	organizationId: string | undefined,
): Promise<string> {
	const own = await resolveOwnWorkflowIntegrationForProvider(
		"MICROSOFT_GRAPH",
		userId,
		organizationId,
	);
	if (!own) {
		throw new ORPCError("PRECONDITION_FAILED", {
			message: MICROSOFT_NOT_CONNECTED,
			data: { code: "MICROSOFT_NOT_CONNECTED" },
		});
	}
	return own.id;
}

/** Wake the project's folder sync, starting it if it is not running. */
async function wakeFolderSync(projectId: string): Promise<void> {
	const client = await getTemporalClient();
	await client.workflow.signalWithStart(
		"transcriptFolderSyncWorkflow",
		withCorrelationMemo({
			taskQueue: "project-documents",
			workflowId: `transcript-folder-sync-${projectId}`,
			args: [{ projectId }],
			signal: "syncTranscriptFoldersNow",
			signalArgs: [],
		}),
	);
}

const projectInput = z.object({
	projectId: z.string(),
	organizationId: z.string().nullable().optional(),
});

export const browseTranscriptFoldersProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/meeting-transcript-sync/folders/browse",
		tags: ["Projects", "Meeting Transcript Sync"],
		summary: "Browse OneDrive folders",
		description:
			"Lists the folders inside a OneDrive folder, or the caller's OneDrive root, with how many supported transcript files each level holds.",
	})
	.input(
		projectInput.extend({
			driveId: z.string().min(1).optional(),
			itemId: z.string().min(1).optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const project = await loadProject(input.projectId);
		assertInputOrgMatchesProject(input.organizationId, project);
		const organizationId = project.organizationId ?? undefined;
		const connectionId = await ownMicrosoftConnectionId(
			context.user.id,
			organizationId,
		);

		let listing: { items: DriveFolderItem[]; truncated: boolean };
		try {
			listing = (await executeMicrosoftTeamsTool(
				"list_drive_children",
				{
					driveId: input.driveId,
					itemId: input.itemId,
					maxItems: 1000,
				},
				context.user.id,
				organizationId,
				connectionId,
			)) as { items: DriveFolderItem[]; truncated: boolean };
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error);
			if (isMicrosoftNotConnectedError(message)) {
				throw new ORPCError("PRECONDITION_FAILED", {
					message: MICROSOFT_NOT_CONNECTED,
					data: { code: "MICROSOFT_NOT_CONNECTED" },
				});
			}
			logger.warn("[TranscriptFolders] OneDrive could not be browsed", {
				projectId: input.projectId,
				error: message,
			});
			throw new ORPCError("BAD_GATEWAY", {
				message: "OneDrive could not be read. Try again in a moment.",
			});
		}

		return {
			folders: listing.items
				.filter((item) => item.isFolder)
				.map((item) => ({
					driveId: item.driveId,
					itemId: item.id,
					name: item.name,
					childCount: item.childCount ?? 0,
					webUrl: item.webUrl,
				})),
			// What this level would import, for the empty-folder state.
			transcriptFileCount: listing.items.filter(
				(item) =>
					!item.isFolder &&
					transcriptUploadFormatOf(item.name) !== null &&
					(item.size ?? 0) <= TRANSCRIPT_UPLOAD_MAX_BYTES,
			).length,
			truncated: listing.truncated,
		};
	});

export const connectTranscriptFoldersProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/meeting-transcript-sync/folders/connect",
		tags: ["Projects", "Meeting Transcript Sync"],
		summary: "Connect OneDrive transcript folders",
		description:
			"Connects OneDrive folders to a project. Existing and future supported transcript files directly in each folder are imported, read with the caller's Microsoft connection.",
	})
	.input(
		projectInput.extend({
			folders: z
				.array(
					z.object({
						driveId: z.string().min(1),
						itemId: z.string().min(1),
						name: z.string().min(1).max(255),
						webUrl: z.string().url().nullable().optional(),
					}),
				)
				.min(1)
				.max(20),
		}),
	)
	.handler(async ({ input, context }) => {
		const project = await loadProject(input.projectId);
		assertInputOrgMatchesProject(input.organizationId, project);
		const organizationId = project.organizationId ?? undefined;
		const connectionId = await ownMicrosoftConnectionId(
			context.user.id,
			organizationId,
		);

		// Each folder must be one the caller can read now: the sync will read
		// it as them, and an id typed in by hand is not a folder they chose.
		for (const folder of input.folders) {
			try {
				await executeMicrosoftTeamsTool(
					"list_drive_children",
					{
						driveId: folder.driveId,
						itemId: folder.itemId,
						maxItems: 1,
					},
					context.user.id,
					organizationId,
					connectionId,
				);
			} catch (error) {
				const message =
					error instanceof Error ? error.message : String(error);
				throw new ORPCError(
					isMicrosoftNotConnectedError(message)
						? "PRECONDITION_FAILED"
						: "BAD_REQUEST",
					{
						message: isMicrosoftNotConnectedError(message)
							? MICROSOFT_NOT_CONNECTED
							: `${folder.name} could not be read: ${message}`,
					},
				);
			}
		}

		const connected = await connectTranscriptFolders({
			projectId: input.projectId,
			userId: context.user.id,
			organizationId,
			folders: input.folders,
		});

		try {
			await wakeFolderSync(input.projectId);
		} catch (error) {
			// Nothing else would start it: the interval lives in the workflow
			// that failed to start. The folders say so, and Reconnect retries.
			logger.error(
				"[TranscriptFolders] Folder sync could not be started",
				{
					projectId: input.projectId,
					error:
						error instanceof Error ? error.message : String(error),
				},
			);
			await Promise.all(
				connected.map((folder) =>
					recordTranscriptFolderRead({
						folderId: folder.id,
						error: SYNC_NOT_STARTED,
					}),
				),
			);
			return { connected: connected.length, importStarted: false };
		}

		return { connected: connected.length, importStarted: true };
	});

export const listTranscriptFoldersProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "POST",
		path: "/projects/{projectId}/meeting-transcript-sync/folders",
		tags: ["Projects", "Meeting Transcript Sync"],
		summary: "List connected OneDrive transcript folders",
		description:
			"Lists a project's connected OneDrive transcript folders with their import progress, and why files were skipped or failed.",
	})
	.input(projectInput)
	.handler(async ({ input }) => {
		const project = await loadProject(input.projectId);
		assertInputOrgMatchesProject(input.organizationId, project);
		return { folders: await listTranscriptFolders(input.projectId) };
	});

export const disconnectTranscriptFolderProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/meeting-transcript-sync/folders/disconnect",
		tags: ["Projects", "Meeting Transcript Sync"],
		summary: "Disconnect a OneDrive transcript folder",
		description:
			"Stops importing from a folder. Transcripts already imported from it stay.",
	})
	.input(projectInput.extend({ folderId: z.string().min(1) }))
	.handler(async ({ input }) => {
		const project = await loadProject(input.projectId);
		assertInputOrgMatchesProject(input.organizationId, project);
		const disconnected = await disconnectTranscriptFolder({
			projectId: input.projectId,
			folderId: input.folderId,
		});
		if (!disconnected) {
			throw new ORPCError("NOT_FOUND", {
				message: "Folder not found",
			});
		}
		return { disconnected: true };
	});
