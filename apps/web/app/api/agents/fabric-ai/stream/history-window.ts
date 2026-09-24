import { z } from "zod";

/**
 * The conversation history a chat turn accepts.
 *
 * The route used to reject a history longer than 200 entries with a 400
 * "Invalid request body", and the client sent the whole thread — so from
 * roughly the hundredth exchange every send in that conversation failed, for
 * good (Fizzy #2040, review F32). It now keeps the most recent window
 * instead. The hard ceiling still refuses an absurd payload outright.
 *
 * `system` is accepted and folded into the assistant turn by the route.
 * Persisted conversations legitimately hold system rows (operation results),
 * so a client replaying its own history must not be rejected for one.
 */
const HISTORY_WINDOW_ENTRIES = 200;
const HISTORY_HARD_CEILING_ENTRIES = 2_000;

/**
 * Total characters of history a turn carries into its workflow input.
 *
 * Counting entries alone let 200 entries of 200k characters each through —
 * 40M characters, far past any model's context and past Temporal's 4 MiB
 * workflow-start frame, so the thread failed on every later send (review
 * F38). This is a transport bound, not the model budget: the Direct activity
 * fits what arrives to the resolved model's context window. Even at three
 * UTF-8 bytes a character it leaves room in the frame for the rest of the
 * input.
 */
export const HISTORY_MAX_TOTAL_CHARS = 600_000;

/**
 * The most recent entries that fit both the entry window and the character
 * budget. The newest entry is always kept — cut to the budget when it alone
 * exceeds it — so the thread never loses its latest context entirely.
 */
export function windowHistory<T extends { content: string }>(
	history: T[],
	limits: { maxEntries?: number; maxTotalChars?: number } = {},
): T[] {
	const maxEntries = limits.maxEntries ?? HISTORY_WINDOW_ENTRIES;
	const maxTotalChars = limits.maxTotalChars ?? HISTORY_MAX_TOTAL_CHARS;
	const recent =
		history.length > maxEntries
			? history.slice(history.length - maxEntries)
			: history;

	const kept: T[] = [];
	let total = 0;
	for (let i = recent.length - 1; i >= 0; i--) {
		const entry = recent[i];
		if (total + entry.content.length <= maxTotalChars) {
			kept.unshift(entry);
			total += entry.content.length;
			continue;
		}
		if (kept.length === 0) {
			kept.unshift({
				...entry,
				content: entry.content.slice(
					entry.content.length - maxTotalChars,
				),
			});
		}
		break;
	}
	return kept;
}

/**
 * For a route that reads its body by hand (the orchestrator stream): keeps
 * well-formed user/assistant entries and applies the same window. That route
 * put whatever `history` the client sent straight into the workflow input,
 * with no size bound at all (review F38).
 */
type ChatHistoryEntry = { role: "user" | "assistant"; content: string };

export function windowUntypedHistory(raw: unknown): ChatHistoryEntry[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	const entries = raw.flatMap((entry: unknown): ChatHistoryEntry[] => {
		const candidate = entry as { role?: unknown; content?: unknown } | null;
		if (
			candidate &&
			(candidate.role === "user" || candidate.role === "assistant") &&
			typeof candidate.content === "string" &&
			// An empty text block is refused by the provider.
			candidate.content.trim().length > 0
		) {
			return [{ role: candidate.role, content: candidate.content }];
		}
		return [];
	});
	return windowHistory(entries);
}

export const historyWindowSchema = z
	.array(
		z.object({
			role: z.enum(["user", "assistant", "system"]),
			content: z.string().max(200_000),
		}),
	)
	.max(HISTORY_HARD_CEILING_ENTRIES)
	.default([])
	.transform((history) => windowHistory(history));
