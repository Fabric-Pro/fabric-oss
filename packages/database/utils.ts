/**
 * Database utility functions
 */

import { randomBytes } from "node:crypto";
import { createId } from "@paralleldrive/cuid2";
import type { FeatureDraftingStage } from "./prisma/client";

/**
 * Generate a unique ID compatible with Prisma's cuid() default.
 * Uses cuid2 for collision-resistant IDs.
 */
export function generateId(): string {
	return createId();
}

/**
 * Generate a cryptographically secure random token.
 * @param length - Length of the token in bytes (default: 32)
 * @returns Hex-encoded random string
 */
export async function generateSecureToken(length = 32): Promise<string> {
	return new Promise((resolve, reject) => {
		randomBytes(length, (err, buffer) => {
			if (err) {
				reject(err);
			} else {
				resolve(buffer.toString("hex"));
			}
		});
	});
}

/**
 * Normalize a backlog item title for collision detection.
 *
 * Used as the dedup key when an AI-generated CREATE proposal needs to be
 * checked against existing roadmap items. Lower-cases, trims, and strips a
 * leading `[BUG] ` prefix so that legacy bug rows (which were stored with
 * the prefix prior to PR #1041's analyzer change) compare equal to new
 * unprefixed bug rows. The output is otherwise the raw title — punctuation,
 * pluralization, and ordering differences are preserved (an LLM that
 * paraphrases is the analyzer's concern, not this normalizer's).
 *
 * Shared between the AI Update sidebar guard (PR #1137,
 * `applyBacklogChanges`) and the Teams/Slack approve-pending-proposal
 * guards, so both flows produce the same equivalence class.
 */
export function normalizeBacklogTitle(title: string): string {
	return title
		.toLowerCase()
		.trim()
		.replace(/^\[bug\]\s+/i, "")
		.trim();
}

/**
 * Drafting stages that represent a TERMINAL, immutable work-item lifecycle
 * state. A terminal item is "resolved" — declined or closed — and must never be
 * mutated by an automated pipeline (notably AI Update) nor surfaced as a
 * duplicate-detection candidate.
 *
 * This is the single source of truth for the stage half of "terminal": the
 * duplicate-detection scan re-exports it as `INACTIVE_STAGES`
 * (`duplicate-links.ts`) and the AI-Update apply gate consults it via
 * {@link isTerminalWorkItemState}. Add a new terminal stage here and every
 * consumer picks it up — do NOT inline these checks at call sites.
 */
export const TERMINAL_DRAFTING_STAGES: FeatureDraftingStage[] = [
	"DECLINED",
	"CLOSED",
];

/**
 * True when a work item is in a terminal lifecycle state and must be treated as
 * immutable.
 *
 * Terminal iff `draftingStage` is one of {@link TERMINAL_DRAFTING_STAGES}
 * (`DECLINED`, `CLOSED`) OR the row was auto-hidden by the PM terminal-status
 * poll (`pmAutoHidden`). `pmAutoHidden === true` always co-occurs with
 * `draftingStage === "CLOSED"` in the data model (the auto-hide path is the only
 * writer that sets it, and every other stage writer clears it), so the
 * `pmAutoHidden` clause is defensive — it keeps the predicate correct even if
 * that invariant is ever relaxed, and documents the auto-hide case explicitly.
 *
 * Used by the AI-Update apply terminal-state gate (`applyBacklogChanges`) to
 * redirect an `action:"update"` away from a closed/hidden/declined target and
 * into a new-ticket creation, and reusable anywhere a "may this row be mutated?"
 * decision is needed.
 */
export function isTerminalWorkItemState(item: {
	draftingStage: FeatureDraftingStage;
	pmAutoHidden: boolean;
}): boolean {
	return (
		TERMINAL_DRAFTING_STAGES.includes(item.draftingStage) ||
		item.pmAutoHidden === true
	);
}
