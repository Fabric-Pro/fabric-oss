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
 * one exists, else the plan-mode step handler for the tool.
 */

import {
	FABRIC_CATALOG_DIRECT_BUILDER_ACCESS as DIRECT_BUILDER_TOOLS,
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
	executor: "direct-builder" | "step-handler";
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
	if (toolName in DIRECT_BUILDER_TOOLS) {
		return {
			executor: "direct-builder",
			access: DIRECT_BUILDER_TOOLS[toolName],
		};
	}
	if (toolName in STEP_HANDLER_TOOLS) {
		return {
			executor: "step-handler",
			access: STEP_HANDLER_TOOLS[toolName],
		};
	}
	return undefined;
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
		return route.executor === "direct-builder"
			? await runDirectBuilderTool(call)
			: await runStepHandlerTool(call);
	} catch (error) {
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
		userId: call.userId,
		organizationId: call.organizationId,
		projectId: call.projectId,
	};
	const tools =
		call.toolName === "code_search"
			? await createCodeSearchTool(context)
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
