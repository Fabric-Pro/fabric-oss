/**
 * Fabric MCP Gateway - project knowledge hub tools
 * (specs/2026-10-21-ai-artifacts-hub §5.5–5.6).
 *
 * Engineers' AI tools keep what they learn in Fabric instead of loose files:
 *
 *   - `fabric_knowledge_types`   the project's artifact types (keys, templates);
 *   - `fabric_knowledge_add`     append an entry to a topic (work item or slug);
 *   - `fabric_knowledge_search`  semantic search over the project's entries;
 *   - `fabric_knowledge_topic`   a topic's living summary and its timeline;
 *   - `fabric_knowledge_topics`  recently active topics.
 *
 * ## Scope
 *
 * Reads are `kind: "read"` under `projects:read`, so any read-capable
 * credential (including `mcp:read`) may use them. `fabric_knowledge_add` is a
 * write under `memory:write`, the scope the Coding Instructions plugin
 * already asks for; entries are append-only and never replace anything.
 *
 * ## Gating
 *
 * The session must reach the project (applied by `bindToolCall`), then the
 * caller's LIVE permission: `CONTEXT_READ` to read, `CONTEXT_CREATE` to add.
 */

import type { Prisma } from "@repo/database";
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

type KnowledgeToolPermission = "CONTEXT_READ" | "CONTEXT_CREATE";

type ProjectAccess =
	| { status: "allowed"; organizationId: string | null }
	| { status: "not-found" }
	| { status: "forbidden" };

/** The gateway's project gate, as `platform-tools.ts` implements it. */
export interface KnowledgeToolAccess {
	resolveGatewayProjectWriteAccessWithHost(
		projectId: string,
		session: GatewaySession,
		permission: KnowledgeToolPermission,
	): Promise<ProjectAccess>;
}

const MAX_BODY_CHARS = 200_000;

const KNOWLEDGE_TOOL_DEFINITIONS = defineFabricTools([
	{
		name: "fabric_knowledge_types",
		description:
			"The project's knowledge types: key, when to use it, template and required fields.",
		inputSchema: {
			type: "object",
			properties: { projectId: { type: "string" } },
			required: ["projectId"],
		},
		annotations: TOOL_ANNOTATIONS.read,
		scope: "projects:read",
	},
	{
		name: "fabric_knowledge_add",
		description:
			"Saves a note, spec, decision or other knowledge to the project for the whole team; append-only. topic: a work item (id, US-012, 12345) or a short name.",
		inputSchema: {
			type: "object",
			properties: {
				projectId: { type: "string" },
				topic: {
					type: "string",
					minLength: 1,
					maxLength: 200,
					description: "Work item or topic name",
				},
				topicTitle: {
					type: "string",
					maxLength: 200,
					description: "For a new topic",
				},
				type: {
					type: "string",
					description: "Type key, e.g. note",
				},
				title: { type: "string", minLength: 1, maxLength: 300 },
				body: {
					type: "string",
					minLength: 1,
					description: "Markdown",
				},
				fields: {
					type: "object",
					description: "The type's fields",
				},
				role: {
					type: "string",
					maxLength: 40,
					description: "e.g. FE, BE, QA",
				},
				supersedes: {
					type: "string",
					description: "Entry id this corrects",
				},
				sourcePath: {
					type: "string",
					maxLength: 512,
					description:
						"A file's path: saving it again records a new version",
				},
			},
			required: ["projectId", "topic", "type", "title", "body"],
		},
		annotations: TOOL_ANNOTATIONS.write,
		scope: "memory:write",
	},
	{
		name: "fabric_knowledge_search",
		description: "Semantic search over the project's knowledge entries.",
		inputSchema: {
			type: "object",
			properties: {
				projectId: { type: "string" },
				query: { type: "string", minLength: 1 },
				topic: { type: "string" },
				types: { type: "array", items: { type: "string" } },
				authorUserId: { type: "string" },
				since: {
					type: "string",
					description: "ISO date",
				},
				limit: { type: "number", description: "1-50, default 10" },
			},
			required: ["projectId", "query"],
		},
		annotations: TOOL_ANNOTATIONS.read,
		scope: "projects:read",
	},
	{
		name: "fabric_knowledge_topic",
		description: "One topic: its summary and entries in time order.",
		inputSchema: {
			type: "object",
			properties: {
				projectId: { type: "string" },
				topic: {
					type: "string",
					description: "Topic, work item or name",
				},
				limit: { type: "number", description: "1-200, default 50" },
				cursor: { type: "string" },
				newestFirst: { type: "boolean" },
			},
			required: ["projectId", "topic"],
		},
		annotations: TOOL_ANNOTATIONS.read,
		scope: "projects:read",
	},
	{
		name: "fabric_knowledge_topics",
		description: "The project's knowledge topics, most recent first.",
		inputSchema: {
			type: "object",
			properties: {
				projectId: { type: "string" },
				query: { type: "string" },
				authorUserId: { type: "string" },
				mine: {
					type: "boolean",
					description: "Only yours",
				},
				limit: { type: "number", description: "1-100, default 25" },
				cursor: { type: "string" },
			},
			required: ["projectId"],
		},
		annotations: TOOL_ANNOTATIONS.read,
		scope: "projects:read",
	},
]);

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

async function resolveGatewayProjectWriteAccessFor(
	access: KnowledgeToolAccess,
	args: Record<string, unknown>,
	session: GatewaySession,
	permission: KnowledgeToolPermission,
): Promise<{ projectId: string } | ToolCallResult> {
	const projectId = str(args.projectId);
	if (!projectId) {
		return errorResult("projectId is required");
	}
	const result = await access.resolveGatewayProjectWriteAccessWithHost(
		projectId,
		session,
		permission,
	);
	if (result.status === "not-found") {
		return errorResult("Project not found or access denied");
	}
	if (result.status === "forbidden") {
		return errorResult(
			permission === "CONTEXT_CREATE"
				? "No permission to add knowledge to this project"
				: "No permission to read this project's knowledge",
		);
	}
	return { projectId };
}

function isResult(value: unknown): value is ToolCallResult {
	return typeof value === "object" && value !== null && "content" in value;
}

async function handleKnowledgeTypes(
	access: KnowledgeToolAccess,
	args: Record<string, unknown>,
	session: GatewaySession,
): Promise<ToolCallResult> {
	const gated = await resolveGatewayProjectWriteAccessFor(
		access,
		args,
		session,
		"CONTEXT_READ",
	);
	if (isResult(gated)) {
		return gated;
	}
	const { listProjectKnowledgeTypes } = await import(
		"@repo/api/modules/projects/lib/knowledge"
	);
	const types = await listProjectKnowledgeTypes(gated.projectId);
	return jsonResult({
		types: types.map((t) => ({
			key: t.key,
			name: t.name,
			description: t.description,
			template: t.template,
			fieldSchema: t.fieldSchema,
			summaryBehavior: t.summaryBehavior,
			builtIn: t.builtIn,
		})),
	});
}

async function handleKnowledgeAdd(
	access: KnowledgeToolAccess,
	args: Record<string, unknown>,
	session: GatewaySession,
): Promise<ToolCallResult> {
	const gated = await resolveGatewayProjectWriteAccessFor(
		access,
		args,
		session,
		"CONTEXT_CREATE",
	);
	if (isResult(gated)) {
		return gated;
	}
	const topic = str(args.topic);
	const type = str(args.type);
	const title = str(args.title);
	const body = typeof args.body === "string" ? args.body : undefined;
	if (!topic || !type || !title || !body?.trim()) {
		return errorResult("topic, type, title and body are required");
	}
	if (body.length > MAX_BODY_CHARS) {
		return errorResult(
			`body is longer than ${MAX_BODY_CHARS} characters; split it into several entries`,
		);
	}
	if (
		args.fields !== undefined &&
		(typeof args.fields !== "object" ||
			args.fields === null ||
			Array.isArray(args.fields))
	) {
		return errorResult("fields must be an object");
	}

	const { addProjectKnowledge } = await import(
		"@repo/api/modules/projects/lib/knowledge"
	);
	const { KnowledgeInputError, db } = await import("@repo/database");
	let agentClient: string | null = null;
	if (session.oauthClientId) {
		const client = await db.oauthClient.findUnique({
			where: { id: session.oauthClientId },
			select: { name: true },
		});
		agentClient = client?.name ?? null;
	}
	try {
		const result = await addProjectKnowledge({
			projectId: gated.projectId,
			authorUserId: session.userId,
			topic,
			topicTitle: str(args.topicTitle),
			typeKey: type,
			title,
			body,
			fields: (args.fields as Prisma.InputJsonObject | undefined) ?? null,
			role: str(args.role) ?? null,
			agentClient,
			supersedesId: str(args.supersedes) ?? null,
			sourcePath: str(args.sourcePath) ?? null,
		});
		return jsonResult({
			status: result.duplicate ? "unchanged" : "added",
			entryId: result.entry.id,
			topic: {
				id: result.topic.id,
				key: result.topic.key,
				title: result.topic.title,
			},
			type: result.type.key,
			sourcePath: result.entry.sourcePath,
			supersedes: result.entry.supersedesId,
			createdAt: result.entry.createdAt.toISOString(),
			note: result.duplicate
				? "An identical entry by you already exists on this topic; nothing was added."
				: "Saved. The topic's summary refreshes within a minute.",
		});
	} catch (error) {
		if (error instanceof KnowledgeInputError) {
			return errorResult(error.message);
		}
		console.error("[MCP Gateway] fabric_knowledge_add failed:", {
			error: error instanceof Error ? error.message : error,
		});
		return errorResult("Could not save the knowledge entry. Try again.");
	}
}

async function handleKnowledgeSearch(
	access: KnowledgeToolAccess,
	args: Record<string, unknown>,
	session: GatewaySession,
): Promise<ToolCallResult> {
	const gated = await resolveGatewayProjectWriteAccessFor(
		access,
		args,
		session,
		"CONTEXT_READ",
	);
	if (isResult(gated)) {
		return gated;
	}
	const query = str(args.query);
	if (!query) {
		return errorResult("query is required");
	}
	const sinceText = str(args.since);
	const since = sinceText ? new Date(sinceText) : undefined;
	if (since && Number.isNaN(since.getTime())) {
		return errorResult("since must be an ISO date or date/time");
	}
	const { searchProjectKnowledgeEntries, knowledgeAuthorNames } =
		await import("@repo/api/modules/projects/lib/knowledge");
	const result = await searchProjectKnowledgeEntries({
		projectId: gated.projectId,
		userId: session.userId,
		query,
		topic: str(args.topic),
		types: Array.isArray(args.types)
			? args.types.filter((t): t is string => typeof t === "string")
			: undefined,
		authorUserId: str(args.authorUserId),
		since,
		limit: num(args.limit),
	});
	const names = await knowledgeAuthorNames(
		result.hits.map((h) => h.authorUserId),
	);
	return jsonResult({
		mode: result.mode,
		hits: result.hits.map((hit) => ({
			...hit,
			author: names[hit.authorUserId] ?? null,
		})),
	});
}

async function handleKnowledgeTopic(
	access: KnowledgeToolAccess,
	args: Record<string, unknown>,
	session: GatewaySession,
): Promise<ToolCallResult> {
	const gated = await resolveGatewayProjectWriteAccessFor(
		access,
		args,
		session,
		"CONTEXT_READ",
	);
	if (isResult(gated)) {
		return gated;
	}
	const topic = str(args.topic);
	if (!topic) {
		return errorResult("topic is required");
	}
	const { getProjectKnowledgeTopic, knowledgeAuthorNames } = await import(
		"@repo/api/modules/projects/lib/knowledge"
	);
	const view = await getProjectKnowledgeTopic({
		projectId: gated.projectId,
		topic,
		limit: num(args.limit),
		cursor: str(args.cursor),
		newestFirst: args.newestFirst === true,
	});
	if (!view) {
		return errorResult(
			"No knowledge topic matches. List topics with fabric_knowledge_topics; a topic is created by its first fabric_knowledge_add.",
		);
	}
	const names = await knowledgeAuthorNames(
		view.entries.map((e) => e.authorUserId),
	);
	return jsonResult({
		topic: {
			id: view.topic.id,
			key: view.topic.key,
			title: view.topic.title,
			kind: view.topic.kind,
			userStoryId: view.topic.userStoryId,
			externalRef: view.topic.externalRef,
			entryCount: view.topic.entryCount,
			lastEntryAt: view.topic.lastEntryAt?.toISOString() ?? null,
		},
		summary: view.summary
			? {
					content: view.summary.content,
					coveredThrough:
						view.summary.coveredThrough?.toISOString() ?? null,
					entryCount: view.summary.entryCount,
					createdAt: view.summary.createdAt.toISOString(),
				}
			: null,
		summaryStale: view.summaryStale,
		summaryInProgress: view.summaryInProgress,
		entries: view.entries.map((entry) => ({
			id: entry.id,
			type: entry.type.key,
			title: entry.title,
			body: entry.body,
			fields: entry.fields,
			author: names[entry.authorUserId] ?? null,
			authorUserId: entry.authorUserId,
			role: entry.role,
			agentClient: entry.agentClient,
			createdAt: entry.createdAt.toISOString(),
			supersedes: entry.supersedesId,
			supersededBy: entry.supersededBy?.id ?? null,
		})),
		nextCursor: view.nextCursor,
	});
}

async function handleKnowledgeTopics(
	access: KnowledgeToolAccess,
	args: Record<string, unknown>,
	session: GatewaySession,
): Promise<ToolCallResult> {
	const gated = await resolveGatewayProjectWriteAccessFor(
		access,
		args,
		session,
		"CONTEXT_READ",
	);
	if (isResult(gated)) {
		return gated;
	}
	const { listProjectKnowledgeTopics } = await import(
		"@repo/api/modules/projects/lib/knowledge"
	);
	const result = await listProjectKnowledgeTopics({
		projectId: gated.projectId,
		query: str(args.query),
		authorUserId:
			args.mine === true ? session.userId : str(args.authorUserId),
		limit: num(args.limit),
		cursor: str(args.cursor),
	});
	return jsonResult({
		topics: result.topics.map((t) => ({
			id: t.id,
			key: t.key,
			title: t.title,
			kind: t.kind,
			entryCount: t.entryCount,
			lastEntryAt: t.lastEntryAt?.toISOString() ?? null,
		})),
		nextCursor: result.nextCursor,
	});
}

/** The knowledge hub tools, registered like every other family. */
export function createKnowledgeTools(access: KnowledgeToolAccess): ToolFamily {
	return toolFamily(
		KNOWLEDGE_TOOL_DEFINITIONS,
		new Map<string, PlatformToolHandler>([
			[
				"fabric_knowledge_types",
				(a, s) => handleKnowledgeTypes(access, a, s),
			],
			[
				"fabric_knowledge_add",
				(a, s) => handleKnowledgeAdd(access, a, s),
			],
			[
				"fabric_knowledge_search",
				(a, s) => handleKnowledgeSearch(access, a, s),
			],
			[
				"fabric_knowledge_topic",
				(a, s) => handleKnowledgeTopic(access, a, s),
			],
			[
				"fabric_knowledge_topics",
				(a, s) => handleKnowledgeTopics(access, a, s),
			],
		]),
	);
}
