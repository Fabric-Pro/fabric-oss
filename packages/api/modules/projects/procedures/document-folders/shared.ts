import { ORPCError } from "@orpc/server";
import {
	DOCUMENT_FOLDER_PROBLEM_CODE,
	db,
	finishDocumentFolderRead,
	resolveOwnWorkflowIntegrationForProvider,
} from "@repo/database";
import {
	executeMicrosoftTeamsTool,
	isMicrosoftNotConnectedError,
} from "@repo/integrations/microsoft";
import { logger } from "@repo/logs";
import { getTemporalClient } from "@repo/temporal";
import { z } from "zod";
import { withCorrelationMemo } from "../../../../lib/temporal-correlation";
import { assertCloudDriveFoldersEnabled } from "../../lib/cloud-drive-folders-feature";

/**
 * OneDrive and SharePoint document folders (Fizzy #2808).
 *
 * Every procedure loads the project row, refuses an input organization that
 * is not the project's, and answers NOT_FOUND while the feature is off for
 * the project's organization. A folder is browsed and connected with the
 * caller's own Microsoft connection, and is read with it from then on.
 */

export const LOG = "[DocumentFolders]";

const MICROSOFT_NOT_CONNECTED =
	"Connect your Microsoft account in Settings → Integrations to choose OneDrive or SharePoint folders.";

export const projectInput = z.object({
	projectId: z.string(),
	organizationId: z.string().nullable().optional(),
});

/**
 * The project, from its own row, with the organization the feature is on
 * for. The tenant never comes from the input: each handler checks the input's
 * organization against this itself.
 */
export async function loadEnabledProject(
	projectId: string,
): Promise<{ id: string; organizationId: string }> {
	const project = await db.project.findUnique({
		where: { id: projectId },
		select: { id: true, organizationId: true },
	});
	if (!project) {
		throw new ORPCError("NOT_FOUND", { message: "Project not found" });
	}
	const organizationId = await assertCloudDriveFoldersEnabled(
		project.organizationId,
	);
	return { id: project.id, organizationId };
}

export function microsoftNotConnected(): ORPCError<string, unknown> {
	return new ORPCError("PRECONDITION_FAILED", {
		message: MICROSOFT_NOT_CONNECTED,
		data: { code: "MICROSOFT_NOT_CONNECTED" },
	});
}

/** Who Graph is called as: the caller, through their own connection. */
export interface GraphCaller {
	userId: string;
	organizationId: string;
	connectionId: string;
}

/**
 * The caller's own Microsoft connection. Not one someone shared with the
 * organization: a folder chosen here is read as the caller from then on.
 */
export async function graphCaller(
	userId: string,
	organizationId: string,
): Promise<GraphCaller> {
	const own = await resolveOwnWorkflowIntegrationForProvider(
		"MICROSOFT_GRAPH",
		userId,
		organizationId,
	);
	if (!own) {
		throw microsoftNotConnected();
	}
	return { userId, organizationId, connectionId: own.id };
}

/**
 * One Graph read as the caller. A revoked connection becomes the connect
 * prompt; any other failure is the caller's to handle.
 */
export async function callGraph<T>(
	caller: GraphCaller,
	method: string,
	args: Record<string, unknown>,
): Promise<T> {
	try {
		return (await executeMicrosoftTeamsTool(
			method,
			args,
			caller.userId,
			caller.organizationId,
			caller.connectionId,
		)) as T;
	} catch (error) {
		if (
			isMicrosoftNotConnectedError(
				error instanceof Error ? error.message : String(error),
			)
		) {
			throw microsoftNotConnected();
		}
		throw error;
	}
}

export function graphUnreachable(): ORPCError<string, unknown> {
	return new ORPCError("BAD_GATEWAY", {
		message: "Microsoft could not be reached. Try again in a moment.",
	});
}

/**
 * A Graph read whose failure, other than the connect prompt, is answered
 * with a fixed try-again: Graph's own error text never reaches the client.
 */
export async function readGraph<T>(
	caller: GraphCaller,
	method: string,
	args: Record<string, unknown>,
): Promise<T> {
	try {
		return await callGraph<T>(caller, method, args);
	} catch (error) {
		if (error instanceof ORPCError) {
			throw error;
		}
		logger.warn(`${LOG} Graph read failed`, {
			method,
			errorName: error instanceof Error ? error.name : typeof error,
		});
		throw graphUnreachable();
	}
}

/**
 * Wake the project's document-folder sync, starting it if it is not running.
 * False when it could not be reached; the caller decides what that means.
 */
export async function wakeDocumentFolderSync(project: {
	id: string;
	organizationId: string;
}): Promise<boolean> {
	try {
		const client = await getTemporalClient();
		await client.workflow.signalWithStart(
			"documentFolderSyncWorkflow",
			withCorrelationMemo({
				taskQueue: "project-documents",
				workflowId: `document-folder-sync-${project.id}`,
				args: [
					{
						projectId: project.id,
						organizationId: project.organizationId,
					},
				],
				signal: "syncDocumentFoldersNow",
				signalArgs: [],
			}),
		);
		return true;
	} catch (error) {
		logger.error(`${LOG} Folder sync could not be started`, {
			projectId: project.id,
			errorName: error instanceof Error ? error.name : typeof error,
		});
		return false;
	}
}

/**
 * Folders just connected whose sync could not be started say so. Nothing
 * else would start it: the interval lives in the workflow that did not
 * start. Reconnect, or Sync now, retries.
 */
export async function recordSyncNotStarted(
	folders: Array<{ folderId: string; readerEpoch: number }>,
) {
	await Promise.all(
		folders.map(({ folderId, readerEpoch }) =>
			finishDocumentFolderRead({
				folderId,
				readerEpoch,
				problemCode: DOCUMENT_FOLDER_PROBLEM_CODE.SYNC_START_FAILED,
			}),
		),
	);
}

export function folderNotFound() {
	return new ORPCError("NOT_FOUND", { message: "Folder not found" });
}

/** The audit resource for a folder. Its description never goes here. */
export function folderResource(folder: { id: string; name: string }) {
	return {
		type: "project_document_folder",
		id: folder.id,
		name: folder.name,
	};
}
