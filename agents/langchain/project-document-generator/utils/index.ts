/**
 * Project Document Generator Utils Module
 *
 * Constants and utility functions for project document generation.
 */

import type { BaseMessage } from "@langchain/core/messages";

// Deterministically stamp the active org id onto emitted <excalidraw-embed>
// tags so the saved diagram resolves its org-scoped MCP config on reload.
export { injectOrgIdIntoToolArgs } from "./excalidraw-embed-org-id";
// Export model factory functions
export {
	extractProviderConfig,
	getAgentModel,
	// Async version with API fallback (recommended for tenant context auth)
	getAgentModelAsync,
	type ProviderConfig,
	reasoningOutputAllowanceForConfig,
} from "./model-factory";
// apply_document_patches result reporting. Dependency-free submodule for the
// same vi.importActual reason as ./tool-rounds.
export {
	buildPatchToolResponseContent,
	buildReplaceAllFollowUpNote,
} from "./patch-response";
// Round counting for the per-turn research budget. Lives in its own
// dependency-free module so tests can vi.importActual the real
// implementation while this barrel (with its model-factory imports)
// stays fully mocked.
export { countToolRoundsSinceLastHuman } from "./tool-rounds";

/**
 * Maximum number of tool-calling rounds after the last human message before
 * the agent is forced to finalize. Prevents runaway search loops while
 * leaving headroom for legitimate long research runs.
 */
export const MAX_TOOL_ITERATIONS = 20;

/**
 * Maximum number of retries for standard errors.
 *
 * Set at 5 because patch-mode failures often need 3-4 corrective rounds for
 * the model to fully converge (anchor renaming + new-section detection +
 * sub-anchor cleanup take 3-4 iterations on cold runs). Empirically observed
 * an Active-Analysis run that was 1 retry away from succeeding when capped
 * at 3 — it had narrowed from 7 errors → 9 → 8 → 2 across four attempts.
 *
 * The destructive-output guards (markdown structure, content preservation)
 * protect against bad outcomes regardless of retry count, so the cost of
 * extra retries is API calls, not user-visible damage.
 */
export const MAX_RETRIES = 5;

/**
 * Default recursion limit for the graph.
 *
 * Each tool-calling round costs 2 LangGraph supersteps (chat_node +
 * tool_node), the finalize call after the last budgeted round costs 1 more,
 * and retries cost 1 superstep each (cumulative, up to MAX_RETRIES). This
 * must be >= 2 * MAX_TOOL_ITERATIONS + 1 + MAX_RETRIES, or LangGraph's hard
 * recursion limit fires before the graceful budget path (chat_node's
 * finalize mode, with shouldContinue's force-__end__ as backstop) ever gets
 * a chance to end the run gracefully. Getting this wrong crashed prod with
 * GraphRecursionError — the default limit (25) was lower than the supersteps
 * needed to reach the graceful guard.
 */
export const DEFAULT_RECURSION_LIMIT =
	2 * MAX_TOOL_ITERATIONS + MAX_RETRIES + 5;

/**
 * Maximum number of retries for JSON parse errors
 * Keep low to avoid excessive token consumption
 */
export const MAX_JSON_RETRIES = 3;

/**
 * Check if an error is a JSON parse error
 *
 * JSON parse errors get extra retry attempts.
 *
 * @param error - The error to check
 * @returns Whether it's a JSON parse error
 */
export function isJsonParseError(error: Error): boolean {
	const errorMsg = error.message;
	return (
		errorMsg.includes("Failed to parse tool call arguments as JSON") ||
		errorMsg.includes("Invalid JSON") ||
		errorMsg.includes("JSON parse error")
	);
}

/**
 * Check whether an error is a provider-side "prompt too long / context
 * length exceeded" failure. These are deterministic — retrying with the
 * same payload is guaranteed to fail and burns a full round-trip of
 * tokens each attempt.
 */
export function isContextLengthError(error: Error): boolean {
	const msg = error.message || "";
	if (/prompt is too long/i.test(msg)) {
		return true;
	}
	if (/context_length_exceeded/i.test(msg)) {
		return true;
	}
	if (/maximum context length/i.test(msg)) {
		return true;
	}
	// AI SDK / OpenAI-shape errors expose `code` on the object
	const code = (
		error as unknown as { code?: string; error?: { code?: string } }
	).code;
	if (code === "context_length_exceeded") {
		return true;
	}
	const nestedCode = (error as unknown as { error?: { code?: string } }).error
		?.code;
	if (nestedCode === "context_length_exceeded") {
		return true;
	}
	// 400 + "too long" variants from Vercel AI Gateway wrapping Anthropic
	const status = (error as unknown as { status?: number }).status;
	if (status === 400 && /too long|context/i.test(msg)) {
		return true;
	}
	return false;
}

/**
 * Check whether an error is a provider-side rejection of vision/multimodal
 * input — typically because the resolved model does not accept image_url
 * content parts (e.g., text-only models). Like context-length errors, this
 * is deterministic: retrying with the same payload will fail again.
 *
 * Patterns cover the major shapes we've observed in the wild:
 *   - Explicit capability messages: "does not support image/vision/multimodal"
 *   - LangChain/SDK-level rejections: "image_url is not supported"
 *   - Generic content-array rejections: "unsupported content ... image"
 *   - Anthropic Claude rejection: "Could not process image"
 *   - OpenAI / Azure OpenAI runtime rejection (observed in staging when a
 *     tenant has an Azure AI Foundry deployment named "gpt-4o" that points
 *     to a non-vision-capable underlying model):
 *     `"You uploaded an unsupported image. Please make sure your image is
 *      below 20 MB ... formats: ['png', 'jpeg', 'gif', 'webp']"`. Catch the
 *     stable parts ("uploaded an unsupported image",
 *     "make sure your image is valid", "your image must be") so retrying
 *     is short-circuited and the user sees `VISION_UNSUPPORTED_USER_MESSAGE`
 *     instead of the raw 400. The second pattern is anchored on
 *     "make sure your image is" (vision-call context), NOT just "image is
 *     (not )?valid", so it does NOT false-positive on generic upload-
 *     validation strings like "The uploaded image is not valid for this
 *     user story" — flagged by Codex review of PR #1140.
 */
export function isVisionUnsupportedError(error: Error): boolean {
	const msg = error.message || "";
	if (/does not support image/i.test(msg)) {
		return true;
	}
	if (/does not support vision/i.test(msg)) {
		return true;
	}
	if (/does not support multimodal/i.test(msg)) {
		return true;
	}
	if (/image_url is not supported/i.test(msg)) {
		return true;
	}
	if (/unsupported.*content.*image/i.test(msg)) {
		return true;
	}
	// Anthropic-style "Could not process image" / image-related errors
	if (/could not process image/i.test(msg)) {
		return true;
	}
	// OpenAI / Azure OpenAI generic rejection: "(You|We) uploaded an
	// unsupported image" or "(...) provided an unsupported image".
	if (/(uploaded|provided)\s+an\s+unsupported\s+image/i.test(msg)) {
		return true;
	}
	// "Please make sure your image is valid" — the trailing half of the
	// same OpenAI/Azure message, observed when Vercel AI Gateway truncates
	// the leading "(You|We) uploaded ..." clause. We anchor on
	// "make sure your image is" (vision context) rather than just
	// "image is (not )?valid" so we DON'T false-positive on generic
	// oRPC/upload validation strings like "The uploaded image is not valid
	// for this user story" (which should NOT short-circuit retries) — see
	// Codex review of PR #1140.
	if (/make\s+sure\s+your\s+image\s+is\s+(not\s+)?valid/i.test(msg)) {
		return true;
	}
	// "your image must be ..." — OpenAI's variant when the image fails
	// size / format / dimension preflight (e.g., "your image must be
	// below 20 MB", "your image must be one of the following formats").
	if (/your\s+image\s+must\s+be/i.test(msg)) {
		return true;
	}
	return false;
}

/**
 * Calculate retry delay with exponential backoff
 *
 * @param retryCount - Current retry count
 * @returns Delay in milliseconds (capped at 4000ms)
 */
export function calculateRetryDelay(retryCount: number): number {
	return Math.min(500 * 2 ** retryCount, 4000);
}

/**
 * Wait for the specified delay
 *
 * @param ms - Milliseconds to wait
 */
export async function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Per-message shape summary produced by {@link summarizeMessagesForLogging}. */
export interface RequestMessageShapeSummary {
	role: string;
	contentPartTypes: string[];
	toolCallId?: string;
	toolCallCount?: number;
	approxChars: number;
}

/**
 * Cheap, PII-safe summary of the message array about to be sent to the
 * model: role, content-part shape, tool_call_id pairing, and an approximate
 * per-message size. Never includes raw content — image data URLs and tool
 * output text can carry customer/ticket context.
 *
 * `approxChars` is a UTF-16 code-unit count of the serialized content, not a
 * byte count, and it excludes the rest of the request envelope. It is a
 * relative signal for spotting an outsized message, not a way to check a
 * payload against a provider's byte limit.
 *
 * Computed unconditionally right before every model invocation and stashed
 * in an outer-scoped variable so the catch block can log it on failure. A
 * provider schema-rejection 400 otherwise gives no diagnostic detail (an
 * empty response body carries nothing about which message/role/content-part
 * triggered it) — this is the one seam that still shows what was actually
 * sent.
 */
export function summarizeMessagesForLogging(
	messages: BaseMessage[],
): RequestMessageShapeSummary[] {
	return messages.map((msg) => {
		const role =
			(msg as { _getType?: () => string })._getType?.() ??
			(msg as { type?: string }).type ??
			"unknown";
		const content = (msg as { content?: unknown }).content;
		const contentPartTypes: string[] = Array.isArray(content)
			? content.map((part) =>
					part && typeof part === "object" && "type" in part
						? String((part as { type: unknown }).type)
						: typeof part,
				)
			: [typeof content];
		const toolCallId = (msg as { tool_call_id?: unknown }).tool_call_id;
		const toolCalls = (msg as { tool_calls?: unknown[] }).tool_calls;
		let approxChars = 0;
		try {
			approxChars = JSON.stringify(content ?? "").length;
		} catch {
			approxChars = 0;
		}
		return {
			role,
			contentPartTypes,
			...(typeof toolCallId === "string" ? { toolCallId } : {}),
			...(Array.isArray(toolCalls) && toolCalls.length > 0
				? { toolCallCount: toolCalls.length }
				: {}),
			approxChars,
		};
	});
}
