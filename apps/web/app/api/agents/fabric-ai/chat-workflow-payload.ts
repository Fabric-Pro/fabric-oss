import {
	assertPayloadWithinLimit,
	PayloadTooLargeError,
} from "@repo/temporal/payload-size-guard";

/**
 * What the user is told when a chat turn's workflow input would not fit
 * Temporal's 4 MiB start frame. Without the check the start was rejected
 * with a gRPC "message larger than max" that named nothing the user could
 * act on (review F38).
 */
export const CHAT_PAYLOAD_TOO_LARGE_MESSAGE =
	"This message is too large to send together with the conversation and its attachments. Remove some attached content, or start a new chat.";

/**
 * Throws an error carrying {@link CHAT_PAYLOAD_TOO_LARGE_MESSAGE} when the
 * workflow input exceeds the Temporal payload budget. Returns the measured
 * size otherwise.
 */
export function assertChatWorkflowPayload(
	input: unknown,
	label: string,
): number {
	try {
		return assertPayloadWithinLimit(input, label);
	} catch (error) {
		if (error instanceof PayloadTooLargeError) {
			console.warn(`[Chat payload guard] ${error.message}`);
			throw new Error(CHAT_PAYLOAD_TOO_LARGE_MESSAGE);
		}
		throw error;
	}
}
