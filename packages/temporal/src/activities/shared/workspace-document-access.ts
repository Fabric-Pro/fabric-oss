import { db } from "@repo/database";
import { authorizeWorkspaceDocumentRead } from "@repo/database/prisma/queries/workspaces/document-content";
import { readWorkspaceDocumentFilters } from "../../lib/workspace-document-selection";

export class WorkspaceSelectionAccessError extends Error {
	constructor() {
		super(
			"A selected workspace or document is unavailable or current access was revoked.",
		);
		this.name = "WorkspaceSelectionAccessError";
	}
}
/** Current access is checked independently before and after every selected-source operation. */
export async function assertWorkspaceDocumentSelections(input: {
	userId: string;
	organizationId?: string;
	workspaceIds: readonly string[];
	workspaceDocumentFilters: unknown;
}) {
	if (!input.organizationId) {
		throw new WorkspaceSelectionAccessError();
	}
	const selected = [...new Set(input.workspaceIds)];
	let filters: ReturnType<typeof readWorkspaceDocumentFilters>;
	try {
		filters = readWorkspaceDocumentFilters(
			input.workspaceDocumentFilters,
			selected,
		);
	} catch {
		throw new WorkspaceSelectionAccessError();
	}
	for (const workspaceId of selected) {
		try {
			await authorizeWorkspaceDocumentRead({
				workspaceId,
				userId: input.userId,
				organizationId: input.organizationId,
			});
		} catch {
			throw new WorkspaceSelectionAccessError();
		}
		const documentIds = filters.find(
			(x) => x.workspaceId === workspaceId,
		)?.documentIds;
		if (
			documentIds?.length &&
			(await db.workspaceDocument.count({
				where: { workspaceId, id: { in: documentIds } },
			})) !== documentIds.length
		) {
			throw new WorkspaceSelectionAccessError();
		}
	}
}
