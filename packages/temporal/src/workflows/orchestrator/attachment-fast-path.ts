/**
 * Pure workflow-safe helpers for grounded inline attachment turns.
 *
 * Keeps raw user intent separate from large `<fabric_attachment>` bodies so
 * pattern detection, MCP eager routing, memory recall, tool search, and
 * up-front clarity checks operate on the user's actual request while the
 * answering model still receives the full grounded attachment text.
 */

import {
	type AiChatAttachmentManifestEntry,
	isSimpleGroundedAttachmentQa,
} from "@repo/utils/ai-chat-attachment";

export const GROUNDED_ATTACHMENT_FASTPATH_PATCH =
	"orch-grounded-attachment-fastpath-v1";

export { isSimpleGroundedAttachmentQa };

export function resolveIntentUserMessage(input: {
	message: string;
	rawUserMessage?: string;
}): string {
	return input.rawUserMessage !== undefined
		? input.rawUserMessage
		: input.message;
}

export function buildAttachmentMemoryQuery(
	intentMessage: string,
	manifest?: readonly AiChatAttachmentManifestEntry[],
): string {
	if (!manifest || manifest.length === 0) {
		return intentMessage;
	}
	const names = manifest
		.map((entry) => entry.name.trim())
		.filter((name) => name.length > 0)
		.slice(0, 10);
	if (names.length === 0) {
		return intentMessage;
	}
	return `${intentMessage}\n[Attached files: ${names.join(", ")}]`;
}

export function buildClarityUserMessage(
	input: {
		message: string;
		rawUserMessage?: string;
		attachmentManifest?: readonly AiChatAttachmentManifestEntry[];
	},
	fallbackEnrichedMessage?: string,
): string {
	if (input.rawUserMessage === undefined) {
		return fallbackEnrichedMessage || input.message;
	}

	const manifest = input.attachmentManifest;
	if (!manifest || manifest.length === 0) {
		if (
			fallbackEnrichedMessage &&
			fallbackEnrichedMessage !== input.message
		) {
			return fallbackEnrichedMessage;
		}
		return input.rawUserMessage;
	}

	const summary = manifest
		.map((entry) => {
			switch (entry.status) {
				case "truncated":
					return `${entry.name} (partial excerpt inline; retrieved chunks available)`;
				case "image":
					return `${entry.name} (image attached)`;
				case "empty":
					return `${entry.name} (attached; retrieved chunks available)`;
				default:
					return `${entry.name} (full text attached inline)`;
			}
		})
		.join(", ");

	return `${input.rawUserMessage}\n\n[Attached files in this turn: ${summary}. References such as "this document", "this file", or "the attachment" refer to these attached files.]`;
}
