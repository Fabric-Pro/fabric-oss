/**
 * The folder fallback for source guidance (Fizzy #2808).
 *
 * A file imported from a document folder takes the folder's description as
 * its source guidance while the folder stays connected. The description lives
 * only on the folder row, so an edit reaches the next retrieval without a
 * re-import, and a disconnect ends it. This maps context ids to descriptions
 * in one indexed lookup on the file ledger's `contextId`; callers apply it
 * after their own guidance and the URL parent's, and neutralize the text.
 *
 * NOTE: project-scoped by its `projectId` filter rather than the tenant
 * extension, like the rest of the document-folder queries; callers have
 * already authorized the project the contexts were retrieved from.
 */

import { neutralizeAiChatAttachmentBody } from "@repo/utils/ai-chat-attachment";
import { db } from "../../client";
import { DOCUMENT_FOLDER_CONTEXT_PROVIDERS } from "./document-folders";

export async function resolveDocumentFolderGuidance(params: {
	projectId: string;
	contextIds: readonly string[];
}): Promise<Map<string, string>> {
	const guidance = new Map<string, string>();
	if (params.contextIds.length === 0) {
		return guidance;
	}
	const files = await db.projectDocumentFolderFile.findMany({
		where: {
			projectId: params.projectId,
			contextId: { in: [...params.contextIds] },
			folder: {
				projectId: params.projectId,
				disconnectedAt: null,
				description: { not: null },
			},
		},
		select: { contextId: true, folder: { select: { description: true } } },
	});
	for (const file of files) {
		const description = file.folder.description?.trim();
		if (file.contextId && description) {
			guidance.set(file.contextId, description);
		}
	}
	return guidance;
}

/**
 * A hydrated context as a model-facing reader holds it. `aiInstructions` is
 * already the row's own guidance or, for a crawled URL page, its parent's.
 */
export interface SourceGuidanceRow {
	id: string;
	metadata: unknown;
	aiInstructions?: string | null;
}

/**
 * The tag that opens and closes retrieved project context in a prompt. The
 * attachment neutralizer does not know it, and guidance is rendered inside
 * that block, so a tag in a description is mangled the same way: an
 * underscore is appended, which never converges back on the real tag.
 */
const PROJECT_CONTEXT_TAG_PATTERN = /<\s*\/?\s*project_context_*\s*>/gi;

function neutralizeInheritedGuidance(description: string): string {
	return neutralizeAiChatAttachmentBody(description).replace(
		PROJECT_CONTEXT_TAG_PATTERN,
		(tag) => tag.replace(/(project_context_*)/i, "$1_"),
	);
}

function isDocumentFolderFile(row: SourceGuidanceRow): boolean {
	const metadata = row.metadata;
	if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
		return false;
	}
	const provider = (metadata as Record<string, unknown>).provider;
	return (
		typeof provider === "string" &&
		DOCUMENT_FOLDER_CONTEXT_PROVIDERS.includes(provider)
	);
}

/**
 * The folder description each document-folder file in `rows` inherits, keyed
 * by context id and neutralized for the prompt. Only files with no guidance
 * of their own take one, and a batch without such files makes no query.
 * Readers that must keep the row's own value (MCP returns it as the
 * `expected` of an update) report this map separately.
 */
export async function resolveInheritedSourceGuidance(params: {
	projectId: string;
	rows: readonly SourceGuidanceRow[];
}): Promise<Map<string, string>> {
	const contextIds = params.rows
		.filter(
			(row) => !row.aiInstructions?.trim() && isDocumentFolderFile(row),
		)
		.map((row) => row.id);
	const inherited = new Map<string, string>();
	if (contextIds.length === 0) {
		return inherited;
	}
	const descriptions = await resolveDocumentFolderGuidance({
		projectId: params.projectId,
		contextIds: [...new Set(contextIds)],
	});
	for (const [contextId, description] of descriptions) {
		inherited.set(contextId, neutralizeInheritedGuidance(description));
	}
	return inherited;
}

/**
 * `rows` with each document-folder file's effective guidance filled in: its
 * own, else its connected folder's description. Every other row is returned
 * as it came. Call once per hydrated batch.
 */
export async function withInheritedSourceGuidance<
	T extends SourceGuidanceRow,
>(params: { projectId: string; rows: readonly T[] }): Promise<T[]> {
	const inherited = await resolveInheritedSourceGuidance(params);
	return params.rows.map((row) => {
		const guidance = inherited.get(row.id);
		return guidance === undefined
			? row
			: { ...row, aiInstructions: guidance };
	});
}
