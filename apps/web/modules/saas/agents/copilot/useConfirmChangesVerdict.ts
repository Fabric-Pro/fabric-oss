"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useCallback, useRef } from "react";

type Surface =
	| { surface: "topic-analysis"; projectId: string }
	| { surface: "feature-spec" | "document"; projectId: string }
	| { surface: "prompt-enhancer" | "document-generator" };
type Draft = { id: string | null; resolved: boolean };
export type DraftVerdictRecorder = ((accepted: boolean) => Promise<void>) & {
	binding: { current: Draft };
};

/**
 * The installed CopilotKit v1 render adapter does not forward a tool-call id.
 * Create a binding for its callbacks instead. The mounted card adopts
 * subsequent render bindings into its own token with useConfirmChangesVerdictCard.
 * Thus callbacks captured earlier by a review bar share the card's one decision.
 * No run/loading state owns identity; UUID allocation happens on the first click.
 */
export function useConfirmChangesVerdict(options: Surface) {
	const projectId = "projectId" in options ? options.projectId : undefined;
	return useCallback((): DraftVerdictRecorder => {
		const binding = { current: { id: null, resolved: false } as Draft };
		const record = async (accepted: boolean): Promise<void> => {
			const draft = binding.current;
			if (draft.resolved) {
				return;
			}
			draft.resolved = true;
			// Accepting a topic rewrite opens an editor; analysis-revision.ts records
			// ACCEPTED_WITH_EDITS when that revision saves. Only Reject is measured here.
			if (options.surface === "topic-analysis" && accepted) {
				return;
			}
			// The other editors lack a reliable pre-edit merged-draft snapshot, so an
			// approval means accepted without guessing accepted-with-edits.
			try {
				draft.id ??= crypto.randomUUID();
				await orpcClient.ai.feedback.confirmDraft(
					options.surface === "topic-analysis"
						? { ...options, draftId: draft.id, verdict: "rejected" }
						: {
								...options,
								draftId: draft.id,
								verdict: accepted ? "accepted" : "rejected",
							},
				);
			} catch (error) {
				console.warn(
					"[confirm-draft] Failed to record AI verdict",
					error,
				);
			}
		};
		return Object.assign(record, { binding });
	}, [options.surface, projectId]);
}

/** Bind a mounted confirm card and its earlier captured controls to one token. */
export function useConfirmChangesVerdictCard(record: DraftVerdictRecorder) {
	const card = useRef(record.binding.current);
	record.binding.current = card.current;
}
