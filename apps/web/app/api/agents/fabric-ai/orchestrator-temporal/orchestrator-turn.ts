/**
 * What an Orchestrator chat turn passes before its workflow starts: the hand
 * parser and its bounds, the organization tie, conversation, workspace and
 * project access, the usage frame, the carried-over history, the plan
 * preflight and usage-limit chokepoint, and the workflow input itself. A
 * refusal comes back as the Response the stream route sends.
 *
 * Shared by the stream route (`stream/route.ts`) and the agent runtime's
 * Orchestrator engine (`modules/saas/agents/runtime`), so both admit, bill and
 * build a turn the same way. The steps stay in the order the route runs them:
 * request → admission (the caller's) → workspace filter → billing → input.
 */

import { getDefaultEnabledMcpConfigIds } from "@repo/agent-core/backend";
import { getAIModelWithMetadata } from "@repo/ai";
import {
	chatGptPlanExhaustedChatResponse,
	chatGptPlanReconnectRefusal,
} from "@repo/ai/lib/chatgpt-plan/agent-config";
import {
	type ChatGptPlanChatPreflight,
	chatGptPlanChatPreflight,
} from "@repo/ai/lib/chatgpt-plan/plan-spent-response";
import { mintActingGrantForTurn } from "@repo/api/lib/agent-service-auth";
import { db } from "@repo/database";
import { AiUsageLimitExceededError } from "@repo/payments";
import type {
	getTemporalClient,
	OrchestratorWorkflowInput,
	RagContextRetrievalInput,
} from "@repo/temporal";
import { PROJECT_REPOSITORY_TOOLS } from "@repo/temporal/project-repository-tool-schemas";
import type { getSession } from "@saas/auth/lib/server";
import { v4 as uuidv4 } from "uuid";
import { seedCarriedOverHistory } from "../carried-over-context";
import { assertChatWorkflowPayload } from "../chat-workflow-payload";
import {
	EXECUTION_MODE_NAMES,
	parseExecutionMode,
} from "../orchestrator-execution-mode";
import { resolveUsageFrame } from "../resolve-usage-frame";
import { windowUntypedHistory } from "../stream/history-window";
import { unionDefaultMcpConfigIds } from "../union-default-mcp-config-ids";
import {
	budgetContinuationSeed,
	InvalidBudgetContinuationError,
} from "./budget-continuation";
import { resolveRequestTenant } from "./stream/resolve-request-tenant";
import {
	executionModeUsesTurns,
	resolveClientRequestKey,
	resolveTurnOrganization,
} from "./turn-admission";

/**
 * Bounds on inline attachment text, mirroring the zod limits the direct-chat
 * stream route declares. Kept as named constants so the two routes can be
 * compared without reading two different enforcement styles.
 */
const MAX_INLINE_ATTACHMENTS = 20;
const MAX_INLINE_ATTACHMENT_CHARS = 200_000;

// Bounds on the body's `workspaceIds`, matching `streamRequestSchema` in the
// direct-chat stream (`../stream/route.ts`).
const MAX_WORKSPACE_IDS = 20;
const MAX_WORKSPACE_ID_LENGTH = 200;

type Session = NonNullable<Awaited<ReturnType<typeof getSession>>>;
type TemporalClient = Awaited<ReturnType<typeof getTemporalClient>>;

/** The request body as `Request.json()` reads it: parsed by hand below. */
export type OrchestratorTurnBody = Awaited<ReturnType<Request["json"]>>;

function badRequest(message: string): Response {
	return new Response(
		JSON.stringify({ error: "Invalid request body", message }),
		{
			status: 400,
			headers: { "Content-Type": "application/json" },
		},
	);
}

/**
 * Parse and resolve one turn's request: the hand parser and its bounds, the
 * organization tie, the caller's conversation, the client key and budget
 * continuation, the workspaces (not yet filtered), the project, the usage
 * frame and the carried-over history. Reads nothing billed and starts
 * nothing.
 */
export async function resolveOrchestratorTurnRequest({
	session,
	body,
}: {
	session: Session;
	body: OrchestratorTurnBody;
}) {
	const userId = session.user.id;
	const {
		message,
		history: rawHistory,
		executionId: requestedExecutionId,
		organizationId: requestedOrganizationId,
		clientRequestKey: rawClientRequestKey,
		continueFromTurnId: rawContinueFromTurnId,
		executionMode: requestedExecutionMode = "balanced", // All modes now use iterative execution with mode-specific limits
		enabledMcpConfigIds = null,
		enabledAgentIds = null,
		enabledFabricToolIds = null,
		enabledIntegrationIds = null,
		prioritizedToolIds,
		prioritizedAgentIds,
		prioritizedMcpConfigIds,
		prioritizedIntegrationIds,
		policyContext,
		replayTrajectoryId,
		workspaceIds: rawWorkspaceIds,
		projectId: rawProjectId,
		conversationId: requestedConversationId,
		systemPrompt,
		instanceId,
		chatId,
		attachedDocumentIds = [],
		inlineAttachmentContexts = [],
		attachedImageUrls = [],
		modelOverride,
		surface,
		organizationSlug,
		advisorOrigin,
		launchWorkspaceId: rawLaunchWorkspaceId,
		launchFrameId,
		launchSurface: rawLaunchSurface,
	} = body;

	// Where the chat was opened, for the tools that place what they create:
	// a default, never a grant (the gateway checks access to whatever a
	// tool touches). The body is parsed by hand, so only a string id and
	// one of the two surface names count.
	const launchWorkspaceId: string | undefined =
		typeof rawLaunchWorkspaceId === "string" &&
		rawLaunchWorkspaceId.length > 0 &&
		rawLaunchWorkspaceId.length <= 200
			? rawLaunchWorkspaceId
			: undefined;
	const launchSurface: "artifact" | "workspace" | undefined =
		rawLaunchSurface === "artifact" || rawLaunchSurface === "workspace"
			? rawLaunchSurface
			: undefined;

	// The body is parsed by hand, so these ids are whatever JSON the
	// client sent. Both reach the membership check and the tenant filters
	// below, where an object would read as a Prisma filter
	// (`{ not: "" }` matches any membership the caller has). Absent
	// (null or undefined) stays absent; any other value that is not a
	// string is refused before anything is read, as the direct-chat
	// stream's `z.string().nullish()` does.
	for (const [field, value] of [
		["organizationId", requestedOrganizationId],
		["projectId", rawProjectId],
	] as const) {
		if (
			value !== null &&
			value !== undefined &&
			typeof value !== "string"
		) {
			return badRequest(`${field} must be a string`);
		}
	}
	const providedProjectId: string | undefined = rawProjectId ?? undefined;

	// Bounded before it reaches the workflow input: the history went in
	// whole, with no size limit (review F38).
	const history = windowUntypedHistory(rawHistory);

	// The body is parsed by hand, so its workspace ids are whatever the
	// client sent. Keep only string entries; the access filter decides
	// which of those the turn may read.
	const providedWorkspaceIds: string[] = Array.isArray(rawWorkspaceIds)
		? rawWorkspaceIds.filter(
				(workspaceId: unknown): workspaceId is string =>
					typeof workspaceId === "string",
			)
		: [];
	// Same bounds the direct-chat stream's request schema puts on this
	// field. The access filter runs one lookup per id, so an unbounded
	// list would be a database fan-out any member could trigger.
	if (
		providedWorkspaceIds.length > MAX_WORKSPACE_IDS ||
		providedWorkspaceIds.some(
			(workspaceId) => workspaceId.length > MAX_WORKSPACE_ID_LENGTH,
		)
	) {
		return badRequest(
			`workspaceIds accepts at most ${MAX_WORKSPACE_IDS} ids of at most ${MAX_WORKSPACE_ID_LENGTH} characters`,
		);
	}

	const executionMode = parseExecutionMode(requestedExecutionMode);
	if (!executionMode) {
		return badRequest(
			`executionMode must be one of: ${EXECUTION_MODE_NAMES.join(", ")}`,
		);
	}

	// ✅ Security: the organization is the only tenant context
	// (ADR-018). It is required and resolved server-side — the body's,
	// else the session's active organization — and the caller must have
	// a tie to it. It used to be checked only when the body named one,
	// leaving the organization-less arm live for any caller that omitted
	// it.
	const resolvedOrganization = await resolveTurnOrganization({
		userId,
		requestedOrganizationId,
		session: session.session,
	});
	if (!resolvedOrganization.ok) {
		return resolvedOrganization.response;
	}
	const organizationId: string = resolvedOrganization.organizationId;

	// A conversation id is only a lookup key for the caller's own
	// conversations in this organization. Its attached workspaces and
	// project, its carried-over summary, and the runtime-authority grants
	// bound to it must not be reachable by sending another user's id. An
	// id the caller explicitly named but cannot access is refused (403)
	// rather than silently dropped: dropping it ran the turn detached
	// from the conversation the user was looking at.
	const conversationId: string | undefined =
		typeof requestedConversationId === "string" && requestedConversationId
			? requestedConversationId
			: undefined;
	if (conversationId) {
		const owned = await db.agentConversation.findFirst({
			where: { id: conversationId, userId, organizationId },
			select: { id: true },
		});
		if (!owned) {
			console.warn(
				"[Orchestrator Stream] Conversation is not accessible to the caller; refusing",
				{ userId, conversationId },
			);
			return new Response(
				JSON.stringify({
					error: "Forbidden",
					message: "This conversation is not accessible",
				}),
				{
					status: 403,
					headers: { "Content-Type": "application/json" },
				},
			);
		}
	}

	const clientRequestKey = resolveClientRequestKey(rawClientRequestKey);
	if (!clientRequestKey.ok) {
		return clientRequestKey.response;
	}

	const continueFromTurnId =
		rawContinueFromTurnId === undefined
			? undefined
			: typeof rawContinueFromTurnId === "string" &&
					rawContinueFromTurnId.length > 0 &&
					rawContinueFromTurnId.length <= 200
				? rawContinueFromTurnId
				: null;
	if (
		continueFromTurnId === null ||
		(continueFromTurnId &&
			(!conversationId ||
				requestedExecutionId ||
				!executionModeUsesTurns(executionMode)))
	) {
		return new InvalidBudgetContinuationError().response();
	}
	if (continueFromTurnId && conversationId) {
		try {
			await budgetContinuationSeed({
				turnId: continueFromTurnId,
				conversationId,
				userId,
				organizationId,
				clientRequestKey: clientRequestKey.key,
			});
		} catch (error) {
			if (error instanceof InvalidBudgetContinuationError) {
				return error.response();
			}
			throw error;
		}
	}

	// Debug: Log workspace IDs received
	console.log("[Orchestrator API] Received request context:", {
		providedWorkspaceIds,
		conversationId,
		providedProjectId,
	});
	console.log("[Orchestrator API] Received prioritization:", {
		prioritizedToolIds,
		prioritizedAgentIds,
		prioritizedMcpConfigIds,
	});
	// Fetch workspace IDs from database if not provided but conversation exists
	// This handles the race condition where frontend sends request before query returns
	let workspaceIds = providedWorkspaceIds;
	if (providedWorkspaceIds.length === 0 && conversationId) {
		console.log(
			"[Orchestrator API] Fetching attached workspaces for conversation:",
			{ conversationId },
		);
		const { getConversationWorkspaces } = await import("@repo/database");
		const attachedWorkspaces =
			await getConversationWorkspaces(conversationId);
		workspaceIds = attachedWorkspaces.map(
			(wc: { workspace: { id: string } }) => wc.workspace.id,
		);
		console.log(
			"[Orchestrator API] Fetched workspaceIds from DB:",
			workspaceIds,
		);
	}

	// Resolve project ID from conversation if not provided
	let projectId = providedProjectId;
	if (!projectId && conversationId) {
		try {
			const { getConversationProject } = await import("@repo/database");
			const conversationProject =
				await getConversationProject(conversationId);
			if (conversationProject?.project) {
				projectId = conversationProject.project.id;
				console.log(
					"[Orchestrator API] Resolved projectId from conversation:",
					projectId,
				);
			}
		} catch (err) {
			console.warn(
				"[Orchestrator API] Failed to resolve project from conversation:",
				err instanceof Error ? err.message : String(err),
			);
		}
	}

	// The project access check below admits an invited guest and ignores
	// the organization, so it cannot tell that a project belongs to a
	// different organization than the one this chat runs in. A project
	// outside the turn's organization is dropped here, whether it came
	// from the body or the conversation; every later read of `projectId`
	// sees the resolved value.
	({ projectId } = await resolveRequestTenant({
		userId,
		organizationId,
		projectId,
	}));

	// ✅ Security: Verify project access before forwarding to workflow
	if (projectId) {
		try {
			const { hasProjectAccess } = await import("@repo/database");
			const canAccess = await hasProjectAccess(
				projectId,
				userId,
				organizationId,
			);
			if (!canAccess) {
				console.warn(
					"[Orchestrator API] User does not have access to project:",
					{
						projectId,
					},
				);
				projectId = undefined; // Strip unauthorized projectId
			}
		} catch (err) {
			console.warn(
				"[Orchestrator API] Failed to verify project access:",
				err instanceof Error ? err.message : String(err),
			);
			projectId = undefined;
		}
	}

	const usageFrame = await resolveUsageFrame({
		launchFrameId,
		legacyLaunchFrameId: rawLaunchWorkspaceId,
		userId,
		userEmail: session.user.email,
		organizationId,
		projectId,
	});
	if (usageFrame.error) {
		return usageFrame.error;
	}

	// A continued chat starts from the text carried over from its parent,
	// quoted as data in a user-role message (see `carried-over-context`).
	const effectiveHistory = await seedCarriedOverHistory({
		history,
		conversationId,
		userId,
		organizationId,
	});

	if (!requestedExecutionId && !message) {
		return new Response(JSON.stringify({ error: "message is required" }), {
			status: 400,
			headers: { "Content-Type": "application/json" },
		});
	}
	if (
		requestedExecutionId &&
		(typeof requestedExecutionId !== "string" ||
			!/^orch-[a-f0-9-]{36}$/.test(requestedExecutionId))
	) {
		return new Response(
			JSON.stringify({ error: "Invalid executionId format" }),
			{
				status: 400,
				headers: { "Content-Type": "application/json" },
			},
		);
	}

	return {
		userId,
		organizationId,
		conversationId,
		clientRequestKey: clientRequestKey.key,
		continueFromTurnId,
		executionMode,
		message,
		requestedExecutionId,
		workspaceIds,
		projectId,
		usageFrame,
		effectiveHistory,
		enabledMcpConfigIds,
		enabledAgentIds,
		enabledFabricToolIds,
		enabledIntegrationIds,
		prioritizedToolIds,
		prioritizedAgentIds,
		prioritizedMcpConfigIds,
		prioritizedIntegrationIds,
		policyContext,
		replayTrajectoryId,
		systemPrompt,
		instanceId,
		chatId,
		attachedDocumentIds,
		inlineAttachmentContexts,
		attachedImageUrls,
		modelOverride,
		surface,
		organizationSlug,
		advisorOrigin,
		launchWorkspaceId,
		launchSurface,
	};
}

/** A turn request that passed `resolveOrchestratorTurnRequest`. */
export type OrchestratorTurnRequest = Exclude<
	Awaited<ReturnType<typeof resolveOrchestratorTurnRequest>>,
	Response
>;

/**
 * Workspace ids come from the client or from a conversation's attachments,
 * and every workspace retrieval path in the workflow reads whatever lands in
 * its input. Keep only the workspaces the caller can open inside the
 * organization this turn runs in, once membership of it is established.
 * Inaccessible ones are dropped (and logged) rather than failing the turn,
 * as the direct-chat stream does.
 */
export async function filterOrchestratorTurnWorkspaces({
	userId,
	organizationId,
	requestedWorkspaceIds,
}: {
	userId: string;
	organizationId: string;
	requestedWorkspaceIds: string[];
}): Promise<string[]> {
	let workspaceIds = requestedWorkspaceIds;
	if (workspaceIds.length > 0) {
		const { filterAccessibleWorkspaceIds } = await import("@repo/database");
		const filtered = await filterAccessibleWorkspaceIds({
			workspaceIds,
			userId,
			organizationId,
		});
		const { allowed, dropped: denied } = filtered;
		if (denied.length > 0) {
			console.warn(
				"[Orchestrator Stream] Dropping workspaces the caller cannot access",
				{ userId, denied },
			);
		}
		workspaceIds = allowed;
	}
	return workspaceIds;
}

/**
 * The plan preflight and the AI usage-limit chokepoint, entered only for a
 * NEW turn. A reconnect (an `executionId` body, or a retried key whose turn
 * already exists) skips it: that run already passed this chokepoint and was
 * counted when it started (issue #2269). Re-entering it would double-bill
 * the same run, and worse, could 429 the reconnect on a limit the run itself
 * pushed over — leaving a live Temporal workflow no client can attach to.
 * The workflow resolves its own model on the Temporal worker regardless.
 */
export async function billOrchestratorTurn({
	userId,
	organizationId,
}: {
	userId: string;
	organizationId: string;
}): Promise<Response | { planPreflight: ChatGptPlanChatPreflight }> {
	// Every ChatGPT plan serving the member's work is spent: refuse with
	// when it resets, rather than start a run that can only fail or quietly
	// bill the organization (Fizzy #2770). Under "Use API billing" the run
	// goes there and says so (Fizzy #3048).
	const planPreflight = await chatGptPlanChatPreflight({
		userId,
		organizationId,
	});
	if (planPreflight && "refusal" in planPreflight) {
		return planPreflight.refusal;
	}
	let aiModelResult: Awaited<ReturnType<typeof getAIModelWithMetadata>>;
	try {
		// See the note in fabric-ai/stream: the returned model is discarded
		// (only trackUsage is used), so a featureKey here would tag a call
		// that never happens.
		aiModelResult = await getAIModelWithMetadata(
			{ taskType: "TOOL_CALLING" },
			{ userId, organizationId, planEligible: true },
		);
	} catch (error) {
		// AI usage-limit chokepoint hit a HARD limit. Surface the structured
		// payload so the orchestrator client renders the shared destructive
		// toast instead of the generic "AI gateway missing" error card.
		// The member's plan is on here but needs reconnecting: refuse rather
		// than bill the organization (Fizzy #2939).
		const reconnect = chatGptPlanReconnectRefusal(error);
		if (reconnect) {
			return new Response(JSON.stringify(reconnect.body), {
				status: reconnect.status,
				headers: { "Content-Type": "application/json" },
			});
		}
		const exhausted = chatGptPlanExhaustedChatResponse(error);
		if (exhausted) {
			return exhausted;
		}
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
		console.error("[Orchestrator Stream] Failed to get AI model:", error);
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
	return { planPreflight };
}

/**
 * The workflow input for one turn: the message with its inline attachments
 * and retrieved document context (up to two minutes of RAG pre-work), the
 * effective MCP and Fabric tool sets, the acting grant and the usage frame.
 */
export async function buildOrchestratorWorkflowInput({
	request,
	workspaceIds,
	executionId,
	temporalClient,
}: {
	request: OrchestratorTurnRequest;
	/** The filtered workspaces (`filterOrchestratorTurnWorkspaces`). */
	workspaceIds: string[];
	executionId: string;
	temporalClient: TemporalClient;
}): Promise<OrchestratorWorkflowInput> {
	const {
		userId,
		organizationId,
		conversationId,
		executionMode,
		message,
		projectId,
		usageFrame,
		effectiveHistory,
		enabledMcpConfigIds,
		enabledAgentIds,
		enabledFabricToolIds,
		enabledIntegrationIds,
		prioritizedToolIds,
		prioritizedAgentIds,
		prioritizedMcpConfigIds,
		prioritizedIntegrationIds,
		policyContext,
		replayTrajectoryId,
		systemPrompt,
		instanceId,
		chatId,
		attachedDocumentIds,
		inlineAttachmentContexts,
		attachedImageUrls,
		modelOverride,
		surface,
		organizationSlug,
		advisorOrigin,
		launchWorkspaceId,
		launchSurface,
	} = request;

	let messageWithDocumentContext = message ?? "";

	// Files the user attached this turn, delivered whole.
	//
	// Additive to the retrieval below, not a replacement for it. Retrieval
	// returns the top five chunks above a similarity floor, so content
	// reaches the model only if embedding finished, the query matched
	// semantically, and the chunk ranked. Tab-joined spreadsheet rows embed
	// poorly, which makes that least reliable for exactly the format this
	// was built for. Inline gives completeness on a small file; retrieval
	// still covers the part a character budget had to cut.
	// The body is parsed by hand rather than through a zod schema, so the
	// bounds the sibling direct-chat route gets declaratively have to be
	// applied here. Count and per-entry length both: the client already
	// applies the character budget, and this is the server declining to take
	// its word for it.
	if (
		Array.isArray(inlineAttachmentContexts) &&
		inlineAttachmentContexts.length > 0
	) {
		const entries = inlineAttachmentContexts
			.filter(
				(entry: unknown): entry is string =>
					typeof entry === "string" &&
					entry.length > 0 &&
					entry.length <= MAX_INLINE_ATTACHMENT_CHARS,
			)
			.slice(0, MAX_INLINE_ATTACHMENTS);
		if (entries.length > 0) {
			messageWithDocumentContext = `${messageWithDocumentContext}\n\n${entries.join("\n\n")}`;
		}
	}

	if (
		chatId &&
		typeof message === "string" &&
		message.trim().length > 0 &&
		Array.isArray(attachedDocumentIds) &&
		attachedDocumentIds.length > 0
	) {
		try {
			const chatTenantFilter = organizationId
				? { id: chatId, userId, organizationId }
				: { id: chatId, userId, organizationId: null };
			const chat = await db.aiChat.findFirst({
				where: chatTenantFilter,
				select: { id: true, organizationId: true },
			});

			if (chat) {
				const workflowInput: RagContextRetrievalInput = {
					usageConversationId: conversationId,
					chatId: chat.id,
					userId,
					organizationId: chat.organizationId || undefined,
					query: message,
					topK: 5,
					minSimilarity: 0.5,
					documentIds: attachedDocumentIds,
				};
				const ragHandle = await temporalClient.workflow.start(
					"ragContextRetrievalWorkflow",
					{
						taskQueue: "document-processing",
						workflowId: `orchestrator-rag-${chat.id}-${Date.now()}-${uuidv4().slice(0, 8)}`,
						args: [workflowInput],
						workflowExecutionTimeout: "2m",
					},
				);
				const ragResult = await ragHandle.result();

				if (ragResult.success && ragResult.context) {
					// Append to what is already here rather than rebuilding from
					// `message`, which would drop the inline entries added
					// above — the same overwrite-instead-of-join shape that
					// discarded them inside the direct-chat workflow.
					messageWithDocumentContext = `${messageWithDocumentContext}\n\n${ragResult.context}`;
				}
			}
		} catch (error) {
			console.error(
				"[Orchestrator Stream] Failed to retrieve attached document context:",
				error,
			);
		}
	}

	// Union default-enabled MCP config ids into the caller-restricted set
	// so managed-default servers (e.g. Excalidraw, when `defaultEnabled`)
	// are eligible for eager-routing inside the orchestrator workflow.
	// On helper failure, log and proceed with the original array — the
	// workflow's defense-in-depth at `applyDefaultMcpEagerRouting`
	// still resolves via `findDefaultMcpConfigActivity`.
	//
	// `unionDefaultMcpConfigIds` guards the same three-state contract the
	// prioritized-ids union below already respects: `null` ("all configs
	// enabled") and `[]` ("explicitly none") pass through untouched, since
	// unioning into either would narrow it to the defaults alone.
	let effectiveEnabledMcpConfigIds: string[] | null = enabledMcpConfigIds;
	try {
		const defaultIds = await getDefaultEnabledMcpConfigIds(
			userId,
			organizationId,
		);
		effectiveEnabledMcpConfigIds = unionDefaultMcpConfigIds(
			enabledMcpConfigIds,
			defaultIds,
		);
	} catch (defaultIdsError) {
		console.warn(
			"[Orchestrator Stream] Failed to union default-enabled MCP config ids — proceeding with caller-supplied array",
			defaultIdsError,
		);
	}

	// Prioritizing implies enabling (issue #2182): the UI can star a
	// server without adding it to the conversation tool selection, which
	// leaves the planner biased toward tools the ToolIndex then excludes
	// as "config not enabled". Union the prioritized ids into the
	// effective set — but only when the caller restricted it: `null`
	// means "all configs enabled" and must stay null.
	if (
		Array.isArray(effectiveEnabledMcpConfigIds) &&
		Array.isArray(prioritizedMcpConfigIds) &&
		prioritizedMcpConfigIds.length > 0
	) {
		effectiveEnabledMcpConfigIds = Array.from(
			new Set([
				...effectiveEnabledMcpConfigIds,
				...prioritizedMcpConfigIds,
			]),
		);
	}

	// Fizzy #3216: the Advisor's toggle-built list omits repository reads.
	// Bind them as Direct does (Fizzy #2869) for Advisor turns, including
	// agents chosen there, with an accessible project. Callers without
	// advisorOrigin keep their configured list.
	const effectiveEnabledFabricToolIds =
		advisorOrigin === true &&
		projectId &&
		Array.isArray(enabledFabricToolIds) &&
		enabledFabricToolIds.length > 0
			? Array.from(
					new Set([
						...enabledFabricToolIds,
						...PROJECT_REPOSITORY_TOOLS.map((tool) => tool.name),
					]),
				)
			: enabledFabricToolIds;

	// Build workflow input
	// SECURITY: Credentials are NOT passed in workflow inputs
	// Activities fetch credentials internally to avoid storing them in Temporal history
	const workflowInput: OrchestratorWorkflowInput = {
		executionId,
		message: messageWithDocumentContext,
		history: effectiveHistory,
		userId,
		// A person typed this turn, so its AI steps may run on their own
		// ChatGPT plan where they turned it on (Fizzy #2939).
		planEligible: true,
		organizationId,
		executionMode,
		enabledMcpConfigIds: effectiveEnabledMcpConfigIds,
		enabledAgentIds,
		enabledFabricToolIds: effectiveEnabledFabricToolIds,
		enabledIntegrationIds,
		prioritizedToolIds,
		prioritizedAgentIds,
		prioritizedMcpConfigIds,
		prioritizedIntegrationIds,
		policyContext,
		replayTrajectoryId,
		workspaceIds,
		projectId,
		// Propagate the AgentConversation ID so the
		// completion phase's Step 6 (`postOperationResultActivity`) can
		// append a persistent operation-result system message. The
		// orchestrator already accepted this field for episodic memory
		// (Letta) on this surface (`workflow-io.types.ts:71`); PR2
		// merely starts forwarding it from the route layer too. When
		// `conversationId` is absent — e.g. a Nexus-CopilotPage caller
		// that hasn't been mapped to an `AgentConversation` yet — Step
		// 6 quietly no-ops (existing behaviour preserved).
		conversationId,
		systemPrompt,
		instanceId,
		attachedImageUrls:
			attachedImageUrls.length > 0 ? attachedImageUrls : undefined,
		// Forward the paperclip attachments so the agent loop can show
		// image-typed ones to vision-capable models as real pixels. The RAG
		// description (resolved above) still covers non-vision models.
		attachedDocumentIds:
			attachedDocumentIds.length > 0 ? attachedDocumentIds : undefined,
		modelOverride,
		surface,
		organizationSlug,
		// The workflow and frame tools come from Fabric MCP, which only lets
		// the agent runtime act for a person whose turn this route vouched
		// for: the grant is minted here, from the request this route
		// authenticated, and the workflow only carries it.
		actingGrant: mintActingGrantForTurn({
			userId,
			organizationId,
			conversationId,
		}),
		launchWorkspaceId,
		...usageFrame,
		launchSurface,
		// Only the Advisor (the Fabric AI page and the Fabric Agent drawer,
		// with or without a custom agent chosen there) sends
		// `advisorOrigin`; the MCP chat dialog, a registered agent's try
		// workspace and Nexus share this route and do not. It lets the turn
		// tell the model which organization it works for and search that
		// organization's company context; the workflow checks membership
		// and the feature gate itself (Fizzy #2719). The body is parsed by
		// hand, so only a literal `true` counts.
		...(advisorOrigin === true ? { companyContextAdvisor: true } : {}),
	};
	return workflowInput;
}

/**
 * A new run's input must fit Temporal's start frame. Refused here with a
 * message the user can act on, not by a gRPC error mid-stream (review F38).
 * A reattach starts nothing, so it is not measured.
 */
export function refuseOversizedOrchestratorInput(
	workflowInput: OrchestratorWorkflowInput,
): Response | null {
	try {
		assertChatWorkflowPayload(
			workflowInput,
			"orchestratorExecutionWorkflow start",
		);
		return null;
	} catch (payloadError) {
		return new Response(
			JSON.stringify({
				error:
					payloadError instanceof Error
						? payloadError.message
						: "Request too large",
			}),
			{
				status: 413,
				headers: { "Content-Type": "application/json" },
			},
		);
	}
}
