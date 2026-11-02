import { redactSensitiveKeys } from "@repo/utils/sensitive-keys";
import { z } from "zod";
import { isToolMessage, isToolResultError } from "./tool-result";
import { sanitizeMcpErrorMessage } from "./utils/sanitize-error";

const serializedToolSchema = z.object({
	lc: z.literal(1),
	type: z.literal("constructor"),
	id: z.array(z.string()).refine((id) => id.at(-1) === "ToolMessage"),
	kwargs: z.object({
		tool_call_id: z.string(),
		content: z.string(),
		status: z.string().optional(),
		additional_kwargs: z.record(z.string(), z.unknown()).optional(),
	}),
});
const toolOutcomeSchema = z.object({ success: z.boolean() });

function preview(content: string): string {
	try {
		const redacted = redactSensitiveKeys(JSON.parse(content));
		const safe = JSON.stringify(redacted);
		if (safe.length <= 4000) {
			return safe;
		}
		const outcome = toolOutcomeSchema.safeParse(redacted);
		return JSON.stringify({
			...(outcome.success && { success: outcome.data.success }),
			truncated: true,
			preview: sanitizeMcpErrorMessage(safe),
		});
	} catch {
		return sanitizeMcpErrorMessage(content);
	}
}

/** Only results of calls emitted by this run may cross the AG-UI boundary. */
export class AgUiToolResults {
	private readonly calls = new Map<string, boolean>();
	private readonly answered = new Set<string>();

	observe(event: Record<string, unknown>): void {
		if (typeof event.toolCallId !== "string") {
			return;
		}
		if (event.type === "TOOL_CALL_START") {
			if (!this.calls.has(event.toolCallId)) {
				this.calls.set(event.toolCallId, false);
			}
		} else if (
			event.type === "TOOL_CALL_END" &&
			this.calls.has(event.toolCallId)
		) {
			this.calls.set(event.toolCallId, true);
		}
	}

	collect(messages: unknown) {
		if (!Array.isArray(messages)) {
			return [];
		}
		return messages.flatMap((raw: unknown) => {
			const serialized = serializedToolSchema.safeParse(raw);
			const message = serialized.success
				? { type: "tool", ...serialized.data.kwargs }
				: raw;
			if (!isToolMessage(message)) {
				return [];
			}
			const id = message.tool_call_id;
			if (
				typeof id !== "string" ||
				!this.calls.get(id) ||
				this.answered.has(id) ||
				typeof message.content !== "string"
			) {
				return [];
			}
			this.answered.add(id);
			const content = isToolResultError(message)
				? JSON.stringify({
						success: false,
						error: sanitizeMcpErrorMessage(
							preview(message.content),
						),
					})
				: preview(message.content);
			return [
				{
					type: "TOOL_CALL_RESULT" as const,
					messageId: `${id}:result`,
					toolCallId: id,
					role: "tool" as const,
					content,
				},
			];
		});
	}
}
