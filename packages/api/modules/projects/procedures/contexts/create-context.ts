import { ORPCError } from "@orpc/client";
import {
	countContextsByType,
	createContext,
	db,
	hasProjectAccess,
	linkTeamsChannelToProject,
	linkTeamsChatToProject,
	type ProjectDocumentType,
	updateContextExtractionStatus,
} from "@repo/database";
import { ProjectContextTypeSchema } from "@repo/database/prisma/zod";
import { logger } from "@repo/logs";
import { getTemporalClient } from "@repo/temporal";
import { z } from "zod";
import { emitActivity, emitContextChange } from "../../../../lib/realtime";
import { withCorrelationMemo } from "../../../../lib/temporal-correlation";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	assertKnowledgeBaseCategoryIsDescribed,
	knowledgeBaseCategoryInputFields,
} from "./knowledge-base-category";

const MAX_INTEGRATION_CONTEXTS = 30;

export const createContextProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.CONTEXT_CREATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/contexts",
		tags: ["Projects", "Contexts"],
		summary: "Create context",
		description: "Create a new context for a project",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			type: ProjectContextTypeSchema,
			content: z.string(),
			metadata: z.record(z.string(), z.any()).optional(),
			/**
			 * What kind of source a LINK is (Fizzy #2165). Drives the Knowledge
			 * Base readiness item, which needs a source categorised
			 * `KNOWLEDGE_BASE_WIKI` that also indexed successfully.
			 *
			 * Optional at the API level: link sources created before this exist
			 * without one, and there is no backfill — guessing a category would
			 * report readiness the project has not earned. The UI requires it on
			 * new link sources.
			 */
			...knowledgeBaseCategoryInputFields,
			/**
			 * User-declared type label + AI guidance (Fizzy #1888). Optional.
			 */
			sourceType: z.string().trim().min(1).max(80).optional(),
			aiInstructions: z.string().trim().max(500).optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Check project access
		const hasAccess = await hasProjectAccess(
			input.projectId,
			user.id,
			organizationId,
		);

		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		// Validate max INTEGRATION contexts limit (e.g., max 5 Teams chats per project)
		if (input.type === "INTEGRATION") {
			const contextCounts = await countContextsByType(input.projectId);
			const currentIntegrationCount = contextCounts.INTEGRATION ?? 0;

			if (currentIntegrationCount >= MAX_INTEGRATION_CONTEXTS) {
				throw new ORPCError("BAD_REQUEST", {
					message: `Maximum of ${MAX_INTEGRATION_CONTEXTS} integration contexts allowed per project. Please remove an existing integration before adding a new one.`,
				});
			}
		}

		assertKnowledgeBaseCategoryIsDescribed(input);

		// Create context (without qdrantId initially)
		// TENANT ISOLATION: Pass userId and organizationId for proper tenant filtering
		const projectContext = await createContext({
			projectId: input.projectId,
			type: input.type,
			content: input.content,
			metadata: input.metadata,
			knowledgeBaseSourceCategory: input.knowledgeBaseSourceCategory,
			knowledgeBaseSourceCategoryOther:
				input.knowledgeBaseSourceCategoryOther?.trim() || undefined,
			sourceType: input.sourceType,
			aiInstructions: input.aiInstructions,
			userId: user.id,
			organizationId,
		});

		if (!projectContext) {
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Failed to create context",
			});
		}

		// Create ProjectDocument from tagged integration contexts
		const documentTag = input.metadata?.documentTag as string | undefined;
		if (documentTag && input.content && input.content.trim().length > 0) {
			try {
				const docType = documentTag as ProjectDocumentType;
				const title =
					(input.metadata?.documentTitle as string) ||
					(input.metadata?.sourceTitle as string) ||
					`${documentTag} Document`;

				const existingActive = await db.projectDocument.findFirst({
					where: {
						projectId: input.projectId,
						type: docType,
						isActive: true,
					},
				});

				const importedDoc = await db.projectDocument.create({
					data: {
						projectId: input.projectId,
						type: docType,
						title,
						content: input.content,
						status: "COMPLETE",
						source: "IMPORTED",
						sourceContextId: projectContext.id,
						isActive: !existingActive,
						wordCount: input.content
							.split(/\s+/)
							.filter((w: string) => w.length > 0).length,
						version: 1,
						userId: user.id,
						organizationId: organizationId ?? null,
					},
				});

				// Create initial document version for version history
				await db.documentVersion.create({
					data: {
						documentId: importedDoc.id,
						version: 1,
						content: input.content,
						changeDescription: "Imported from uploaded context",
						changedBy: user.id,
					},
				});

				logger.info(
					`[CreateContext] Created imported document from tagged context: ${projectContext.id} (${documentTag})`,
				);
			} catch (tagError) {
				logger.error(
					`[CreateContext] Failed to create document from tagged context: ${tagError}`,
				);
			}
		}

		// Auto-embed the context for RAG retrieval using Temporal workflow
		const hasEmbeddableContent =
			input.content && input.content.trim().length > 0;

		// Real wiring for metadata-only INTEGRATION rows whose data lives in an
		// external chat/channel (Teams group chat, Teams channel, Slack channel).
		// The row itself has no embeddable content; the actual messages reach
		// the project's RAG store via the dedicated monitor workflows
		// (teamsChatMonitorWorkflow / teamsChannelMonitorWorkflow /
		// slackChannelMonitorWorkflow), which read from `ProjectLinkedTeams*Chat`
		// / `ProjectLinkedSlackChannel` rows. Earlier code (PR #1298) flipped
		// these to COMPLETED without creating the linked-row, so the pill said
		// "Ready" while no messages ever flowed. Here we create the linked-row
		// first (the monitor's source of truth) and only then mark the context
		// COMPLETED. The wizard's `createIntegrationContexts` calls the
		// matching `enable*Monitor` procedure once per project after this
		// returns, so the workflow starts polling. Failures surface as
		// FAILED + `extractionError` for accurate UI feedback.
		if (input.type === "INTEGRATION" && !hasEmbeddableContent) {
			const provider = (input.metadata?.provider ?? "") as string;
			const chatType = (input.metadata?.chatType ?? "") as string;
			const orgIdForLink = organizationId ?? undefined;

			const failContext = async (message: string) => {
				try {
					await updateContextExtractionStatus(
						projectContext.id,
						"FAILED",
						{ extractionError: message },
					);
				} catch (statusError) {
					logger.error(
						`[CreateContext] Failed to mark INTEGRATION context FAILED (${projectContext.id}): ${statusError}`,
					);
				}
			};

			const completeContext = async () => {
				try {
					await updateContextExtractionStatus(
						projectContext.id,
						"COMPLETED",
					);
				} catch (statusError) {
					logger.error(
						`[CreateContext] Failed to mark INTEGRATION context COMPLETED (${projectContext.id}): ${statusError}`,
					);
				}
			};

			try {
				if (
					provider === "MICROSOFT_TEAMS" &&
					(chatType === "group" || chatType === "oneOnOne") &&
					typeof input.metadata?.chatId === "string"
				) {
					await linkTeamsChatToProject({
						projectId: input.projectId,
						chatId: input.metadata.chatId as string,
						chatTopic:
							(input.metadata?.chatTopic as string | undefined) ??
							undefined,
						chatWebUrl:
							(input.metadata?.chatWebUrl as
								| string
								| undefined) ?? undefined,
						backfillMode: "from-now",
						userId: user.id,
						organizationId: orgIdForLink,
					});
					await completeContext();
				} else if (
					provider === "MICROSOFT_TEAMS" &&
					chatType === "channel" &&
					typeof input.metadata?.teamId === "string" &&
					typeof input.metadata?.channelId === "string"
				) {
					await linkTeamsChannelToProject({
						projectId: input.projectId,
						teamId: input.metadata.teamId as string,
						channelId: input.metadata.channelId as string,
						teamName:
							(input.metadata?.teamName as string | undefined) ??
							undefined,
						channelName:
							(input.metadata?.channelName as
								| string
								| undefined) ?? undefined,
						channelWebUrl:
							(input.metadata?.channelWebUrl as
								| string
								| undefined) ?? undefined,
						backfillMode: "from-now",
						userId: user.id,
						organizationId: orgIdForLink,
					});
					await completeContext();
				}
				// Slack is intentionally NOT linked here. The DB-layer
				// `linkSlackChannelToProject` requires `slackTeamId`, which
				// the Slack picker in the wizard's MCP search does not
				// surface — the workspace ID is resolved at link time only
				// by the `slackChannelMonitor.linkChannel` procedure (via
				// Slack's `auth.test` endpoint against the wrapper's bot
				// token). The wizard's `createIntegrationContexts` calls
				// that procedure from the client after this returns, which
				// creates the `ProjectLinkedSlackChannel` row. The
				// matching ProjectContext stays PENDING for Slack until a
				// follow-up exposes a tenant-scoped procedure that flips
				// the status after the link succeeds (TODO: tracked as a
				// known cosmetic gap distinct from the actual ingest flow,
				// which IS wired by the client-side link + enable calls).
				// Other metadata-only INTEGRATION rows (CONFLUENCE, BACKLOG
				// — no monitor exists on file) also stay PENDING.
			} catch (linkError) {
				const message =
					linkError instanceof Error
						? linkError.message
						: "Failed to link integration source";
				logger.error(
					`[CreateContext] Failed to link INTEGRATION (${provider}/${chatType}) for context ${projectContext.id}: ${message}`,
				);
				await failContext(message);
			}
		}

		if (hasEmbeddableContent) {
			// Start Temporal workflow for durable embedding (fire-and-forget)
			// This provides retry logic, durability, and monitoring
			(async () => {
				try {
					const client = await getTemporalClient();
					const workflowId = `context-embedding-${projectContext.id}-${Date.now()}`;

					await client.workflow.start(
						"contextEmbeddingWorkflow",
						withCorrelationMemo({
							taskQueue: "project-documents",
							workflowId,
							args: [
								{
									contextId: projectContext.id,
									projectId: input.projectId,
									userId: user.id,
									organizationId,
									content: input.content,
									type: input.type,
									metadata: input.metadata as {
										filename?: string;
										sourceUrl?: string;
										sourceTitle?: string;
										[key: string]: unknown;
									},
								},
							],
						}),
					);

					logger.info(
						`[CreateContext] Started context embedding workflow ${workflowId}`,
					);
				} catch (error) {
					// Log error but don't fail the request
					logger.error(
						`[CreateContext] Failed to start context embedding workflow for ${projectContext.id}: ${error}`,
					);
				}
			})();
		} else if (
			input.type === "INTEGRATION" &&
			input.metadata?.provider === "notion"
		) {
			logger.warn(
				`[CreateContext] Notion context ${projectContext.id} has empty content. Content can be resynced from Integrations before attaching it to the project.`,
			);
		}

		// Emit real-time events for collaboration
		const contextName =
			(input.metadata?.filename as string) ||
			(input.metadata?.sourceTitle as string) ||
			`${input.type} context`;

		await Promise.all([
			emitContextChange({
				projectId: input.projectId,
				contextId: projectContext.id,
				action: "added",
				userId: user.id,
				userName: user.name || "Anonymous",
				contextType: input.type,
				contextName,
			}),
			emitActivity({
				projectId: input.projectId,
				userId: user.id,
				userName: user.name || "Anonymous",
				activityType: "context_added",
				resourceType: "context",
				resourceId: projectContext.id,
				resourceName: contextName,
				timestamp: new Date().toISOString(),
			}),
		]);

		return { context: projectContext };
	});
