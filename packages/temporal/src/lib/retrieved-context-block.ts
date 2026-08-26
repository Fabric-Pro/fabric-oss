import { STRONG_RAG_INSTRUCTIONS } from "@repo/agent-prompts";
import { neutralizeAiChatAttachmentBody } from "@repo/utils/ai-chat-attachment";

/**
 * The `## Retrieved Context` block, built with its guard rather than beside it.
 *
 * Three activities used to inline this scaffolding themselves, each mapping the
 * context array straight into `### Reference N` headings with no treatment of
 * what the strings contained. Everything that joins that array is user-reachable
 * text: project context rows come from uploads, pastes and URL crawls; Slack and
 * Teams contexts are messages, so anyone who can post in a connected channel can
 * put a line in this prompt. A context whose own text begins a line with
 * `### Reference 7` or `## Retrieved Context` therefore forged a section the
 * agent reads as scaffolding — a heading it trusts, in the middle of material it
 * was told to treat as content only.
 *
 * Making this one function is the fix, not merely the tidy-up. The previous
 * shape let a caller emit the delimiters without the guard, and did so three
 * times; a fourth site would have inherited the same gap. Here the block cannot
 * be produced without the neutralizer running over every entry.
 *
 * `neutralizeAiChatAttachmentBody` is the existing tool and needs no change: its
 * pattern already special-cases `Retrieved Context` and `Reference <n>` because
 * the chat attachment envelope emits the same two headings. A second copy of
 * that pattern here is exactly the drift it was written to prevent.
 *
 * Not applied at the producers instead: the text lives in Slack, in Teams, and
 * in context rows this code does not own, so there is no single earlier point
 * that sees all of it. The place every producer's output converges is the place
 * it is rendered, which is here.
 */
export function buildRetrievedContextBlock(
	contexts: readonly string[],
	finalReminder: string,
): string {
	if (contexts.length === 0) {
		return "";
	}

	const references = contexts
		.map(
			(context, index) =>
				`### Reference ${index + 1}\n${neutralizeAiChatAttachmentBody(context)}`,
		)
		.join("\n\n");

	return `

${STRONG_RAG_INSTRUCTIONS}

---

## Retrieved Context

${references}

---

${finalReminder}`;
}
