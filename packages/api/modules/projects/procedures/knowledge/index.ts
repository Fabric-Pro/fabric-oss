/**
 * Project knowledge hub procedures (specs/2026-10-21-ai-artifacts-hub) for
 * the web UI. The MCP gateway tools (`knowledge-tools.ts`) are the AI-tool
 * twin; both call `../../lib/knowledge`.
 *
 * Authorization: visibility first (`projectNotFoundUnlessVisible`, so an
 * outsider cannot tell real project ids apart), then the live permission:
 * CONTEXT_READ to read, CONTEXT_CREATE to add entries, PROJECT_UPDATE to
 * manage the type catalog.
 */
import { ORPCError } from "@orpc/client";
import {
	archiveKnowledgeType,
	getKnowledgeProjectTenancy,
	KnowledgeInputError,
	upsertKnowledgeType,
} from "@repo/database";
import { Permissions } from "@repo/permissions";
import { z } from "zod";
import { projectNotFoundUnlessVisible } from "../../../../orpc/middleware/project-visibility";
import {
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	addProjectKnowledge,
	embedPendingKnowledgeEntries,
	getProjectKnowledgeTopic,
	knowledgeAuthorNames,
	listProjectKnowledgeTopics,
	listProjectKnowledgeTypes,
	searchProjectKnowledgeEntries,
	startTopicSummary,
} from "../../lib/knowledge";

const projectId = z.string().min(1).max(128);

function asOrpcError(error: unknown): never {
	if (error instanceof KnowledgeInputError) {
		throw new ORPCError("BAD_REQUEST", { message: error.message });
	}
	throw error;
}

const typeKey = z
	.string()
	.trim()
	.regex(/^[a-z0-9][a-z0-9._-]{0,79}$/, {
		message: "Use lowercase letters, digits, dots, dashes or underscores",
	});

export const listKnowledgeTypesProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.CONTEXT_READ))
	.route({ method: "GET", path: "/projects/:projectId/knowledge/types" })
	.input(z.object({ projectId, includeArchived: z.boolean().optional() }))
	.handler(async ({ input }) => {
		const types = await listProjectKnowledgeTypes(input.projectId, {
			includeArchived: input.includeArchived,
		});
		return { types };
	});

export const upsertKnowledgeTypeProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({ method: "PUT", path: "/projects/:projectId/knowledge/types" })
	.input(
		z.object({
			projectId,
			key: typeKey,
			name: z.string().trim().min(1).max(80),
			description: z.string().trim().min(1).max(2000),
			template: z.string().max(20_000).nullable().optional(),
			fieldSchema: z
				.record(z.string(), z.unknown())
				.nullable()
				.optional(),
			summaryBehavior: z
				.enum(["MERGE", "LATEST_WINS", "EXCLUDED"])
				.optional(),
			visibility: z.enum(["MEMBERS", "MEMBERS_AND_GUESTS"]).optional(),
			retentionDays: z
				.number()
				.int()
				.min(1)
				.max(3650)
				.nullable()
				.optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const tenancy = await getKnowledgeProjectTenancy(input.projectId);
		if (!tenancy) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}
		const { projectId: id, fieldSchema, ...rest } = input;
		const type = await upsertKnowledgeType(
			id,
			tenancy,
			{
				...rest,
				fieldSchema: (fieldSchema ?? null) as never,
			},
			context.user.id,
		);
		return { type };
	});

export const archiveKnowledgeTypeProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "DELETE",
		path: "/projects/:projectId/knowledge/types/:key",
	})
	.input(z.object({ projectId, key: typeKey }))
	.handler(async ({ input, context }) => {
		const archived = await archiveKnowledgeType(
			input.projectId,
			input.key,
			context.user.id,
		);
		return { archived };
	});

export const listKnowledgeTopicsProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.CONTEXT_READ))
	.route({ method: "GET", path: "/projects/:projectId/knowledge/topics" })
	.input(
		z.object({
			projectId,
			query: z.string().max(200).optional(),
			mine: z.boolean().optional(),
			limit: z.number().int().min(1).max(100).optional(),
			cursor: z.string().max(128).optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		return listProjectKnowledgeTopics({
			projectId: input.projectId,
			query: input.query,
			authorUserId: input.mine ? context.user.id : undefined,
			limit: input.limit,
			cursor: input.cursor,
		});
	});

export const getKnowledgeTopicProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.CONTEXT_READ))
	.route({ method: "GET", path: "/projects/:projectId/knowledge/topic" })
	.input(
		z.object({
			projectId,
			topic: z.string().min(1).max(200),
			limit: z.number().int().min(1).max(200).optional(),
			cursor: z.string().max(128).optional(),
			newestFirst: z.boolean().optional(),
		}),
	)
	.handler(async ({ input }) => {
		const view = await getProjectKnowledgeTopic(input);
		if (!view) {
			throw new ORPCError("NOT_FOUND", { message: "Topic not found" });
		}
		const authors = await knowledgeAuthorNames(
			view.entries.map((entry) => entry.authorUserId),
		);
		return { ...view, authors };
	});

export const addKnowledgeEntryProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.CONTEXT_CREATE))
	.route({ method: "POST", path: "/projects/:projectId/knowledge/entries" })
	.input(
		z.object({
			projectId,
			topic: z.string().trim().min(1).max(200),
			topicTitle: z.string().trim().max(200).optional(),
			type: typeKey,
			title: z.string().trim().min(1).max(300),
			body: z.string().trim().min(1).max(200_000),
			fields: z.record(z.string(), z.unknown()).optional(),
			role: z.string().trim().max(40).optional(),
			supersedes: z.string().max(128).optional(),
			sourcePath: z.string().max(512).optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		try {
			const result = await addProjectKnowledge({
				projectId: input.projectId,
				authorUserId: context.user.id,
				topic: input.topic,
				topicTitle: input.topicTitle,
				typeKey: input.type,
				title: input.title,
				body: input.body,
				fields: (input.fields ?? null) as never,
				role: input.role ?? null,
				agentClient: null,
				supersedesId: input.supersedes ?? null,
				sourcePath: input.sourcePath ?? null,
			});
			return {
				entryId: result.entry.id,
				topicId: result.topic.id,
				duplicate: result.duplicate,
			};
		} catch (error) {
			asOrpcError(error);
		}
	});

export const searchKnowledgeProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.CONTEXT_READ))
	.route({ method: "POST", path: "/projects/:projectId/knowledge/search" })
	.input(
		z.object({
			projectId,
			query: z.string().trim().min(1).max(1000),
			topic: z.string().max(200).optional(),
			types: z.array(typeKey).max(20).optional(),
			limit: z.number().int().min(1).max(50).optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const result = await searchProjectKnowledgeEntries({
			...input,
			userId: context.user.id,
		});
		const authors = await knowledgeAuthorNames(
			result.hits.map((hit) => hit.authorUserId),
		);
		return { ...result, authors };
	});

export const refreshKnowledgeTopicSummaryProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.CONTEXT_CREATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/knowledge/topic/refresh",
	})
	.input(z.object({ projectId, topicId: z.string().min(1).max(128) }))
	.handler(async ({ input }) => {
		await embedPendingKnowledgeEntries(input.projectId);
		startTopicSummary(input.projectId, input.topicId);
		return { started: true };
	});
