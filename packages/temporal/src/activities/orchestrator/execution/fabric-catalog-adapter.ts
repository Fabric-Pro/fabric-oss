/**
 * Runs a Fabric AI catalog tool the chat loop found through `search_tools`.
 *
 * The tool index lists the Fabric AI catalog under the virtual config id
 * `fabric-ai-server`, so a model that discovers one of them calls it with that
 * id. Only part of the catalog is executed in-process by `executeMcpTool`'s
 * `fabric_` switch or by the iterative loop itself; the rest used to fall
 * through to a strict MCP lookup of a config that does not exist and came back
 * "MCP configuration not found". This module executes that remainder with the
 * implementations other surfaces already use: Direct chat's tool builders where
 * one exists, else the plan-mode step handler for the tool, and for the
 * workflow tools the Fabric MCP gateway, called as the acting user exactly as
 * Direct chat and external coding agents call it.
 */

import { rethrowIfDispatchStopped } from "@repo/utils/dispatch-guard";
import { gatewayCallNeedsConfirmation } from "../../../lib/fabric-gateway-tools";
import { COMPANY_CONTEXT_SEARCH_TOOL_NAME } from "../../../workflows/orchestrator/company-context-tool-schemas";
import {
	FABRIC_CATALOG_DIRECT_BUILDER_ACCESS as DIRECT_BUILDER_TOOLS,
	FABRIC_CATALOG_GATEWAY_ACCESS as GATEWAY_TOOLS,
	FABRIC_CATALOG_STEP_HANDLER_ACCESS as STEP_HANDLER_TOOLS,
} from "../../../workflows/orchestrator/fabric-catalog-access";
import type { ExecuteStepInput, ExecuteStepOutput } from "../types";
import { describeError } from "./describe-error";
import type { StepHandler } from "./handlers/types";

export { FABRIC_AI_SERVER_CONFIG_ID } from "../../../workflows/orchestrator/fabric-catalog-access";

type AccessLevel = "READ" | "WRITE";

/**
 * Who a WRITE must be approved against. Vendor tools write to a third-party
 * service with the user's integration credentials, so they are gated as that
 * integration; the rest act on Fabric itself.
 */
type FabricCatalogAuthority =
	| { kind: "fabric" }
	| {
			kind: "integration";
			provider: string;
			providerDisplayName: string;
			operation: string;
	  };

interface CatalogRoute {
	executor: "direct-builder" | "step-handler" | "gateway";
	access: AccessLevel;
}

const VENDORS: Record<string, { provider: string; displayName: string }> = {
	asana: { provider: "ASANA", displayName: "Asana" },
	attio: { provider: "ATTIO", displayName: "Attio" },
	front: { provider: "FRONT", displayName: "Front" },
	canva: { provider: "CANVA", displayName: "Canva" },
};

/** How the adapter runs `toolName`, or undefined when it cannot. */
export function resolveFabricCatalogRoute(
	toolName: string,
): CatalogRoute | undefined {
	if (Object.hasOwn(DIRECT_BUILDER_TOOLS, toolName)) {
		return {
			executor: "direct-builder",
			access: DIRECT_BUILDER_TOOLS[toolName],
		};
	}
	if (Object.hasOwn(STEP_HANDLER_TOOLS, toolName)) {
		return {
			executor: "step-handler",
			access: STEP_HANDLER_TOOLS[toolName],
		};
	}
	if (Object.hasOwn(GATEWAY_TOOLS, toolName)) {
		return { executor: "gateway", access: GATEWAY_TOOLS[toolName] };
	}
	return undefined;
}

/**
 * What the person is asked before this call runs:
 * - `none`: nothing. A read, a write the tool's own definition says needs no
 *   yes (a frame write that gives the page no tools), and a `dryRun`, which
 *   writes nothing, so the approval is asked for the real call once the person
 *   has seen the draft.
 * - `every-call`: the tool's definition asks for this call (`confirm`): a
 *   one-shot approval of exactly this tool and these arguments.
 * - `conversation`: a Fabric write that predates the definitions: approval for
 *   that one tool, for the conversation.
 *
 * The same `callNeedsConfirmation` answer Direct chat reads, so a tool asks
 * the same in both engines.
 */
export type CatalogApproval = "none" | "every-call" | "conversation";

export function resolveCatalogApproval(
	toolName: string,
	args: Record<string, unknown>,
): CatalogApproval {
	const route = resolveFabricCatalogRoute(toolName);
	if (!route || route.access === "READ") {
		return "none";
	}
	if (route.executor !== "gateway") {
		return "conversation";
	}
	return gatewayCallNeedsConfirmation(toolName, args) ? "every-call" : "none";
}

export function fabricCatalogAuthority(
	toolName: string,
): FabricCatalogAuthority {
	const vendorMatch = toolName.match(/^fabric_([a-z]+)_(.+)$/);
	const vendor = vendorMatch ? VENDORS[vendorMatch[1]] : undefined;
	if (vendor && vendorMatch) {
		return {
			kind: "integration",
			provider: vendor.provider,
			providerDisplayName: vendor.displayName,
			operation: vendorMatch[2],
		};
	}
	return { kind: "fabric" };
}

interface FabricCatalogCall {
	toolName: string;
	args: Record<string, unknown>;
	userId: string;
	organizationId?: string;
	projectId?: string;
	attachedImageUrls?: string[];
	/** The Advisor's company-context opt-in; see `ExecuteMcpToolInput`. */
	companyContextAdvisor?: boolean;
	/** The chat and the run the call belongs to, for the gateway's acting context. */
	conversationId?: string;
	executionId?: string;
	/** The acting grant the turn's web route minted; see `ExecuteMcpToolInput`. */
	actingGrant?: string;
	/** The page the chat was opened from, so a new page lands where the user is. */
	launchWorkspaceId?: string;
	launchSurface?: "artifact" | "workspace";
}

type FabricCatalogResult =
	| { success: true; output: unknown }
	| { success: false; error: string };

/**
 * Execute a catalog tool. Authority and Read-only mode are the caller's job;
 * this only runs the tool and reports a failure as a string.
 */
export async function runFabricCatalogTool(
	call: FabricCatalogCall,
): Promise<FabricCatalogResult> {
	const route = resolveFabricCatalogRoute(call.toolName);
	if (!route) {
		return {
			success: false,
			error: `Fabric tool "${call.toolName}" is not available in chat.`,
		};
	}
	try {
		switch (route.executor) {
			case "direct-builder":
				return await runDirectBuilderTool(call);
			case "step-handler":
				return await runStepHandlerTool(call);
			case "gateway":
				return await runGatewayTool(call);
			default: {
				const unreachable: never = route.executor;
				return unreachable;
			}
		}
	} catch (error) {
		// A turn stop or a token-allowance refusal is not a tool failure for
		// the model to work around: it leaves the activity as itself.
		rethrowIfDispatchStopped(error);
		return { success: false, error: describeError(error) };
	}
}

async function runDirectBuilderTool(
	call: FabricCatalogCall,
): Promise<FabricCatalogResult> {
	const { createCodeSearchTool, createFabricTool } = await import(
		"../../direct-chat/built-in-tools"
	);
	const context = {
		usageConversationId: call.conversationId,
		userId: call.userId,
		organizationId: call.organizationId,
		projectId: call.projectId,
		companyContextAdvisor: call.companyContextAdvisor,
	};
	// The catalog also runs code_tree and code_file_get, so code_search
	// can point the model at them when its index is unavailable.
	const tools =
		call.toolName === "code_search"
			? await createCodeSearchTool({
					...context,
					liveRepositoryReads: true,
				})
			: await createFabricTool(call.toolName, context);
	const built = tools[call.toolName] as
		| {
				execute?: (
					args: Record<string, unknown>,
					options: { toolCallId: string; messages: unknown[] },
				) => Promise<unknown>;
		  }
		| undefined;
	if (!built?.execute) {
		// The company context search needs no project; without the Advisor's
		// opt-in it is simply not this chat's to run.
		if (call.toolName === COMPANY_CONTEXT_SEARCH_TOOL_NAME) {
			return {
				success: false,
				error: `Fabric tool "${call.toolName}" is not available in this chat.`,
			};
		}
		return {
			success: false,
			error: call.projectId
				? `Fabric tool "${call.toolName}" could not be prepared.`
				: `"${call.toolName}" needs a project. Attach a project to this chat and try again.`,
		};
	}

	const output = await built.execute(call.args, {
		toolCallId: `${call.toolName}-${Date.now()}`,
		messages: [],
	});
	return classifyBuilderOutput(output);
}

/**
 * A workflow or frame tool, called on the Fabric MCP gateway as the acting
 * user. The person's approval, where the tool's definition asks for one, was
 * taken before this runs (the runtime authority round in
 * `executeFabricCatalogTool`), so the call goes straight through; the gateway
 * still checks the acting grant, the user's membership and permissions.
 */
async function runGatewayTool(
	call: FabricCatalogCall,
): Promise<FabricCatalogResult> {
	if (!call.organizationId) {
		return {
			success: false,
			error: `"${call.toolName}" needs an organization. Open this chat from an organization and try again.`,
		};
	}
	if (!call.actingGrant) {
		return {
			success: false,
			error: `"${call.toolName}" was not run: this turn carries no proof it acts for the user. Ask them to send their message again.`,
		};
	}
	const { loadFabricPlatformTools } = await import(
		"../../shared/fabric-platform-mcp"
	);
	const platform = await loadFabricPlatformTools({
		userId: call.userId,
		organizationId: call.organizationId,
		actingGrant: call.actingGrant,
		projectId: call.projectId,
		workspaceId: call.launchWorkspaceId,
		surface: call.launchSurface,
		conversationId: call.conversationId,
		sourceRunType: call.executionId ? "orchestrator" : undefined,
		sourceRunId: call.executionId,
	});
	if (!platform) {
		return {
			success: false,
			error: `Fabric's tools are unavailable right now, so "${call.toolName}" was not run. Try again shortly.`,
		};
	}
	try {
		return classifyBuilderOutput(
			await platform.callAuthorized(call.toolName, call.args),
		);
	} finally {
		await platform.close();
	}
}

/**
 * Direct's builders report a failure as a returned value, not a throw:
 * `{ error }` from most, `{ success: false, message }` from code search.
 */
function classifyBuilderOutput(output: unknown): FabricCatalogResult {
	if (output && typeof output === "object") {
		const record = output as Record<string, unknown>;
		if (record.error !== undefined && record.error !== null) {
			return { success: false, error: describeError(record.error) };
		}
		if (record.success === false) {
			return { success: false, error: describeError(output) };
		}
	}
	return { success: true, output };
}

async function loadStepHandler(toolName: string): Promise<StepHandler> {
	if (toolName === "weave_query") {
		const { WeaveQueryHandler } = await import(
			"./handlers/weave-query-handler"
		);
		return new WeaveQueryHandler();
	}
	if (toolName.startsWith("code_")) {
		const { CodeSearchHandler } = await import(
			"./handlers/code-search-handler"
		);
		return new CodeSearchHandler();
	}
	if (toolName === "fabric_list_architecture_decisions") {
		const { ArchitectureDecisionsHandler } = await import(
			"./handlers/architecture-decisions-handler"
		);
		return new ArchitectureDecisionsHandler();
	}
	if (toolName === "fabric_list_feature_decisions") {
		const { FeatureDecisionsHandler } = await import(
			"./handlers/feature-decisions-handler"
		);
		return new FeatureDecisionsHandler();
	}
	if (toolName === "fabric_list_security_findings") {
		const { SecurityFindingsHandler } = await import(
			"./handlers/security-findings-handler"
		);
		return new SecurityFindingsHandler();
	}
	const { FabricAiHandler } = await import("./handlers/fabric-ai-handler");
	return new FabricAiHandler();
}

async function runStepHandlerTool(
	call: FabricCatalogCall,
): Promise<FabricCatalogResult> {
	const handler = await loadStepHandler(call.toolName);
	// A one-step "plan" carrying the tool call. No executionId: the handlers
	// publish plan-step progress events keyed on it, and this call is a chat
	// tool call that the loop already reports.
	const input: ExecuteStepInput = {
		step: {
			id: `chat-${call.toolName}`,
			description: `Run ${call.toolName}`,
			type: "api",
			status: "in_progress",
			order: 1,
			app: call.toolName,
			executor: call.toolName,
			inputs: call.args,
		},
		message: "",
		systemPrompt: "",
		variables: {},
		userId: call.userId,
		organizationId: call.organizationId,
		projectId: call.projectId,
		// The chat the call belongs to, so a handler's model calls are
		// recorded against it. A real conversation only: `call.conversationId`
		// is the workflow input's, never the run ID.
		...(call.conversationId ? { conversationId: call.conversationId } : {}),
		attachedImageUrls: call.attachedImageUrls,
		executionMode: "iterative",
		totalSteps: 1,
		stepIndex: 1,
		previousStepResults: [],
	};

	const result = await handler.execute({
		input,
		variables: {},
		toolCalls: [],
		startTime: Date.now(),
	});
	if (!result.handled || !result.output) {
		return {
			success: false,
			error: result.error ?? `Fabric tool "${call.toolName}" failed.`,
		};
	}
	return classifyStepOutput(result.output);
}

function classifyStepOutput(output: ExecuteStepOutput): FabricCatalogResult {
	const lastCall = output.toolCalls?.at(-1);
	if (output.status === "failed" || lastCall?.status === "error") {
		return {
			success: false,
			error: describeError(lastCall?.result ?? output.response),
		};
	}
	if (typeof output.response === "string" && output.response) {
		return { success: true, output: output.response };
	}
	return { success: true, output: lastCall?.result ?? output.outputs ?? {} };
}
