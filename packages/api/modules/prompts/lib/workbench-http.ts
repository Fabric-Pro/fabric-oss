import { ORPCError } from "@orpc/server";
import { PROMPT_WORKBENCH_MAX_BYTES } from "@repo/ai/lib/prompt-workbench-contracts";
/** Bound the original request stream, including chunked bodies. Never logs inputs. */
export async function readPromptWorkbenchBody(
	request: Request,
): Promise<unknown> {
	const reader = request.body?.getReader();
	let size = 0;
	let text = "";
	const decoder = new TextDecoder();
	try {
		if (reader) {
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				size += value.byteLength;
				if (size > PROMPT_WORKBENCH_MAX_BYTES) {
					await reader.cancel().catch(() => undefined);
					throw new ORPCError("PAYLOAD_TOO_LARGE", {
						message: "The prompt request exceeds 512 KiB.",
					});
				}
				text += decoder.decode(value, { stream: true });
			}
			text += decoder.decode();
		}
		return JSON.parse(text);
	} catch (error) {
		if (error instanceof ORPCError) {
			throw error;
		}
		throw new ORPCError("BAD_REQUEST", {
			message: "Supply a valid JSON prompt request.",
		});
	} finally {
		reader?.releaseLock();
	}
}
