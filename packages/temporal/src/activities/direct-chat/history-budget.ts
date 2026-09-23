/**
 * Fits a Direct turn's conversation history to the model's context window.
 *
 * Direct replays the whole text transcript every turn. Nothing measured it
 * against the model: once a thread with a few large pasted documents grew
 * past the window, the provider refused every following turn and the
 * conversation stayed dead — New chat was the only way out (review F38).
 *
 * The estimate is characters, not tokens: a tokenizer per provider is too
 * heavy for this path. Three characters a token undercounts English prose
 * (~4) on purpose, so the estimate errs toward trimming, and only part of
 * the window is given to the prompt — tool definitions, images and the
 * answer need the rest.
 */

/** Used when the resolved model has no catalog context window (an override). */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 32_000;

/** Share of the context window the text prompt (system + history + message) may use. */
const PROMPT_SHARE_OF_CONTEXT = 0.7;

const CHARS_PER_TOKEN = 3;

/**
 * History always gets at least this much, however large the system context
 * (RAG hits, project block) grew — otherwise a heavy context would silently
 * cost the model the whole conversation. Small next to any real window.
 */
const MIN_HISTORY_CHARS = 12_000;

/**
 * The model's context window. A model picked in the chat's model picker
 * resolves without a catalog window (`modelOverride` skips it), which would
 * put every such turn on the conservative default; look the model up in the
 * catalog by name instead, and fall back only for a model it does not know.
 */
export function resolveContextWindow(
	metadata: {
		contextWindow?: number;
		canonicalName?: string;
		modelString?: string;
	},
	lookupCatalogWindow: (modelId: string) => number | undefined,
): number | undefined {
	if (metadata.contextWindow && metadata.contextWindow > 0) {
		return metadata.contextWindow;
	}
	for (const modelId of [metadata.canonicalName, metadata.modelString]) {
		const window = modelId ? lookupCatalogWindow(modelId) : undefined;
		if (window && window > 0) {
			return window;
		}
	}
	return undefined;
}

export interface HistoryEntry {
	role: string;
	content: string;
}

export interface FittedHistory<T extends HistoryEntry> {
	history: T[];
	/** Oldest entries left out because they did not fit. */
	omittedCount: number;
	/** True when the newest kept entry had to be cut to fit. */
	truncatedNewest: boolean;
}

export function historyCharBudget(opts: {
	contextWindow?: number;
	fixedPromptChars: number;
}): number {
	const window =
		opts.contextWindow && opts.contextWindow > 0
			? opts.contextWindow
			: DEFAULT_CONTEXT_WINDOW_TOKENS;
	const promptChars = Math.floor(
		window * PROMPT_SHARE_OF_CONTEXT * CHARS_PER_TOKEN,
	);
	return Math.max(MIN_HISTORY_CHARS, promptChars - opts.fixedPromptChars);
}

/**
 * Keeps the most recent entries that fit the budget, newest first, and
 * drops everything older than the first one that does not — a gap in the
 * middle of a transcript would misrepresent the conversation.
 *
 * Empty entries are skipped outright: a turn that stopped at the step cap
 * before writing anything is saved with no text, and an empty text block is
 * refused by the provider — which would fail every later turn of the thread.
 */
export function fitHistoryToContext<T extends HistoryEntry>(opts: {
	history: T[];
	contextWindow?: number;
	/** System prompt plus the current message, in characters. */
	fixedPromptChars: number;
}): FittedHistory<T> {
	const budget = historyCharBudget(opts);
	const nonEmpty = opts.history.filter(
		(entry) => entry.content.trim().length > 0,
	);
	const kept: T[] = [];
	let used = 0;
	let truncatedNewest = false;

	for (let i = nonEmpty.length - 1; i >= 0; i--) {
		const entry = nonEmpty[i];
		if (used + entry.content.length <= budget) {
			kept.unshift(entry);
			used += entry.content.length;
			continue;
		}
		if (kept.length === 0) {
			kept.unshift({
				...entry,
				content: `[…earlier part of this message omitted to fit the context window]\n${entry.content.slice(entry.content.length - budget)}`,
			});
			truncatedNewest = true;
		}
		break;
	}

	return {
		history: kept,
		omittedCount: nonEmpty.length - kept.length,
		truncatedNewest,
	};
}

/**
 * Told to the model when history was left out, so it does not answer as if
 * it remembered the whole conversation.
 */
export function omittedHistoryNote(fitted: {
	omittedCount: number;
	truncatedNewest: boolean;
}): string | null {
	if (fitted.omittedCount === 0 && !fitted.truncatedNewest) {
		return null;
	}
	const parts: string[] = [];
	if (fitted.omittedCount > 0) {
		parts.push(
			`the ${fitted.omittedCount} earliest message${fitted.omittedCount === 1 ? "" : "s"} of this conversation were left out`,
		);
	}
	if (fitted.truncatedNewest) {
		parts.push("the only earlier message still included was shortened");
	}
	return `## Conversation history note:\nTo fit the model's context window, ${parts.join(" and ")}. If the user refers to something you can no longer see, say so and ask them to restate it rather than guessing.`;
}
