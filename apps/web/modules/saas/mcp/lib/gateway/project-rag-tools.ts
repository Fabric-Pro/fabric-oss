/**
 * `fabric_semantic_search`: the project's RAG for a coding tool, the same
 * retrieval the Fabric chat answers from. One query searches the project's
 * Context (documents, transcripts, notes, synced files), ranked by similarity
 * under the project's RAG settings. The code index is not searched here: the
 * retrieval leaves its points out, so the agent searches the code itself
 * under `repos/<name>/`.
 *
 * `fabric_search_project_knowledge` stays the literal keyword search and
 * `fabric_knowledge_search` the knowledge hub's own entries; this one is the
 * vector search over the rest.
 *
 * Gate: `projects:read` (a read), the session must reach the project, and the
 * caller's live `CONTEXT_READ` on it. The tenant is the project's own.
 */

import {
	defineFabricTools,
	TOOL_ANNOTATIONS,
} from "@repo/temporal/fabric-tool-definition";
import { errorResult, jsonResult } from "./tool-results";
import {
	type PlatformToolHandler,
	type ToolFamily,
	toolFamily,
} from "./tools/tool-family";
import type { GatewaySession, ToolCallResult } from "./types";

type ProjectAccess =
	| { status: "allowed"; organizationId: string | null }
	| { status: "not-found" }
	| { status: "forbidden" };

/** The gateway's project gate, as `platform-tools.ts` implements it. */
export interface ProjectRagToolAccess {
	resolveGatewayProjectWriteAccessWithHost(
		projectId: string,
		session: GatewaySession,
		permission: "CONTEXT_READ",
	): Promise<ProjectAccess>;
}

/** The passages' budget: about 3k tokens, the same as the chat's compact read. */
const MAX_CHARS = 12_000;
const MAX_TOP_K = 20;

const PROJECT_RAG_TOOL_DEFINITIONS = defineFabricTools([
	{
		name: "fabric_semantic_search",
		description:
			"Semantic (RAG) search over the project's context, not its code.",
		inputSchema: {
			type: "object",
			properties: {
				projectId: { type: "string" },
				query: { type: "string", minLength: 1, maxLength: 1000 },
				limit: { type: "integer", minimum: 1, maximum: MAX_TOP_K },
			},
			required: ["projectId", "query"],
		},
		annotations: TOOL_ANNOTATIONS.read,
		scope: "projects:read",
	},
]);

function clampInt(
	value: unknown,
	min: number,
	max: number,
): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? Math.max(min, Math.min(max, Math.floor(value)))
		: undefined;
}

async function handleSemanticSearch(
	access: ProjectRagToolAccess,
	args: Record<string, unknown>,
	session: GatewaySession,
): Promise<ToolCallResult> {
	const projectId = args.projectId;
	if (typeof projectId !== "string" || projectId === "") {
		return errorResult("projectId is required");
	}
	const query = typeof args.query === "string" ? args.query.trim() : "";
	if (query === "") {
		return errorResult("query is required");
	}
	const gate = await access.resolveGatewayProjectWriteAccessWithHost(
		projectId,
		session,
		"CONTEXT_READ",
	);
	if (gate.status === "not-found") {
		return errorResult("Project not found or access denied");
	}
	if (gate.status === "forbidden") {
		return errorResult("No permission to read this project");
	}
	const {
		compactProjectContextPassages,
		contextMetaHeader,
		retrieveProjectContexts,
	} = await import("@repo/rag");
	const contexts = await retrieveProjectContexts({
		projectId,
		query: query.slice(0, 1000),
		userId: session.userId,
		organizationId: gate.organizationId ?? undefined,
		includeMatchedPassages: true,
		topK: clampInt(args.limit, 1, MAX_TOP_K),
		usageOrigin: { projectId, featureKey: "knowledge-search" },
	});
	if (contexts.length === 0) {
		return jsonResult({
			count: 0,
			results: "",
			message:
				"Nothing in the project's context matches. Try other words, fabric_search_project_knowledge for exact terms, or the code itself.",
		});
	}
	const { context } = compactProjectContextPassages(
		contexts,
		"Project knowledge\nSimilarity-ranked matched passages from the project's context; a sample, not a complete listing.",
		(ctx) =>
			`[${ctx.type}, relevance: ${(ctx.score * 100).toFixed(1)}%]\n${contextMetaHeader(ctx)}`,
		{
			maxChars: MAX_CHARS,
			fullSourceNote: (id) =>
				`Read it in full with fabric_get_project_context({"contextId":${JSON.stringify(id)}}).`,
		},
	);
	return jsonResult({
		count: contexts.length,
		results: context,
		message:
			"For a CODE_FILE result, open the file in the workspace's repos/<name>/ clone (fabric_list_code_repositories names them) when you need more than the passage.",
	});
}

export function createProjectRagTools(
	access: ProjectRagToolAccess,
): ToolFamily {
	return toolFamily(
		PROJECT_RAG_TOOL_DEFINITIONS,
		new Map<string, PlatformToolHandler>([
			[
				"fabric_semantic_search",
				(a, s) => handleSemanticSearch(access, a, s),
			],
		]),
	);
}
