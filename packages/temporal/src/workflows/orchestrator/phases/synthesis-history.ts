/**
 * Inputs for the answer the iterative loop writes when a turn runs out of its
 * budget.
 *
 * That synthesis used to be sent the whole conversation. By the time a turn is
 * over budget the history is at its largest — prior turns, every tool call's
 * arguments, the most recent tool results in full — and the one call meant to
 * rescue the turn was the one most likely to overflow the model's context. It
 * failed, the retry failed the same way, and the user got a static "Reached
 * the conversation limit" line instead of what the run had found.
 *
 * Pure and deterministic: runs in the workflow sandbox.
 */

import type { IterativeMessage } from "../types";

export const SYNTHESIS_INPUT = {
	/** Ceiling for the whole compacted history (~30K tokens). */
	maxTotalChars: 120_000,
	/** Most recent tool results kept at `recentToolResultMaxChars`. */
	recentToolResults: 4,
	recentToolResultMaxChars: 6_000,
	olderToolResultMaxChars: 400,
	/** The original request, kept first and never dropped. */
	firstMessageMaxChars: 8_000,
	otherMessageMaxChars: 4_000,
	toolArgsMaxChars: 1_000,
} as const;

function truncate(text: string, max: number): string {
	if (text.length <= max) {
		return text;
	}
	return `${text.slice(0, max)}… [truncated, ${text.length - max} more chars]`;
}

function messageChars(message: IterativeMessage): number {
	let chars = message.content.length;
	for (const call of message.toolCalls ?? []) {
		chars += call.name.length + JSON.stringify(call.args ?? {}).length;
	}
	return chars;
}

function compactArgs(args: Record<string, unknown>): Record<string, unknown> {
	const json = JSON.stringify(args ?? {});
	return json.length <= SYNTHESIS_INPUT.toolArgsMaxChars
		? args
		: { truncatedArgs: truncate(json, SYNTHESIS_INPUT.toolArgsMaxChars) };
}

/**
 * Units that must be kept or dropped together: an assistant turn with tool
 * calls and the tool results that answer it. A tool result without its call
 * (or the reverse) fails provider validation.
 */
function groupIntoUnits(messages: IterativeMessage[]): IterativeMessage[][] {
	const units: IterativeMessage[][] = [];
	for (const message of messages) {
		const current = units.at(-1);
		if (message.role === "tool" && current?.[0]?.toolCalls?.length) {
			current.push(message);
		} else {
			units.push([message]);
		}
	}
	return units;
}

/**
 * A copy of `history` small enough for one synthesis call: tool results and
 * tool-call arguments shortened (recent results less so), then the oldest
 * turns after the original request dropped whole until the total fits.
 * The input is not modified.
 */
export function buildSynthesisHistory(
	history: IterativeMessage[],
): IterativeMessage[] {
	if (history.length === 0) {
		return [];
	}

	const toolIndexes = history
		.map((message, index) => (message.role === "tool" ? index : -1))
		.filter((index) => index >= 0);
	const recentTools = new Set(
		toolIndexes.slice(-SYNTHESIS_INPUT.recentToolResults),
	);

	const compacted = history.map((message, index): IterativeMessage => {
		let max: number = SYNTHESIS_INPUT.otherMessageMaxChars;
		if (index === 0) {
			max = SYNTHESIS_INPUT.firstMessageMaxChars;
		} else if (message.role === "tool") {
			max = recentTools.has(index)
				? SYNTHESIS_INPUT.recentToolResultMaxChars
				: SYNTHESIS_INPUT.olderToolResultMaxChars;
		}
		return {
			...message,
			content: truncate(message.content, max),
			...(message.toolCalls
				? {
						toolCalls: message.toolCalls.map((call) => ({
							...call,
							args: compactArgs(call.args),
						})),
					}
				: {}),
		};
	});

	const units = groupIntoUnits(compacted);
	const firstUnit = units.shift() ?? [];
	let total = compacted.reduce((sum, m) => sum + messageChars(m), 0);
	let dropped = 0;
	while (total > SYNTHESIS_INPUT.maxTotalChars && units.length > 1) {
		const unit = units.shift() ?? [];
		for (const message of unit) {
			total -= messageChars(message);
		}
		dropped += unit.length;
	}
	// A tool result can only follow its call; if the oldest kept unit is an
	// orphaned result, drop it too.
	while (units[0]?.[0]?.role === "tool") {
		dropped += units.shift()?.length ?? 0;
	}

	const kept = units.flat();
	if (dropped === 0) {
		return [...firstUnit, ...kept];
	}
	const note: IterativeMessage = {
		role: "user",
		content: `[${dropped} earlier message(s) of this turn were left out to fit the summary. Work from what follows.]`,
		timestamp: compacted[0].timestamp,
		iteration: 0,
	};
	return [...firstUnit, note, ...kept];
}

const FINDINGS = {
	maxResults: 3,
	maxCharsPerResult: 600,
} as const;

/**
 * The most recent successful tool outputs, shortened, for the deterministic
 * fallback — so when no model answer can be written the user still sees
 * what the run found, not only that it stopped.
 */
export function renderPartialFindings(
	toolCalls: Array<{ name: string; result?: unknown; status: string }>,
): string | null {
	const lines: string[] = [];
	const successful = toolCalls
		.filter((call) => call.status === "success")
		.slice(-FINDINGS.maxResults);
	for (const call of successful) {
		if (call.result === undefined || call.result === null) {
			continue;
		}
		const raw =
			typeof call.result === "string"
				? call.result
				: (JSON.stringify(call.result) ?? "");
		const text = raw.replace(/\s+/g, " ").trim();
		if (!text) {
			continue;
		}
		lines.push(
			`**${call.name}**\n> ${truncate(text, FINDINGS.maxCharsPerResult)}`,
		);
	}
	return lines.length > 0
		? `## What I found so far\n\n${lines.join("\n\n")}`
		: null;
}
