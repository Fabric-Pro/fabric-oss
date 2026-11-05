import { ORPCError } from "@orpc/client";
import {
	PROMPT_WORKBENCH_MAX_BYTES,
	promptAssistInput,
	promptResponseReadInput,
	promptResponseUpdateInput,
	promptTryInput,
} from "@repo/ai/lib/prompt-workbench-contracts";
import type { FabricToolDefinition } from "@repo/temporal/fabric-tool-definition";
import { z } from "zod";
import { errorResult, jsonResult } from "../tool-results";
import { type PlatformToolHandler, toolFamily } from "./tool-family";
export function createPromptWorkbenchTools() {
	const definitions: FabricToolDefinition[] = [];
	const handlers = new Map<string, PlatformToolHandler>();
	for (const [name, scope, schema] of [
		["fabric_assist_prompt", "prompts:write", promptAssistInput],
		["fabric_preview_prompt", "prompts:read", promptTryInput],
		["fabric_get_prompt_response", "prompts:read", promptResponseReadInput],
		[
			"fabric_update_prompt_response",
			"prompts:write",
			promptResponseUpdateInput,
		],
	] as const) {
		const { $schema: _, ...inputSchema } = z.toJSONSchema(schema);
		definitions.push({
			name,
			scope,
			inputSchema,
			description:
				name === "fabric_get_prompt_response"
					? "Read the expected response contract for a visible prompt in the current organization."
					: name === "fabric_update_prompt_response"
						? "Save an expected response contract as a new prompt version. Requires current editing authority; does not change instructions or start work."
						: name === "fabric_assist_prompt"
							? "Ask the configured AI provider for prompt changes. Review the proposal; never saves, binds or publishes."
							: "Try supplied prompt text and variable values with the configured AI provider. No document lookup, tools, bindings or saved evaluation. Returns actual output and rendered input.",
			annotations: {
				readOnlyHint: name !== "fabric_update_prompt_response",
				destructiveHint: false,
				idempotentHint: false,
			},
			...(name === "fabric_get_prompt_response"
				? {}
				: { confirm: "always" as const }),
		});
		handlers.set(name, async (args, session) => {
			if (
				!session.organizationId ||
				session.projectId ||
				session.pinnedProjectId ||
				session.pageProjectId ||
				session.credential === "service"
			) {
				return errorResult(
					"A current member organization connection is required.",
					{ code: "FORBIDDEN" },
				);
			}
			if (
				session.credential !== "session" &&
				!session.scopes.includes(scope) &&
				!session.scopes.includes("*")
			) {
				return errorResult(
					`This prompt action requires explicit ${scope} scope.`,
					{ code: "INSUFFICIENT_SCOPE" },
				);
			}
			if (
				new TextEncoder().encode(JSON.stringify(args)).byteLength >
				PROMPT_WORKBENCH_MAX_BYTES
			) {
				return errorResult("The prompt request exceeds 512 KiB.", {
					code: "BAD_REQUEST",
				});
			}
			const parsed = schema.safeParse(args);
			if (!parsed.success) {
				return errorResult(
					"Use the declared prompt request schema. Actor and organization overrides are not accepted.",
					{ code: "BAD_REQUEST" },
				);
			}
			try {
				const {
					assistPrompt,
					tryPrompt,
					getPromptResponse,
					updatePromptResponse,
				} = await import("@repo/api/modules/prompts/lib/workbench");
				return jsonResult(
					await (name === "fabric_assist_prompt"
						? assistPrompt
						: name === "fabric_get_prompt_response"
							? getPromptResponse
							: name === "fabric_update_prompt_response"
								? updatePromptResponse
								: tryPrompt)(
						{
							userId: session.userId,
							organizationId: session.organizationId,
						},
						parsed.data,
					),
				);
			} catch (error) {
				return error instanceof ORPCError
					? errorResult(error.message, { code: error.code })
					: errorResult(
							"The prompt request could not finish. Nothing was saved.",
							{ code: "SERVICE_UNAVAILABLE" },
						);
			}
		});
	}
	return toolFamily(definitions, handlers);
}
