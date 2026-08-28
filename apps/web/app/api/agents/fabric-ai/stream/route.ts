import { getDefaultEnabledMcpConfigIds } from "@repo/agent-core/backend";
import { getAIModelWithMetadata, getCurrentDateContext } from "@repo/ai";
import { checkRateLimit, RATE_LIMIT_PRESETS } from "@repo/api/lib/rate-limit";
import { AiUsageLimitExceededError } from "@repo/payments";
import {
	type DirectChatProgressUpdate,
	type DirectChatWorkflowInput,
	type DirectChatWorkflowOutput,
	getTemporalClient,
	isTemporalAvailable,
} from "@repo/temporal";
import { getSession } from "@saas/auth/lib/server";
import type { NextRequest } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { unionDefaultMcpConfigIds } from "../union-default-mcp-config-ids";
import { extractAiUsageLimitExceededError } from "./extract-ai-usage-limit-error";
import {
	type FrontendReasoningMode,
	normalizeReasoningMode,
} from "./normalize-reasoning-mode";
import { extractWorkflowFailureMessage } from "./workflow-failure-message";

function buildWorkflowErrorEvent(error: unknown) {
	const limitError = extractAiUsageLimitExceededError(error);
	if (limitError) {
		return {
			type: "error" as const,
			code: "AI_USAGE_LIMIT_EXCEEDED" as const,
			message: limitError.message,
			data: {
				limitId: limitError.limitId,
				dimension: limitError.dimension,
				window: limitError.window,
				used: limitError.used.toString(),
				max: limitError.max.toString(),
				manageLimitsUrl: limitError.manageLimitsUrl,
			},
		};
	}
	return {
		type: "error" as const,
		message: extractWorkflowFailureMessage(error),
	};
}

const AGENT_CONTEXT_STORY_LIMIT = 30;
const AGENT_CONTEXT_STORY_RENDER_LIMIT = 15;
const AGENT_CONTEXT_DOCUMENT_LIMIT = 6;
const AGENT_CONTEXT_CODING_RUN_LIMIT = 6;
const AGENT_CONTEXT_STALE_DAYS = 14;

const streamRequestSchema = z.object({
	message: z.string().min(1).max(100_000),
	// `system` is accepted and folded into the assistant turn below. Persisted
	// conversations legitimately hold system rows (operation results), so a
	// client replaying its own history must not be rejected outright — that
	// turned one such row into a permanently dead thread.
	history: z
		.array(
			z.object({
				role: z.enum(["user", "assistant", "system"]),
				content: z.string().max(200_000),
			}),
		)
		.max(200)
		.default([]),
	organizationId: z.string().nullish(),
	reasoningMode: z
		.enum(["lite", "balanced", "deep", "planner"])
		.default("balanced"),
	instanceId: z.string().max(200).nullish(),
	chatId: z.string().max(200).nullish(),
	attachedDocumentIds: z.array(z.string().max(200)).max(20).default([]),
	/**
	 * Full text of files attached in this turn, one finished envelope entry
	 * per file. Additive to `attachedDocumentIds`, which drives retrieval.
	 *
	 * Bounded per entry as well as in count: the client already applies the
	 * character budget before building the envelope, so this ceiling is the
	 * server refusing to take the client's word for it rather than a second
	 * budget. It sits above the client budget so a legitimate entry — budgeted
	 * text plus the envelope's own wrapper and marker — is never clipped here.
	 */
	inlineAttachmentContexts: z
		.array(z.string().max(200_000))
		.max(20)
		.default([]),
	workspaceIds: z.array(z.string().max(200)).max(20).default([]),
	workspaceDocumentIds: z.array(z.string().max(200)).max(200).default([]),
	projectId: z.string().max(200).nullish(),
	// Focused entity the user is currently VIEWING (the page the Fabric Agent
	// was opened on). When present, the agent is grounded on this item's FULL
	// content (untruncated description + acceptance criteria + document body) —
	// distinct from `attachedDocumentIds` (chat file attachments).
	storyId: z.string().max(200).nullish(),
	documentId: z.string().max(200).nullish(),
	taskId: z.string().max(200).nullish(),
	conversationId: z.string().max(200).nullish(),
	enabledMcpConfigIds: z.array(z.string().max(200)).max(50).nullish(),
	enabledFabricToolIds: z.array(z.string().max(200)).max(100).nullish(),
	systemPrompt: z.string().max(50_000).nullish(),
	modelOverride: z.string().max(200).nullish(),
});

function truncateContextText(
	value: string | null | undefined,
	maxLength = 420,
) {
	if (!value) {
		return null;
	}
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized.length > maxLength
		? `${normalized.slice(0, maxLength - 1)}…`
		: normalized;
}

// Like truncateContextText but PRESERVES structure (newlines, headings) so the
// model can see the document's sections. Used only for the focused entity the
// user is actively viewing, where full section fidelity matters. The large cap
// comfortably fits multi-thousand-word docs while bounding pathological cases.
function clampFocusedContent(
	value: string | null | undefined,
	maxLength = 60_000,
) {
	if (!value) {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > maxLength
		? `${trimmed.slice(0, maxLength - 1)}…`
		: trimmed;
}

async function buildAgentContextSystemPrompt({
	projectId,
	baseSystemPrompt,
	focusedStoryId,
	focusedDocumentId,
	focusedTaskId,
}: {
	projectId: string;
	baseSystemPrompt?: string;
	focusedStoryId?: string | null;
	focusedDocumentId?: string | null;
	focusedTaskId?: string | null;
}) {
	try {
		const { db } = await import("@repo/database");
		const staleBefore = new Date(
			Date.now() - AGENT_CONTEXT_STALE_DAYS * 24 * 60 * 60 * 1000,
		);
		const [project, stories, documents, codingRuns] = await Promise.all([
			db.project.findUnique({
				where: { id: projectId },
				select: {
					id: true,
					name: true,
					description: true,
					goals: true,
					status: true,
					repositoryUrl: true,
					repositoryOwner: true,
					repositoryName: true,
					defaultBranch: true,
					updatedAt: true,
				},
			}),
			db.userStory.findMany({
				where: { projectId },
				// Mirrors the roadmap Priority layout's ranking (see
				// `comparePriorityRank` in
				// modules/saas/projects/lib/priority-ranking.ts) so "what should I
				// work on next?" is answered from the team's actual rank instead of
				// whatever was touched most recently: completed work sinks,
				// hand-pinned items lead in pin order (NULL = never pinned, and
				// Postgres sorts NULLs last on ASC), then the priority band — the
				// StoryPriority enum is declared P0_CRITICAL first and Postgres
				// orders enums by declaration order, so ASC is most-critical-first
				// — then the per-band roadmap order, with `id` as a stable
				// tiebreak. One query: the view's within-band signal score needs
				// per-story counts we deliberately don't fan out for here.
				orderBy: [
					{ status: { isFinal: "asc" } },
					{ priorityOrder: { sort: "asc", nulls: "last" } },
					{ priority: "asc" },
					{ roadmapOrder: "asc" },
					{ id: "asc" },
				],
				take: AGENT_CONTEXT_STORY_LIMIT,
				select: {
					id: true,
					identifier: true,
					title: true,
					description: true,
					priority: true,
					draftingStage: true,
					createdAt: true,
					lastEditedAt: true,
					status: { select: { name: true, isFinal: true } },
					tasks: {
						select: {
							id: true,
							identifier: true,
							title: true,
							isCompleted: true,
							agentStatus: true,
							agentError: true,
						},
						orderBy: { order: "asc" },
					},
				},
			}),
			db.projectDocument.findMany({
				where: { projectId, isActive: true },
				orderBy: { updatedAt: "desc" },
				take: AGENT_CONTEXT_DOCUMENT_LIMIT,
				select: {
					id: true,
					title: true,
					type: true,
					status: true,
					updatedAt: true,
				},
			}),
			db.codingRun.findMany({
				where: { projectId },
				orderBy: { updatedAt: "desc" },
				take: AGENT_CONTEXT_CODING_RUN_LIMIT,
				select: {
					id: true,
					status: true,
					provider: true,
					executionChannel: true,
					externalUrl: true,
					pullRequestUrl: true,
					updatedAt: true,
					story: { select: { identifier: true, title: true } },
					storyTask: { select: { identifier: true, title: true } },
				},
			}),
		]);

		if (!project) {
			return baseSystemPrompt;
		}

		// Full-fidelity context for the entity the user is CURRENTLY VIEWING
		// (the page the Fabric Agent was opened on). The bounded lists below are
		// ambient project awareness; THIS block is the focused item at full
		// detail — every section — so the agent can read and safely edit exactly
		// what is on screen. Scoped to the already-authorized `projectId` so a
		// caller cannot pull a sibling tenant's entity by id.
		let focusedBlock: string | null = null;
		try {
			if (focusedStoryId) {
				const story = await db.userStory.findFirst({
					where: { id: focusedStoryId, projectId },
					select: {
						identifier: true,
						title: true,
						description: true,
						acceptanceCriteria: true,
						status: { select: { name: true } },
						tasks: {
							select: {
								identifier: true,
								title: true,
								isCompleted: true,
							},
							orderBy: { order: "asc" },
						},
					},
				});
				if (story) {
					focusedBlock = [
						`## Currently viewing — Feature ${story.identifier}: ${story.title} (FULL content)`,
						"This is the exact item the user is looking at; treat it as the primary subject. Quote and reason over its sections directly — never say you cannot see it.",
						`Status: ${story.status.name}`,
						story.description
							? `### Description\n${clampFocusedContent(story.description)}`
							: null,
						story.acceptanceCriteria
							? `### Acceptance Criteria\n${clampFocusedContent(story.acceptanceCriteria)}`
							: null,
						story.tasks.length > 0
							? `### Tasks (${story.tasks.filter((task) => task.isCompleted).length}/${story.tasks.length} done)\n${story.tasks
									.map(
										(task) =>
											`- [${task.isCompleted ? "x" : " "}] ${task.identifier} ${task.title}`,
									)
									.join("\n")}`
							: null,
					]
						.filter(Boolean)
						.join("\n\n");
				}
			} else if (focusedDocumentId) {
				const focusedDocument = await db.projectDocument.findFirst({
					where: { id: focusedDocumentId, projectId },
					select: { title: true, type: true, content: true },
				});
				if (focusedDocument) {
					focusedBlock = [
						`## Currently viewing — Document "${focusedDocument.title}" (${focusedDocument.type}, FULL content)`,
						"This is the exact document the user is looking at; treat it as the primary subject. Quote and reason over its sections directly — never say you cannot see it.",
						clampFocusedContent(focusedDocument.content) ??
							"(the document is currently empty)",
					]
						.filter(Boolean)
						.join("\n\n");
				}
			} else if (focusedTaskId) {
				const task = await db.storyTask.findFirst({
					where: { id: focusedTaskId, story: { projectId } },
					select: {
						identifier: true,
						title: true,
						description: true,
						isCompleted: true,
						story: { select: { identifier: true, title: true } },
					},
				});
				if (task) {
					focusedBlock = [
						`## Currently viewing — Task ${task.identifier}: ${task.title} (FULL content)`,
						`Parent feature: ${task.story.identifier} ${task.story.title}`,
						`Status: ${task.isCompleted ? "completed" : "open"}`,
						task.description
							? `### Description\n${clampFocusedContent(task.description)}`
							: null,
					]
						.filter(Boolean)
						.join("\n\n");
				}
			}
		} catch (focusedError) {
			console.warn(
				"[Fabric AI Stream] Failed to load focused entity context:",
				focusedError,
			);
		}

		const statusCounts = stories.reduce<Record<string, number>>(
			(acc, story) => {
				acc[story.status.name] = (acc[story.status.name] ?? 0) + 1;
				return acc;
			},
			{},
		);
		const riskSignals = [
			...stories
				.filter(
					(story) =>
						!story.status.isFinal &&
						(story.lastEditedAt ?? story.createdAt) < staleBefore,
				)
				.slice(0, 5)
				.map((story) => {
					const activityAt = story.lastEditedAt ?? story.createdAt;
					return `${story.identifier} may be stale (last activity ${activityAt.toISOString().slice(0, 10)})`;
				}),
			...stories
				.flatMap((story) =>
					story.tasks
						.filter(
							(task) =>
								task.agentStatus === "failed" ||
								task.agentError,
						)
						.map(
							(task) =>
								`${task.identifier} has a failed agent task${task.agentError ? `: ${truncateContextText(task.agentError, 120)}` : ""}`,
						),
				)
				.slice(0, 5),
			...codingRuns
				.filter((run) => ["FAILED", "CANCELLED"].includes(run.status))
				.map(
					(run) =>
						`Implementation session ${run.id} is ${run.status.toLowerCase()}`,
				),
		].slice(0, 10);

		const contextBlock = [
			focusedBlock,
			"## Fabric Workspace Context",
			"Use this bounded, tenant-authorized project context to ground project catch-up, risk review, backlog analysis, project-update, and implementation-planning requests. Cite the source labels/IDs below when you use them. If a needed record is not listed, say what else you need rather than guessing.",
			getCurrentDateContext(),
			`Project: ${project.name} (${project.id})`,
			project.description
				? `Description: ${truncateContextText(project.description)}`
				: null,
			project.goals
				? `Goals: ${truncateContextText(project.goals)}`
				: null,
			`Status: ${project.status}`,
			project.repositoryUrl
				? `Repository: ${project.repositoryOwner ? `${project.repositoryOwner}/` : ""}${project.repositoryName ?? ""} (${project.repositoryUrl})${project.defaultBranch ? ` on ${project.defaultBranch}` : ""}`
				: null,
			`Feature status counts: ${
				Object.entries(statusCounts)
					.map(([name, count]) => `${name}: ${count}`)
					.join(", ") || "none"
			}`,
			stories.length > 0
				? `Features in priority-rank order (top ${Math.min(stories.length, AGENT_CONTEXT_STORY_RENDER_LIMIT)} of ${stories.length}) — this is the roadmap Priority ranking, NOT recency: rank 1 is what the team should pick up next. Manually pinned items lead, then priority band (P0 highest), then roadmap order; completed features sort last.\n${stories
						.slice(0, AGENT_CONTEXT_STORY_RENDER_LIMIT)
						.map(
							(story, index) =>
								`${index + 1}. ${story.identifier} ${story.title} [${story.status.name}, ${story.priority}, ${story.draftingStage}] tasks ${story.tasks.filter((task) => task.isCompleted).length}/${story.tasks.length}${story.description ? ` — ${truncateContextText(story.description, 180)}` : ""}`,
						)
						.join("\n")}`
				: null,
			documents.length > 0
				? `Recent documents:\n${documents
						.map(
							(document) =>
								`- ${document.title} (${document.type}, ${document.status}, ${document.id})`,
						)
						.join("\n")}`
				: null,
			codingRuns.length > 0
				? `Recent implementation sessions:\n${codingRuns
						.map((run) => {
							const target = run.storyTask
								? `${run.storyTask.identifier} ${run.storyTask.title}`
								: `${run.story.identifier} ${run.story.title}`;
							return `- ${run.id}: ${run.status} via ${run.provider} for ${target}${run.pullRequestUrl ? ` PR ${run.pullRequestUrl}` : run.externalUrl ? ` ${run.externalUrl}` : ""}`;
						})
						.join("\n")}`
				: null,
			riskSignals.length > 0
				? `Detected risk signals:\n${riskSignals.map((signal) => `- ${signal}`).join("\n")}`
				: null,
		]
			.filter(Boolean)
			.join("\n\n");

		return [baseSystemPrompt, contextBlock].filter(Boolean).join("\n\n");
	} catch (error) {
		console.warn(
			"[Fabric AI Stream] Failed to build project context:",
			error,
		);
		return baseSystemPrompt;
	}
}

/**
 * Fabric Loom Agent - Streaming Chat API
 * Streams responses and tool calls in real-time for the Fabric Loom Agent.
 * Uses Server-Sent Events (SSE) to push updates to the client.
 * Features:
 * - Real-time streaming of text responses
 * - Tool call events (start/result) for UI feedback
 * - Semantic memory context integration
 * - MCP tool suggestions
 * - Workflow tools (list, view, execute)
 * - Temporal workflow durability (when available)
 * Note: URL path remains /api/agents/fabric-ai/* for backward compatibility
 */
export async function POST(request: NextRequest) {
	try {
		const session = await getSession();
		if (!session) {
			return new Response(JSON.stringify({ error: "Unauthorized" }), {
				status: 401,
				headers: { "Content-Type": "application/json" },
			});
		}

		const userId = session.user.id;

		// Rate limit: 20 requests per minute per user (AI preset)
		const rateLimitResult = await checkRateLimit(
			`fabric-ai-stream:${userId}`,
			RATE_LIMIT_PRESETS.ai.limit,
			RATE_LIMIT_PRESETS.ai.windowMs,
		);
		if (!rateLimitResult.allowed) {
			return new Response(
				JSON.stringify({
					error: "Too many requests",
					message: `Rate limit exceeded. Please try again in ${rateLimitResult.resetInSeconds} seconds.`,
					retryAfter: rateLimitResult.resetInSeconds,
				}),
				{
					status: 429,
					headers: {
						"Content-Type": "application/json",
						"Retry-After":
							rateLimitResult.resetInSeconds.toString(),
						"X-RateLimit-Limit":
							RATE_LIMIT_PRESETS.ai.limit.toString(),
						"X-RateLimit-Remaining":
							rateLimitResult.remaining.toString(),
					},
				},
			);
		}

		// Validate request body with Zod schema
		const rawBody = await request.json();
		const parseResult = streamRequestSchema.safeParse(rawBody);
		if (!parseResult.success) {
			return new Response(
				JSON.stringify({
					error: "Invalid request body",
					details: parseResult.error.issues.map((i) => ({
						path: i.path.join("."),
						message: i.message,
					})),
				}),
				{
					status: 400,
					headers: { "Content-Type": "application/json" },
				},
			);
		}

		const {
			message,
			history: rawHistory,
			organizationId: rawOrganizationId,
			reasoningMode,
			instanceId,
			chatId,
			attachedDocumentIds,
			inlineAttachmentContexts,
			workspaceIds: providedWorkspaceIds,
			workspaceDocumentIds,
			projectId: providedProjectId,
			storyId,
			documentId,
			taskId,
			conversationId,
			enabledMcpConfigIds,
			enabledFabricToolIds,
			systemPrompt,
			modelOverride,
		} = parseResult.data;

		// The model API takes two roles. A persisted system row carries the
		// outcome of an operation this assistant ran, so it is attributed to
		// the assistant rather than dropped — the content self-labels.
		const history = rawHistory.map((entry) => ({
			role:
				entry.role === "user"
					? ("user" as const)
					: ("assistant" as const),
			content: entry.content,
		}));

		// Validate organizationId against session to prevent cross-tenant access
		const sessionOrgId = session.session?.activeOrganizationId ?? undefined;
		const organizationId =
			rawOrganizationId === sessionOrgId ||
			rawOrganizationId === null ||
			rawOrganizationId === undefined
				? (rawOrganizationId ?? undefined)
				: sessionOrgId;

		// Fetch workspace IDs from database if not provided but conversation exists
		// This handles the race condition where frontend sends request before query returns
		let workspaceIds = providedWorkspaceIds;
		if (
			(!providedWorkspaceIds || providedWorkspaceIds.length === 0) &&
			conversationId
		) {
			const { getConversationWorkspaces } = await import(
				"@repo/database"
			);
			const attachedWorkspaces =
				await getConversationWorkspaces(conversationId);
			workspaceIds = attachedWorkspaces.map(
				(wc: { workspace: { id: string } }) => wc.workspace.id,
			);
		}

		// Resolve project ID from conversation if not provided
		let projectId = providedProjectId ?? undefined;
		if (!projectId && conversationId) {
			try {
				const { getConversationProject } = await import(
					"@repo/database"
				);
				const conversationProject =
					await getConversationProject(conversationId);
				if (conversationProject?.project) {
					projectId = conversationProject.project.id;
				}
			} catch (error) {
				console.warn(
					"[Fabric AI Stream] Failed to resolve conversation project:",
					error,
				);
			}
		}

		// Verify project access before forwarding to workflow
		if (projectId) {
			try {
				const { hasProjectAccess } = await import("@repo/database");
				const canAccess = await hasProjectAccess(
					projectId,
					userId,
					organizationId ?? undefined,
				);
				if (!canAccess) {
					console.warn(
						"[Fabric AI Stream] User does not have access to project:",
						projectId,
					);
					projectId = undefined;
				}
			} catch (error) {
				console.warn(
					"[Fabric AI Stream] Failed to verify project access:",
					error,
				);
				projectId = undefined;
			}
		}

		const contextualSystemPrompt = projectId
			? await buildAgentContextSystemPrompt({
					projectId,
					baseSystemPrompt: systemPrompt ?? undefined,
					focusedStoryId: storyId,
					focusedDocumentId: documentId,
					focusedTaskId: taskId,
				})
			: (systemPrompt ?? undefined);

		// Get AI model and provider config using centralized entry point
		let aiModelResult: Awaited<ReturnType<typeof getAIModelWithMetadata>>;
		try {
			// No featureKey here on purpose: this resolution exists to hit the
			// usage-limit chokepoint, and the model it returns is discarded —
			// generation happens in the Temporal chat activity, which carries
			// the tag. Tagging here would attribute a call that never runs.
			aiModelResult = await getAIModelWithMetadata(
				{ taskType: "CHAT" },
				{ userId, organizationId },
			);
		} catch (error) {
			// AI usage-limit chokepoint hit a HARD limit.
			// The pre-stream JSON envelope path is
			// reached because `getAIModelWithMetadata` throws BEFORE the
			// SSE stream is constructed; we surface the structured error
			// here so the consumer hook detects it via `code` and renders
			// the shared destructive toast (the consumer hook also
			// matches `data.code` inside SSE error events for the
			// post-stream path — see useDirectStream.ts).
			if (error instanceof AiUsageLimitExceededError) {
				return new Response(
					JSON.stringify({
						error: error.message,
						code: "AI_USAGE_LIMIT_EXCEEDED",
						data: {
							limitId: error.limitId,
							dimension: error.dimension,
							window: error.window,
							used: error.used.toString(),
							max: error.max.toString(),
							manageLimitsUrl: error.manageLimitsUrl,
						},
					}),
					{
						status: 429,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
			console.error("[Fabric AI Stream] Failed to get AI model:", error);
			return new Response(
				JSON.stringify({
					error:
						error instanceof Error
							? error.message
							: "No AI provider configured. Please configure an AI provider in Settings → AI Providers.",
					code: "AI_GATEWAY_MISSING",
				}),
				{
					status: 400,
					headers: { "Content-Type": "application/json" },
				},
			);
		}

		const { trackUsage } = aiModelResult;

		// Track usage (fire-and-forget)
		trackUsage();

		// ==========================================================================
		// Use Temporal workflow for durable execution
		// Temporal is required for proper document processing and RAG support
		// ==========================================================================
		const temporalAvailable = await isTemporalAvailable();

		if (!temporalAvailable) {
			console.error(
				"[Fabric AI Stream] Temporal is not available. Please ensure Temporal is running.",
			);
			return new Response(
				JSON.stringify({
					error: "Temporal workflow service is not available. Please ensure Temporal is running (use ./aspire.sh restart).",
				}),
				{
					status: 503, // Service Unavailable
					headers: { "Content-Type": "application/json" },
				},
			);
		}

		// Use Temporal workflow for durability and RAG support
		// SECURITY: Credentials are fetched internally by activities, NOT passed in workflow inputs
		// Workflow inputs are stored in Temporal's database and visible in Web UI
		return handleTemporalWorkflow({
			message,
			history,
			userId,
			organizationId,
			reasoningMode,
			instanceId: instanceId ?? undefined,
			chatId: chatId ?? undefined,
			attachedDocumentIds,
			inlineAttachmentContexts,
			workspaceIds,
			workspaceDocumentIds,
			projectId,
			enabledMcpConfigIds: enabledMcpConfigIds ?? undefined,
			enabledFabricToolIds: enabledFabricToolIds ?? undefined,
			systemPrompt: contextualSystemPrompt,
			modelOverride: modelOverride ?? undefined,
			conversationId: conversationId ?? undefined,
		});
	} catch (error) {
		console.error("[Fabric AI Stream] Error:", error);
		return new Response(
			JSON.stringify({
				error: error instanceof Error ? error.message : "Stream failed",
			}),
			{
				status: 500,
				headers: { "Content-Type": "application/json" },
			},
		);
	}
}

// Constants for polling
const POLL_INTERVAL = 150; // Poll every 150ms for real-time updates
const MAX_POLL_DURATION = 300000; // 5 minutes max
// SSE comment heartbeat so intermediaries don't idle-drop the stream during
// silent stretches between progress events; clients ignore `:` comment lines.
const HEARTBEAT_INTERVAL = 15000;

/**
 * Handle chat using Temporal workflow for durability
 * This function starts a Temporal workflow and streams the results back to the client.
 * Uses polling to stream real-time progress updates.
 * The workflow handles:
 * - MCP tool collection
 * - Memory context generation
 * - RAG context retrieval (if documents attached)
 * - Tool suggestions
 * - AI execution with tools
 * The results are streamed back as SSE events.
 */
async function handleTemporalWorkflow(params: {
	message: string;
	history: Array<{ role: "user" | "assistant"; content: string }>;
	userId: string;
	organizationId?: string;
	reasoningMode?: FrontendReasoningMode;
	instanceId?: string;
	chatId?: string;
	attachedDocumentIds?: string[];
	inlineAttachmentContexts?: string[];
	workspaceIds?: string[];
	workspaceDocumentIds?: string[];
	projectId?: string;
	enabledMcpConfigIds?: string[];
	enabledFabricToolIds?: string[];
	systemPrompt?: string;
	modelOverride?: string;
	/**
	 * Optional AgentConversation ID. Threaded into the
	 * `DirectChatWorkflowInput` so the workflow's Step 6 can append a
	 * persistent operation-result system message at completion. Forwarding
	 * via this internal helper is necessary because the request handler
	 * destructures `conversationId` from `parseResult.data` but then calls
	 * `handleTemporalWorkflow` with an explicit param list (so the inner
	 * function doesn't share the outer's lexical scope).
	 */
	conversationId?: string;
}): Promise<Response> {
	const {
		message,
		history,
		userId,
		organizationId,
		reasoningMode,
		instanceId,
		chatId,
		attachedDocumentIds,
		inlineAttachmentContexts,
		workspaceIds,
		workspaceDocumentIds,
		projectId,
		enabledMcpConfigIds,
		enabledFabricToolIds,
		systemPrompt,
		modelOverride,
		conversationId,
	} = params;
	const executionId = `direct-chat-${uuidv4()}`;

	console.log(
		`[Fabric AI Stream] Starting Temporal workflow: ${executionId}`,
	);

	const encoder = new TextEncoder();
	let isClosed = false;

	const stream = new ReadableStream({
		async start(controller) {
			const sendEvent = (data: unknown) => {
				if (isClosed) {
					return; // Don't send if already closed
				}
				try {
					controller.enqueue(
						encoder.encode(`data: ${JSON.stringify(data)}\n\n`),
					);
				} catch {
					// Controller already closed, mark as closed
					isClosed = true;
				}
			};

			const stableSerialize = (value: unknown): string => {
				try {
					return JSON.stringify(value) ?? "";
				} catch {
					return String(value);
				}
			};

			type StreamedToolCall = {
				id: string;
				name: string;
				serverName?: string;
				args?: Record<string, unknown>;
				result?: unknown;
				status: string;
				/**
				 * Why this is carried separately from `result`: a tool that
				 * never ran has no result to explain itself with. The activity
				 * settles such a call with an `error` string and no output, so
				 * dropping this field here left the client rendering an empty
				 * red box - the status badge said "Error" and the body was
				 * blank. Same defect PR 1093 fixed in the render layer,
				 * recurring in the transport.
				 */
				error?: string;
				mcpAppResourceUri?: string;
				mcpAppConfigId?: string;
			};
			let streamedResponseLength = 0;

			const emitResponseDelta = (fullResponseText?: string) => {
				if (!fullResponseText) {
					return;
				}

				if (fullResponseText.length < streamedResponseLength) {
					streamedResponseLength = 0;
				}

				const nextChunk = fullResponseText.slice(
					streamedResponseLength,
				);
				if (nextChunk.length === 0) {
					return;
				}

				sendEvent({ type: "text", content: nextChunk });
				streamedResponseLength = fullResponseText.length;
			};

			let streamedReasoningLength = 0;

			const emitReasoningDelta = (fullReasoningText?: string) => {
				if (!fullReasoningText) {
					return;
				}
				if (fullReasoningText.length < streamedReasoningLength) {
					streamedReasoningLength = 0;
				}
				const nextChunk = fullReasoningText.slice(
					streamedReasoningLength,
				);
				if (nextChunk.length === 0) {
					return;
				}
				sendEvent({ type: "reasoning", content: nextChunk });
				streamedReasoningLength = fullReasoningText.length;
			};

			const lastToolSnapshots = new Map<
				string,
				{
					args: string;
					result: string;
					status: string;
					started: boolean;
				}
			>();

			const emitToolCallDelta = (toolCall: StreamedToolCall) => {
				const previous = lastToolSnapshots.get(toolCall.id);
				const nextArgs = stableSerialize(toolCall.args ?? null);
				const nextResult = stableSerialize(toolCall.result ?? null);

				if (!previous?.started) {
					sendEvent({
						type: "tool_start",
						toolCallId: toolCall.id,
						toolName: toolCall.name,
						serverName: toolCall.serverName,
						args: toolCall.args,
						status: toolCall.status,
						mcpAppResourceUri: toolCall.mcpAppResourceUri,
						mcpAppConfigId: toolCall.mcpAppConfigId,
					});
				}

				if (previous === undefined || nextArgs !== previous.args) {
					sendEvent({
						type: "tool_input",
						toolCallId: toolCall.id,
						toolName: toolCall.name,
						serverName: toolCall.serverName,
						args: toolCall.args,
						status: toolCall.status,
						mcpAppResourceUri: toolCall.mcpAppResourceUri,
						mcpAppConfigId: toolCall.mcpAppConfigId,
					});
				}

				if (
					(toolCall.status === "complete" ||
						toolCall.status === "error") &&
					(previous === undefined ||
						previous.status !== toolCall.status ||
						nextResult !== previous.result)
				) {
					sendEvent({
						type: "tool_result",
						toolCallId: toolCall.id,
						toolName: toolCall.name,
						result: toolCall.result,
						status: toolCall.status,
						error: toolCall.error,
						mcpAppResourceUri: toolCall.mcpAppResourceUri,
						mcpAppConfigId: toolCall.mcpAppConfigId,
					});
				}

				lastToolSnapshots.set(toolCall.id, {
					args: nextArgs,
					result: nextResult,
					status: toolCall.status,
					started: true,
				});
			};

			try {
				const temporalClient = await getTemporalClient();

				// Union default-enabled MCP config ids into the caller-restricted
				// set so managed-default servers (e.g. Excalidraw, when
				// `defaultEnabled`) are eligible inside the direct-chat workflow.
				// On helper failure, log and proceed with the original array.
				//
				// `unionDefaultMcpConfigIds` guards the three-state contract:
				// `null`/`undefined` ("all configs enabled") and `[]`
				// ("explicitly none") pass through untouched, since unioning
				// into either would narrow it to the defaults alone.
				let effectiveEnabledMcpConfigIds: string[] | undefined =
					enabledMcpConfigIds;
				try {
					const defaultIds = await getDefaultEnabledMcpConfigIds(
						userId,
						organizationId ?? null,
					);
					effectiveEnabledMcpConfigIds = unionDefaultMcpConfigIds(
						enabledMcpConfigIds,
						defaultIds,
					);
				} catch (defaultIdsError) {
					console.warn(
						"[Direct Chat Stream] Failed to union default-enabled MCP config ids — proceeding with caller-supplied array",
						defaultIdsError,
					);
				}

				// Build workflow input
				// SECURITY: Credentials are NOT included - activities fetch them internally
				const workflowInput: DirectChatWorkflowInput = {
					executionId,
					instanceId,
					message,
					history,
					userId,
					organizationId,
					reasoningMode: normalizeReasoningMode(reasoningMode),
					chatId,
					// Forward the optional AgentConversation
					// ID so `directChatWorkflow` can append a persistent
					// operation-result system message at its completion
					// boundary (see workflow Step 6 / failure-path Step 6).
					// `conversationId` is already in the route's zod schema
					// (top of this file) and destructured above; this is the
					// final hand-off into the workflow input.
					conversationId: conversationId ?? undefined,
					attachedDocumentIds,
					// Additive to the retrieval path above, never a replacement:
					// the same files are still chunked and searched, and that is
					// what covers a file the character budget had to cut.
					inlineAttachmentContexts,
					workspaceIds,
					workspaceDocumentIds,
					projectId,
					enabledMcpConfigIds: effectiveEnabledMcpConfigIds,
					enabledFabricToolIds,
					systemPrompt,
					modelOverride,
				};

				// Start the workflow.
				// `memo` carries tenant context that the cancel route reads for
				// ownership verification (`memo.userId`, `memo.organizationId`).
				// Without it, any authenticated user knowing a `direct-chat-*`
				// id could cancel another tenant's workflow.
				const handle = await temporalClient.workflow.start(
					"directChatWorkflow",
					{
						taskQueue: "fabric-worker",
						workflowId: executionId,
						args: [workflowInput],
						memo: {
							userId,
							organizationId: organizationId ?? null,
						},
						// Fizzy #1412 PR2 (Codex review round-3 fix #3):
						// Make the "no-workflow-retry" contract EXPLICIT.
						// The workflow's Step 6 failure path uses an
						// `isTerminal` guard (see
						// `packages/temporal/src/workflows/direct-chat.ts`
						// catch block) that classifies `ApplicationFailure`
						// with `nonRetryable === true` as terminal. That
						// classification is only sound while the workflow
						// itself does NOT retry — otherwise an exhausted-
						// retry `ActivityFailure` whose underlying
						// `ApplicationFailure.cause` is retryable would be
						// misclassified, post a "failure" chat row, and
						// then become impossible to overwrite on the
						// retry's success (PR1's `operationKey` dedup).
						// Locking `maximumAttempts: 1` here documents
						// today's behaviour and prevents a future default
						// change from silently reintroducing the stale-
						// failure-message regression class.
						retry: { maximumAttempts: 1 },
					},
				);

				console.log(
					`[Fabric AI Stream] Started Temporal workflow: ${handle.workflowId}`,
				);

				// Send started event
				sendEvent({ type: "started", executionId });

				// Track state for change detection
				let lastPhase = "";
				let isComplete = false;
				const startTime = Date.now();
				let lastHeartbeatAt = Date.now();

				// Poll for progress updates
				while (
					!isComplete &&
					!isClosed &&
					Date.now() - startTime < MAX_POLL_DURATION
				) {
					try {
						if (
							Date.now() - lastHeartbeatAt >=
							HEARTBEAT_INTERVAL
						) {
							lastHeartbeatAt = Date.now();
							if (!isClosed) {
								try {
									controller.enqueue(
										encoder.encode(": ping\n\n"),
									);
								} catch {
									isClosed = true;
								}
							}
						}

						const description = await handle.describe();

						if (description.status.name === "COMPLETED") {
							// Get final result
							const result: DirectChatWorkflowOutput =
								await handle.result();

							if (!result.success) {
								sendEvent({
									type: "error",
									message: result.error || "Workflow failed",
								});
								isComplete = true;
								break;
							}

							if (result.toolCalls) {
								for (const toolCall of result.toolCalls) {
									emitToolCallDelta({
										id: toolCall.id,
										name: toolCall.name,
										serverName: toolCall.serverName,
										args: toolCall.args,
										result: toolCall.result,
										status: toolCall.status,
										error: toolCall.error,
										mcpAppResourceUri:
											toolCall.mcpAppResourceUri,
										mcpAppConfigId: toolCall.mcpAppConfigId,
									});
								}
							}

							emitResponseDelta(result.responseText);
							emitReasoningDelta(result.reasoningText);
							if (result.reasoningDurationMs !== undefined) {
								sendEvent({
									type: "reasoningDuration",
									durationMs: result.reasoningDurationMs,
								});
							}

							// Send pending confirmation if any
							if (result.pendingConfirmation) {
								sendEvent({
									type: "confirmation_required",
									...result.pendingConfirmation,
								});
							}

							// Send sources if RAG was used
							if (result.sources && result.sources.length > 0) {
								sendEvent({
									type: "sources",
									sources: result.sources,
								});
							}

							// Send completion event with token usage
							sendEvent({
								type: "done",
								durationMs: result.durationMs,
								usage: result.usage,
							});

							isComplete = true;
						} else if (description.status.name === "FAILED") {
							try {
								// A FAILED workflow's result() always throws,
								// carrying the underlying cause. Guard the extra
								// round-trip with a timeout so a degraded
								// Temporal cluster can't stall the SSE stream.
								await Promise.race([
									handle.result(),
									new Promise((_, reject) =>
										setTimeout(
											() =>
												reject(
													new Error(
														"Workflow execution failed",
													),
												),
											3000,
										),
									),
								]);
							} catch (failure) {
								sendEvent(buildWorkflowErrorEvent(failure));
							}
							isComplete = true;
						} else if (description.status.name === "CANCELLED") {
							sendEvent({
								type: "error",
								message: "Workflow was cancelled",
							});
							isComplete = true;
						} else {
							// First, check for activity heartbeat details (real-time tool calls)
							// This provides real-time updates during activity execution
							const pendingActivities =
								(description as any).raw?.pendingActivities ||
								[];
							for (const activity of pendingActivities) {
								const heartbeatDetails =
									activity.heartbeatDetails;
								// Widened from `heartbeatDetails?.toolCalls`: phase
								// updates and partial assistant text also arrive on
								// heartbeats that carry no tool calls, so process any
								// heartbeat with details (the tool-call loop below is
								// null-safe).
								if (heartbeatDetails) {
									// Extract tool calls from heartbeat
									const hbToolCalls =
										heartbeatDetails.toolCalls as Array<{
											id: string;
											name: string;
											serverName?: string;
											status: string;
											args?: Record<string, unknown>;
											result?: unknown;
											mcpAppResourceUri?: string;
											mcpAppConfigId?: string;
										}>;

									for (const toolCall of hbToolCalls ?? []) {
										emitToolCallDelta(toolCall);
									}

									// Send progress update from heartbeat
									if (
										heartbeatDetails.phase &&
										heartbeatDetails.phase !== lastPhase
									) {
										lastPhase = heartbeatDetails.phase;
										sendEvent({
											type: "progress",
											phase: heartbeatDetails.phase,
											message:
												heartbeatDetails.message ||
												"Processing...",
											progress:
												heartbeatDetails.progress || 0,
										});
									}

									emitResponseDelta(
										heartbeatDetails.responseText,
									);
									emitReasoningDelta(
										heartbeatDetails.reasoningText,
									);
								}
							}

							// Fallback: Query workflow progress (for phase updates from workflow)
							try {
								const progress: DirectChatProgressUpdate =
									await handle.query("directChatProgress");

								// Send phase change events (if not already sent from heartbeat)
								if (
									progress?.phase &&
									progress.phase !== lastPhase
								) {
									lastPhase = progress.phase;
									sendEvent({
										type: "progress",
										phase: progress.phase,
										message: progress.message,
										progress: progress.progress,
										currentActivity:
											progress.currentActivity,
									});
								}

								if (progress?.toolCalls) {
									for (const toolCall of progress.toolCalls) {
										emitToolCallDelta({
											id: toolCall.id,
											name: toolCall.name,
											serverName: toolCall.serverName,
											args: toolCall.args,
											result: toolCall.result,
											status: toolCall.status,
											error: toolCall.error,
											mcpAppResourceUri:
												toolCall.mcpAppResourceUri,
											mcpAppConfigId:
												toolCall.mcpAppConfigId,
										});
									}
								}

								emitResponseDelta(progress?.responseText);
								emitReasoningDelta(progress?.reasoningText);
							} catch (queryError) {
								// Query might fail if workflow hasn't set up handlers yet
								console.debug(
									"[Fabric AI Stream] Progress query not ready:",
									queryError,
								);
							}

							// Wait before next poll
							await new Promise((resolve) =>
								setTimeout(resolve, POLL_INTERVAL),
							);
						}
					} catch (pollError) {
						console.error(
							"[Fabric AI Stream] Poll error:",
							pollError,
						);
						// Continue polling unless it's a fatal error
						await new Promise((resolve) =>
							setTimeout(resolve, POLL_INTERVAL),
						);
					}
				}

				// Handle timeout
				if (!isComplete && !isClosed) {
					sendEvent({
						type: "error",
						message: "Workflow timed out",
					});
				}

				if (!isClosed) {
					isClosed = true;
					controller.close();
				}
			} catch (error) {
				console.error(
					"[Fabric AI Stream] Temporal workflow error:",
					error,
				);
				if (!isClosed) {
					sendEvent(buildWorkflowErrorEvent(error));
					isClosed = true;
					controller.close();
				}
			}
		},
		cancel() {
			// Called when the client disconnects
			isClosed = true;
			console.log(
				"[Fabric AI Stream] Client disconnected, stream cancelled",
			);
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		},
	});
}

export const runtime = "nodejs";

// The Temporal poll loop above allows up to MAX_POLL_DURATION (300s) before
// giving up and sending a graceful "Workflow timed out" event. 360s leaves
// ~60s of headroom so that event is delivered and the stream closed before
// Vercel's platform-level hard kill can cut it off mid-stream (issue #2269).
// This does NOT extend the 300s run window itself — a workflow still has
// only 300s to finish before the graceful timeout fires.
export const maxDuration = 360;
