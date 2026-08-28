import { ORPCError } from "@orpc/server";
import { getRAGProviderConfig } from "@repo/ai";
import {
	createContext,
	db,
	deleteContext,
	getContextById,
	getDataConnectionById,
	getWorkspaceDocumentWithChunks,
	hasProjectAccess,
	recordContextIndexingFailure,
	updateContextExtractionStatus,
} from "@repo/database";
import { deleteProjectContext, embedProjectContext } from "@repo/rag";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

function getMetadataString(metadata: unknown, keys: string[]): string | null {
	if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
		return null;
	}

	const record = metadata as Record<string, unknown>;

	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim().length > 0) {
			return value;
		}
	}

	return null;
}

function buildWorkspaceDocumentContent(
	document: Awaited<ReturnType<typeof getWorkspaceDocumentWithChunks>>,
) {
	if (!document) {
		return null;
	}

	const extractedText = document.extractedText?.trim();
	if (extractedText) {
		return extractedText;
	}

	const chunkContent = document.chunks
		.map((chunk) => chunk.content.trim())
		.filter(Boolean)
		.join("\n\n")
		.trim();

	return chunkContent || null;
}

/**
 * Embed a bound Notion context inline, then record what happened on the row
 * (Fizzy #2228, R13).
 *
 * Both procedures below embed synchronously rather than starting
 * `contextEmbeddingWorkflow`, and `embedProjectContext` writes only `qdrantId`
 * and `embeddedAt` — the `extractionStatus` write lives in
 * `embedSingleContextActivity`, which this path never reaches. So a bound page
 * carrying several kilobytes of text stayed on the schema default `PENDING` for
 * the life of the row. Nothing downstream advances it, and no repair path
 * reaches it either: the bulk `contexts.embed` endpoint skips
 * `type: "INTEGRATION"` outright. Readiness evidence counts only `COMPLETED`
 * sources, so a real, indexed PRD counted for nothing.
 *
 * The contract mirrors `embedSingleContextActivity` on purpose, so the two ways
 * a context can be embedded leave the same row state behind:
 * - a vector was stored → `COMPLETED`, clearing whatever message an earlier
 *   attempt left behind (a stale one keeps describing a fixed failure)
 * - the embed reported failure → the indexing-failure record, which names the
 *   step that failed and leaves an already-`COMPLETED` row's status alone
 * - the call succeeded but stored no vector → status untouched. "Ready" has to
 *   mean a vector exists, not that we tried; flipping here is exactly the
 *   lying-pill bug that the metadata-only INTEGRATION wiring was fixed for.
 */
async function embedAndRecordOutcome(
	options: Parameters<typeof embedProjectContext>[0],
): Promise<void> {
	let result: Awaited<ReturnType<typeof embedProjectContext>>;

	try {
		result = await embedProjectContext(options);
	} catch (error) {
		// `embedProjectContext` normally resolves with `{ success: false }`, but
		// a provider/config throw still has to leave a truthful row rather than
		// a silent PENDING one. The error is re-thrown so the caller's response
		// is unchanged.
		await recordContextIndexingFailure(
			options.contextId,
			`Search indexing failed: ${
				error instanceof Error ? error.message : "Unknown error"
			}`,
		);
		throw error;
	}

	if (!result.success) {
		await recordContextIndexingFailure(
			options.contextId,
			`Search indexing failed: ${
				result.error ?? "Embedding generation failed"
			}`,
		);
		return;
	}

	if (!result.qdrantId) {
		return;
	}

	await updateContextExtractionStatus(options.contextId, "COMPLETED", {
		extractionError: null,
	});
}

/**
 * AUTHORIZATION: `requireProjectPermission(PROJECT_UPDATE)` — binding a PRD
 * source is a project-edit operation.
 *
 * Binds a synced Notion resource from the generic data-connection system to the
 * project PRD context and embeds it for project retrieval.
 */
export const syncPrdSourceProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/prd-source/sync",
		tags: ["Projects", "Notion", "PRD"],
		summary: "Bind synced Notion PRD content",
		description:
			"Uses a synced Notion resource from the generic connector system as the project PRD context.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			connectionId: z.string(),
			resourceId: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const tenantFilter = organizationId
			? { organizationId, userId: user.id }
			: { organizationId: null, userId: user.id };

		const [project, connection] = await Promise.all([
			db.project.findFirst({
				where: {
					id: input.projectId,
					...tenantFilter,
				},
				select: {
					id: true,
					organizationId: true,
					prdSourceContextId: true,
				},
			}),
			getDataConnectionById({
				id: input.connectionId,
				userId: user.id,
				organizationId,
			}),
		]);

		if (!project) {
			throw new ORPCError("NOT_FOUND", {
				message: "Project not found",
			});
		}

		if (!connection || connection.provider !== "NOTION") {
			throw new ORPCError("NOT_FOUND", {
				message: "Notion connection not found",
			});
		}

		const resource = await db.syncedResource.findFirst({
			where: {
				id: input.resourceId,
				connectionId: connection.id,
				syncStatus: "SYNCED",
			},
			select: {
				id: true,
				title: true,
				externalId: true,
				externalPath: true,
				metadata: true,
				documentId: true,
			},
		});

		if (!resource) {
			throw new ORPCError("NOT_FOUND", {
				message: "Synced Notion resource not found",
			});
		}

		if (!resource.documentId) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"This Notion resource has not been indexed yet. Run sync first, then try again.",
			});
		}

		const document = await getWorkspaceDocumentWithChunks(
			resource.documentId,
		);
		const content = buildWorkspaceDocumentContent(document);

		if (!document || !content) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"The selected Notion page does not have indexed content yet. Run sync again and retry.",
			});
		}

		const sourceTitle = resource.title || document.filename || "Notion PRD";
		const sourceUrl =
			getMetadataString(resource.metadata, [
				"url",
				"sourceUrl",
				"webUrl",
			]) ||
			resource.externalPath ||
			null;
		const resourceMetadata = {
			provider: "notion",
			sourceType: "data_connection",
			dataConnectionId: connection.id,
			syncedResourceId: resource.id,
			workspaceDocumentId: document.id,
			notionPageId: resource.externalId,
			isPrdSource: true,
		};

		let contextId = project.prdSourceContextId ?? null;
		const existingContext = contextId
			? await getContextById(contextId)
			: null;

		if (existingContext?.qdrantId) {
			await deleteProjectContext(
				existingContext.id,
				organizationId,
				existingContext.qdrantId,
			);
		}

		if (existingContext) {
			await db.projectContext.update({
				where: { id: existingContext.id },
				data: {
					content,
					qdrantId: null,
					sourceTitle,
					sourceUrl,
					metadata: resourceMetadata,
				},
			});
		} else {
			const createdContext = await createContext({
				projectId: input.projectId,
				type: "INTEGRATION",
				content,
				metadata: resourceMetadata,
				sourceTitle,
				sourceUrl: sourceUrl ?? undefined,
				userId: user.id,
				organizationId: organizationId ?? undefined,
			});
			contextId = createdContext.id;
		}

		if (!contextId) {
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Failed to bind the selected Notion resource",
			});
		}

		const ragProviderConfig = await getRAGProviderConfig({
			userId: user.id,
			organizationId,
		});

		await embedAndRecordOutcome({
			contextId,
			projectId: input.projectId,
			userId: user.id,
			organizationId: organizationId ?? undefined,
			content,
			type: "INTEGRATION",
			apiKey: ragProviderConfig,
			metadata: {
				sourceTitle,
				sourceUrl: sourceUrl ?? undefined,
				syncedResourceId: resource.id,
				dataConnectionId: connection.id,
			},
		});

		await db.project.update({
			where: { id: input.projectId },
			data: {
				prdSourceContextId: contextId,
				prdSourceSyncedAt: new Date(),
				prdSourceTitle: sourceTitle,
				prdSourceUrl: sourceUrl,
			},
		});

		return {
			status: "completed",
			message: "Project PRD source updated",
			contextId,
			connectionId: connection.id,
			resourceId: resource.id,
		};
	});

/**
 * Get the current Notion PRD status.
 * AUTHORIZATION: Uses hasProjectAccess() - any user with project access can read status.
 */
export const getPrdSourceStatusProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/prd-source/status",
		tags: ["Projects", "Notion", "PRD"],
		summary: "Get Notion PRD status",
		description:
			"Get the current project PRD binding status for the generic Notion connector.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const hasAccess = await hasProjectAccess(
			input.projectId,
			user.id,
			organizationId ?? undefined,
		);
		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		const project = await db.project.findUnique({
			where: { id: input.projectId },
			select: {
				id: true,
				prdSourceContextId: true,
				prdSourceSyncedAt: true,
				prdSourceTitle: true,
				prdSourceUrl: true,
				prdSourceContext: {
					select: {
						metadata: true,
					},
				},
			},
		});

		if (!project) {
			throw new ORPCError("NOT_FOUND", {
				message: "Project not found",
			});
		}

		return {
			hasSource: !!project.prdSourceContextId,
			sourceTitle: project.prdSourceTitle,
			sourceUrl: project.prdSourceUrl,
			contextId: project.prdSourceContextId,
			syncedAt: project.prdSourceSyncedAt,
			syncStatus: project.prdSourceContextId ? "COMPLETED" : "PENDING",
			syncError: null,
			workflowId: null,
			connectionId: getMetadataString(
				project.prdSourceContext?.metadata,
				["dataConnectionId"],
			),
			resourceId: getMetadataString(project.prdSourceContext?.metadata, [
				"syncedResourceId",
			]),
			notionPageId: getMetadataString(
				project.prdSourceContext?.metadata,
				["notionPageId"],
			),
		};
	});

/**
 * Get the bound Notion PRD content.
 */
export const getPrdSourceContentProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/prd-source/content",
		tags: ["Projects", "Notion", "PRD"],
		summary: "Get Notion PRD content",
		description:
			"Get the bound project PRD content stored in ProjectContext.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const tenantFilter = organizationId
			? { organizationId, userId: user.id }
			: { organizationId: null, userId: user.id };

		const project = await db.project.findFirst({
			where: {
				id: input.projectId,
				...tenantFilter,
			},
			select: {
				id: true,
				prdSourceContextId: true,
				prdSourceTitle: true,
				prdSourceUrl: true,
			},
		});

		if (!project) {
			throw new ORPCError("NOT_FOUND", {
				message: "Project not found",
			});
		}

		if (!project.prdSourceContextId) {
			return {
				hasContent: false,
				content: null,
				title: project.prdSourceTitle,
				url: project.prdSourceUrl,
			};
		}

		const prdContext = await db.projectContext.findUnique({
			where: { id: project.prdSourceContextId },
			select: {
				id: true,
				content: true,
				sourceTitle: true,
				sourceUrl: true,
				updatedAt: true,
			},
		});

		if (!prdContext) {
			return {
				hasContent: false,
				content: null,
				title: project.prdSourceTitle,
				url: project.prdSourceUrl,
			};
		}

		return {
			hasContent: true,
			content: prdContext.content,
			title: prdContext.sourceTitle || project.prdSourceTitle,
			url: prdContext.sourceUrl || project.prdSourceUrl,
			updatedAt: prdContext.updatedAt,
		};
	});

type NotionRawBlock = Record<string, unknown> & {
	id?: string;
	type?: string;
	has_children?: boolean;
};

async function fetchNotionChildBlocks(
	blockId: string,
	accessToken: string,
): Promise<NotionRawBlock[]> {
	const headers = {
		Authorization: `Bearer ${accessToken}`,
		"Notion-Version": "2022-06-28",
		"Content-Type": "application/json",
	};

	const collected: NotionRawBlock[] = [];
	let cursor: string | undefined;

	do {
		const url = new URL(
			`https://api.notion.com/v1/blocks/${blockId}/children`,
		);
		url.searchParams.set("page_size", "100");
		if (cursor) {
			url.searchParams.set("start_cursor", cursor);
		}

		const response = await fetch(url.toString(), { headers });
		if (!response.ok) {
			const errorText = await response.text().catch(() => "unknown");
			throw new ORPCError("BAD_REQUEST", {
				message: `Notion API error ${response.status}: ${errorText}`,
			});
		}

		const data = (await response.json()) as {
			results: NotionRawBlock[];
			has_more: boolean;
			next_cursor: string | null;
		};

		for (const block of data.results) {
			// Recursively fetch children for nested blocks (toggles, columns, etc.)
			if (block.has_children && typeof block.id === "string") {
				block.children = await fetchNotionChildBlocks(
					block.id,
					accessToken,
				);
			}
			collected.push(block);
		}

		cursor = data.has_more ? (data.next_cursor ?? undefined) : undefined;
	} while (cursor);

	return collected;
}

function parseBlocksToText(blocks: NotionRawBlock[], level = 0): string {
	const parts: string[] = [];

	for (const block of blocks) {
		const blockType = typeof block.type === "string" ? block.type : "";
		const payload =
			blockType &&
			block[blockType] &&
			typeof block[blockType] === "object"
				? (block[blockType] as Record<string, unknown>)
				: {};
		const richText = Array.isArray(payload.rich_text)
			? (payload.rich_text as Array<{ plain_text?: string }>)
			: [];
		const text = richText
			.map((t) => t.plain_text ?? "")
			.join("")
			.trim();

		switch (blockType) {
			case "heading_1":
				if (text) {
					parts.push(`# ${text}`);
				}
				break;
			case "heading_2":
				if (text) {
					parts.push(`## ${text}`);
				}
				break;
			case "heading_3":
				if (text) {
					parts.push(`### ${text}`);
				}
				break;
			case "bulleted_list_item":
				if (text) {
					parts.push(`${"  ".repeat(level)}- ${text}`);
				}
				break;
			case "numbered_list_item":
				if (text) {
					parts.push(`${"  ".repeat(level)}1. ${text}`);
				}
				break;
			case "to_do":
				if (text) {
					parts.push(
						`${"  ".repeat(level)}- [${payload.checked ? "x" : " "}] ${text}`,
					);
				}
				break;
			case "code":
				if (text) {
					parts.push(`\`\`\`\n${text}\n\`\`\``);
				}
				break;
			case "quote":
			case "callout":
				if (text) {
					parts.push(`> ${text}`);
				}
				break;
			default:
				if (text) {
					parts.push(text);
				}
				break;
		}

		// Recurse into children (toggles, columns, synced blocks, etc.)
		const children = Array.isArray(block.children)
			? (block.children as NotionRawBlock[])
			: [];
		if (children.length > 0) {
			const childText = parseBlocksToText(children, level + 1);
			if (childText) {
				parts.push(childText);
			}
		}
	}

	return parts.filter(Boolean).join("\n\n");
}

async function fetchNotionBlocksAsText(
	pageId: string,
	accessToken: string,
): Promise<string> {
	const blocks = await fetchNotionChildBlocks(pageId, accessToken);
	return parseBlocksToText(blocks);
}

/**
 * AUTHORIZATION: `requireProjectPermission(PROJECT_UPDATE)` — binding a PRD
 * source is a project-edit operation.
 *
 * Binds a Notion page directly (without requiring a prior sync) as the project PRD
 * source. Fetches content from Notion API, creates a ProjectContext, and embeds it.
 */
export const bindNotionPageProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/prd-source/bind-notion-page",
		tags: ["Projects", "Notion", "PRD"],
		summary: "Bind Notion page directly as PRD",
		description:
			"Fetches a Notion page's content directly and sets it as the project PRD source without requiring a prior sync.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			connectionId: z.string(),
			notionPageId: z.string(),
			notionTitle: z.string(),
			notionUrl: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const tenantFilter = organizationId
			? { organizationId, userId: user.id }
			: { organizationId: null, userId: user.id };

		const [project, connection] = await Promise.all([
			db.project.findFirst({
				where: {
					id: input.projectId,
					...tenantFilter,
				},
				select: {
					id: true,
					organizationId: true,
					prdSourceContextId: true,
				},
			}),
			getDataConnectionById({
				id: input.connectionId,
				userId: user.id,
				organizationId,
			}),
		]);

		if (!project) {
			throw new ORPCError("NOT_FOUND", {
				message: "Project not found",
			});
		}

		if (!connection || connection.provider !== "NOTION") {
			throw new ORPCError("NOT_FOUND", {
				message: "Notion connection not found",
			});
		}

		if (!connection.accessToken) {
			throw new ORPCError("BAD_REQUEST", {
				message: "Notion connection is missing an access token",
			});
		}

		const content = await fetchNotionBlocksAsText(
			input.notionPageId,
			connection.accessToken,
		);

		if (!content.trim()) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"The selected Notion page appears to be empty or has no readable content.",
			});
		}

		const sourceTitle = input.notionTitle || "Notion PRD";
		const sourceUrl = input.notionUrl || null;
		const resourceMetadata = {
			provider: "notion",
			sourceType: "direct_bind",
			dataConnectionId: connection.id,
			notionPageId: input.notionPageId,
			isPrdSource: true,
		};

		let contextId = project.prdSourceContextId ?? null;
		const existingContext = contextId
			? await getContextById(contextId)
			: null;

		if (existingContext?.qdrantId) {
			await deleteProjectContext(
				existingContext.id,
				organizationId,
				existingContext.qdrantId,
			);
		}

		if (existingContext) {
			await db.projectContext.update({
				where: { id: existingContext.id },
				data: {
					content,
					qdrantId: null,
					sourceTitle,
					sourceUrl,
					metadata: resourceMetadata,
				},
			});
		} else {
			const createdContext = await createContext({
				projectId: input.projectId,
				type: "INTEGRATION",
				content,
				metadata: resourceMetadata,
				sourceTitle,
				sourceUrl: sourceUrl ?? undefined,
				userId: user.id,
				organizationId: organizationId ?? undefined,
			});
			contextId = createdContext.id;
		}

		if (!contextId) {
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Failed to bind the selected Notion page",
			});
		}

		const ragProviderConfig = await getRAGProviderConfig({
			userId: user.id,
			organizationId,
		});

		await embedAndRecordOutcome({
			contextId,
			projectId: input.projectId,
			userId: user.id,
			organizationId: organizationId ?? undefined,
			content,
			type: "INTEGRATION",
			apiKey: ragProviderConfig,
			metadata: {
				sourceTitle,
				sourceUrl: sourceUrl ?? undefined,
				dataConnectionId: connection.id,
			},
		});

		await db.project.update({
			where: { id: input.projectId },
			data: {
				prdSourceContextId: contextId,
				prdSourceSyncedAt: new Date(),
				prdSourceTitle: sourceTitle,
				prdSourceUrl: sourceUrl,
			},
		});

		return {
			status: "completed",
			message: "Project PRD source updated",
			contextId,
		};
	});

/**
 * Clear the bound project PRD source and delete the derived project context.
 */
export const clearPrdSourceProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/prd-source/clear",
		tags: ["Projects", "Notion", "PRD"],
		summary: "Clear Notion PRD source",
		description:
			"Clears the bound Notion PRD source and removes the derived project context and embeddings.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const tenantFilter = organizationId
			? { organizationId, userId: user.id }
			: { organizationId: null, userId: user.id };

		const project = await db.project.findFirst({
			where: {
				id: input.projectId,
				...tenantFilter,
			},
			select: {
				id: true,
				prdSourceContextId: true,
			},
		});

		if (!project) {
			throw new ORPCError("NOT_FOUND", {
				message: "Project not found",
			});
		}

		if (project.prdSourceContextId) {
			const projectContext = await getContextById(
				project.prdSourceContextId,
			);

			if (projectContext) {
				await deleteProjectContext(
					projectContext.id,
					organizationId,
					projectContext.qdrantId ?? undefined,
				);
				await deleteContext(projectContext.id);
			}
		}

		await db.project.update({
			where: { id: input.projectId },
			data: {
				prdSourceTitle: null,
				prdSourceUrl: null,
				prdSourceContextId: null,
				prdSourceSyncedAt: null,
			},
		});

		return {
			success: true,
			message: "Notion PRD source cleared successfully",
		};
	});
