"use client";

import { useCallback } from "react";
import { toast } from "sonner";
import { useRecordDocumentAssistantDiffOutcome } from "./useDocumentAssistantHistory";

const DIFF_OUTCOME_NOT_RECORDED_MESSAGE =
	"Couldn't record your decision in the conversation history.";

/**
 * Which proposal an outcome is stamped on: the conversation, and the
 * `(messageId, toolCallId)` entry in its persisted messages blob.
 */
export interface DiffOutcomeAudit {
	conversationId: string | null;
	projectId: string;
	organizationId: string | null;
	messageId: string | null;
	toolCallId: string | null;
}

/**
 * Stamps acceptedAt / rejectedAt on a proposal's tool call, for the History
 * drawer's and the chat's outcome chip: what the person decided about an
 * assistant proposal stays on the conversation. Shared by the diff review bar
 * and the chat's confirm card, whose accept and reject left the chip
 * "Pending" (Fizzy #2946).
 *
 * Fire-and-forget: it MUST NEVER block the person's accept/reject nor roll
 * back the editor on failure — the diff in the editor IS the source of
 * truth; the audit trail on the conversation is a nice-to-have. A failure
 * surfaces a quiet sonner `error` toast and continues. Skips entirely when
 * the audit context is incomplete (e.g. the diff is from
 * `useUpdateDocumentWithContext`, which is NOT a `write_document_local`
 * tool call, so there is no proposal to stamp).
 */
export function useDiffOutcomeStamp() {
	const recordDiffOutcomeMutation = useRecordDocumentAssistantDiffOutcome();
	return useCallback(
		async (
			outcomeAudit: DiffOutcomeAudit | undefined,
			outcome: "accepted" | "rejected",
		) => {
			if (!outcomeAudit) {
				return;
			}
			const {
				conversationId,
				projectId,
				organizationId,
				messageId,
				toolCallId,
			} = outcomeAudit;
			if (!conversationId || !messageId || !toolCallId) {
				if (process.env.NODE_ENV !== "production") {
					// eslint-disable-next-line no-console
					console.debug(
						"[useDiffOutcomeStamp] skipping recordDiffOutcome — incomplete audit context",
						{ conversationId, messageId, toolCallId },
					);
				}
				return;
			}
			try {
				await recordDiffOutcomeMutation.mutateAsync({
					conversationId,
					projectId,
					organizationId,
					messageId,
					toolCallId,
					outcome,
					at: new Date().toISOString(),
				});
			} catch {
				// This write is only the conversation's record, so the toast
				// says nothing about whether the edit itself was applied or
				// saved: the editor and the save report that.
				toast.error(DIFF_OUTCOME_NOT_RECORDED_MESSAGE);
			}
		},
		[recordDiffOutcomeMutation],
	);
}
