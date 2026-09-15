/**
 * Default spike question (plan Slice 3).
 *
 * When `codingRuns.start` is called with `kind: "SPIKE"` and no explicit
 * question, the question is derived from the story title and a short text
 * summary of its description. Descriptions are TipTap JSON or plain text.
 */

const SPIKE_QUESTION_MAX_LENGTH = 2000;
const SUMMARY_MAX_LENGTH = 600;

/** Collect text nodes from a TipTap document in reading order. */
function collectTipTapText(node: unknown, out: string[]): void {
	if (!node || typeof node !== "object") {
		return;
	}
	const record = node as {
		type?: unknown;
		text?: unknown;
		content?: unknown;
	};
	if (record.type === "text" && typeof record.text === "string") {
		out.push(record.text);
		return;
	}
	if (Array.isArray(record.content)) {
		for (const child of record.content) {
			collectTipTapText(child, out);
		}
		// Block boundaries become whitespace so words do not run together.
		if (record.type !== "doc") {
			out.push(" ");
		}
	}
}

/** Plain-text summary of a story description (TipTap JSON or text). */
function summarizeStoryDescription(
	description: string | null | undefined,
	maxLength = SUMMARY_MAX_LENGTH,
): string {
	const raw = description?.trim() ?? "";
	if (!raw) {
		return "";
	}
	let text = raw;
	if (raw.startsWith("{")) {
		try {
			const doc = JSON.parse(raw) as { type?: unknown };
			if (doc && doc.type === "doc") {
				const parts: string[] = [];
				collectTipTapText(doc, parts);
				text = parts.join("");
			}
		} catch {
			// Not JSON: treat as text.
		}
	}
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > maxLength
		? `${oneLine.slice(0, maxLength - 1)}…`
		: oneLine;
}

/**
 * Build the default spike question from the story. Always non-empty and
 * within the `spikeQuestion` input bounds.
 */
export function defaultSpikeQuestion(story: {
	identifier: string;
	title: string;
	description?: string | null;
}): string {
	const summary = summarizeStoryDescription(story.description);
	const question = summary
		? `Can we deliver "${story.title}" (${story.identifier})? Context: ${summary}`
		: `Can we deliver "${story.title}" (${story.identifier})? Investigate feasibility and the recommended next track.`;
	return question.length > SPIKE_QUESTION_MAX_LENGTH
		? `${question.slice(0, SPIKE_QUESTION_MAX_LENGTH - 1)}…`
		: question;
}
