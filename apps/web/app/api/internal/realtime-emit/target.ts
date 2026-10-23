/**
 * What the realtime relay route checks before it publishes a worker's event.
 *
 * `AGENT_SERVICE_SECRET` is shared by the Temporal worker, the agent
 * containers and several internal routes, so holding it does not prove that
 * an event is genuine. The route therefore publishes only an event whose
 * target checks out against the database, and whose text is plain:
 *
 * - `message_appended`: the conversation exists and holds the message.
 * - `document_change`: the project exists and the document is one of its
 *   documents; for a deletion, the id is at least not another project's live
 *   document (the row may already be gone).
 * - `context_change`: the project exists and `contextId` is one of its
 *   contexts or its repository sync (the repository sync publishes the sync's
 *   id); for a deletion, which the synced-file deletion publishes after the
 *   row is gone, the id is not another project's live context or sync.
 * - `activity`: the project exists, the user has access to it, `resourceId`
 *   is not another project's live row, and `userName` is replaced by the
 *   user's own name from the database, as the worker reads it.
 *
 * `userName` on the other events stays as sent (the generation run sends a
 * synthetic user), as do the names, which are only checked for length and
 * control characters: the web client refetches on these events and renders
 * none of their text today.
 */

import { db, getUserById, hasProjectAccess } from "@repo/database";
import type { RealtimeRelayRequest } from "@repo/utils/realtime-emit";

/** The longest name or other text field an event may carry. */
const MAX_TEXT_LENGTH = 512;

/** An `activityType`, as the worker writes them: `context_deleted`. */
const ACTIVITY_TYPE = /^[a-z][a-z0-9_]{0,63}$/;

/** Where a resource an activity may name lives, or null for any other kind. */
function resourceTables(
	resourceType: string,
): readonly ProjectRowTable[] | null {
	switch (resourceType) {
		case "context":
			return ["context"];
		case "document":
			return ["document"];
		default:
			return null;
	}
}

/** Short, and free of C0 and C1 control characters (line breaks included). */
function isPlainText(value: string): boolean {
	if (value.length > MAX_TEXT_LENGTH) {
		return false;
	}
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
			return false;
		}
	}
	return true;
}

function isDate(value: string): boolean {
	return !Number.isNaN(Date.parse(value));
}

/**
 * Whether every text field of the event is plain, and the activity and date
 * fields have the form the worker writes. Checked before any query.
 */
export function hasPlainText(relayed: RealtimeRelayRequest): boolean {
	const texts = Object.values(relayed.data).filter(
		(value): value is string => typeof value === "string",
	);
	if (!texts.every(isPlainText)) {
		return false;
	}
	switch (relayed.event) {
		case "message_appended":
			return isDate(relayed.data.appendedAt);
		case "activity": {
			const { activityType, resourceType, resourceId, timestamp } =
				relayed.data;
			return (
				ACTIVITY_TYPE.test(activityType) &&
				(resourceType === undefined ||
					resourceTables(resourceType) !== null) &&
				(resourceId === undefined || resourceType !== undefined) &&
				isDate(timestamp)
			);
		}
		default:
			return true;
	}
}

type ProjectRowTable = "document" | "context" | "contextSync";

type ProjectRowWhere =
	| { id: string; projectId: string }
	| { id: string; NOT: { projectId: string } };

const projectRows: Record<
	ProjectRowTable,
	(where: ProjectRowWhere) => Promise<{ id: string } | null>
> = {
	document: (where) =>
		db.projectDocument.findFirst({ where, select: { id: true } }),
	context: (where) =>
		db.projectContext.findFirst({ where, select: { id: true } }),
	contextSync: (where) =>
		db.projectContextRepositorySync.findFirst({
			where,
			select: { id: true },
		}),
};

/** The id is a row of `projectId` in one of the tables. */
async function isRowOfProject(
	tables: readonly ProjectRowTable[],
	id: string,
	projectId: string,
): Promise<boolean> {
	for (const table of tables) {
		if (await projectRows[table]({ id, projectId })) {
			return true;
		}
	}
	return false;
}

/** The id is no other project's live row in any of the tables. */
async function isNoOtherProjectsRow(
	tables: readonly ProjectRowTable[],
	id: string,
	projectId: string,
): Promise<boolean> {
	for (const table of tables) {
		if (await projectRows[table]({ id, NOT: { projectId } })) {
			return false;
		}
	}
	return true;
}

async function projectExists(projectId: string): Promise<boolean> {
	const project = await db.project.findUnique({
		where: { id: projectId },
		select: { id: true },
	});
	return project !== null;
}

/**
 * The event to publish, once its target checks out (see the header), or null
 * to refuse it. For `activity` the returned event carries the user's own name.
 */
export async function checkRelayedTarget(
	relayed: RealtimeRelayRequest,
): Promise<RealtimeRelayRequest | null> {
	if (relayed.event === "message_appended") {
		const conversation = await db.agentConversation.findFirst({
			where: {
				id: relayed.data.conversationId,
				messages: { array_contains: [{ id: relayed.data.messageId }] },
			},
			select: { id: true },
		});
		return conversation ? relayed : null;
	}

	const { projectId } = relayed.data;
	if (!(await projectExists(projectId))) {
		return null;
	}

	switch (relayed.event) {
		case "document_change": {
			const { documentId, action } = relayed.data;
			const checksOut =
				action === "deleted"
					? await isNoOtherProjectsRow(
							["document"],
							documentId,
							projectId,
						)
					: await isRowOfProject(["document"], documentId, projectId);
			return checksOut ? relayed : null;
		}
		case "context_change": {
			const { contextId, action } = relayed.data;
			const tables = ["context", "contextSync"] as const;
			const checksOut =
				action === "deleted"
					? await isNoOtherProjectsRow(tables, contextId, projectId)
					: await isRowOfProject(tables, contextId, projectId);
			return checksOut ? relayed : null;
		}
		case "activity": {
			const { userId, resourceType, resourceId } = relayed.data;
			if (!(await hasProjectAccess(projectId, userId))) {
				return null;
			}
			if (resourceId !== undefined) {
				const tables =
					resourceType === undefined
						? null
						: resourceTables(resourceType);
				if (
					!tables ||
					!(await isNoOtherProjectsRow(tables, resourceId, projectId))
				) {
					return null;
				}
			}
			const user = await getUserById(userId);
			return {
				...relayed,
				data: { ...relayed.data, userName: user?.name || "Anonymous" },
			};
		}
	}
}
