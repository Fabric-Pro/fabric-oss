"use client";

import type {
	TimeEntryWarning,
	TimeWarningCode,
} from "@repo/utils/time-tracking";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { nextUnansweredWarning } from "../lib/entry-draft";
import type { ConfirmSuggestionFields } from "../lib/suggestion-model";
import { invalidateTimeSuggestions } from "../lib/time-tracking-api";

interface PendingConfirmation {
	fields: ConfirmSuggestionFields;
	warnings: TimeEntryWarning[];
	acknowledged: TimeWarningCode[];
}

type ConfirmOutcome = "saved" | "question" | "failed";

/**
 * Confirming and dismissing suggestions, including the server's "are you
 * sure?" round, as `useEntrySave` does for a typed entry.
 *
 * A confirm the server finds suspicious (a likely duplicate, a day over the
 * limit) comes back `needs_confirmation`; the row asks one question at a
 * time, and "yes" to the last open one resends the same fields with every
 * answered code. One question is open at a time across the list, so the
 * batch confirm can stop on a row and leave its question there.
 */
export function useSuggestionConfirm() {
	const t = useTranslations("timeTracking.suggestions");
	const queryClient = useQueryClient();
	const [pending, setPending] = useState<PendingConfirmation | null>(null);

	const confirmMutation = useMutation({
		mutationFn: (fields: ConfirmSuggestionFields) =>
			orpc.timeTracking.confirmSuggestion.call(fields),
	});
	const dismissMutation = useMutation({
		mutationFn: (suggestionId: string) =>
			orpc.timeTracking.dismissSuggestion.call({ suggestionId }),
		onSuccess: async () => {
			await invalidateTimeSuggestions(queryClient);
		},
		onError: () => {
			toast.error(t("dismissFailed"));
		},
	});

	/** Send one confirm; the caller refreshes the lists when it is done. */
	const send = async (
		fields: ConfirmSuggestionFields,
	): Promise<ConfirmOutcome> => {
		try {
			const result = await confirmMutation.mutateAsync(fields);
			if (result.status === "needs_confirmation") {
				setPending({
					fields,
					warnings: result.warnings,
					acknowledged: fields.acknowledgedWarnings ?? [],
				});
				return "question";
			}
			setPending(null);
			return "saved";
		} catch {
			toast.error(t("confirmFailed"));
			return "failed";
		}
	};

	const confirmOne = async (fields: ConfirmSuggestionFields) => {
		setPending(null);
		if ((await send(fields)) === "saved") {
			await invalidateTimeSuggestions(queryClient);
			toast.success(t("confirmed"));
		}
	};

	const question = pending
		? nextUnansweredWarning(pending.warnings, pending.acknowledged)
		: null;

	return {
		/** The open question and the suggestion it is about. */
		question:
			pending && question
				? {
						suggestionId: pending.fields.suggestionId,
						warning: question,
					}
				: null,
		confirmingId: confirmMutation.isPending
			? (confirmMutation.variables?.suggestionId ?? null)
			: null,
		dismissingId: dismissMutation.isPending
			? (dismissMutation.variables ?? null)
			: null,
		confirm: (fields: ConfirmSuggestionFields) => void confirmOne(fields),
		/**
		 * Confirm rows one by one, stopping at the first that asks a question
		 * or fails; the question stays on that row.
		 */
		confirmAll: async (batch: readonly ConfirmSuggestionFields[]) => {
			setPending(null);
			let saved = 0;
			for (const fields of batch) {
				if ((await send(fields)) !== "saved") {
					break;
				}
				saved += 1;
			}
			if (saved > 0) {
				await invalidateTimeSuggestions(queryClient);
				toast.success(t("confirmedMany", { count: saved }));
			}
		},
		answerYes: () => {
			if (!pending || !question) {
				return;
			}
			const acknowledged = [...pending.acknowledged, question.code];
			if (nextUnansweredWarning(pending.warnings, acknowledged)) {
				setPending({ ...pending, acknowledged });
				return;
			}
			void confirmOne({
				...pending.fields,
				acknowledgedWarnings: acknowledged,
			});
		},
		/** "No, skip": drop the question; the suggestion stays to confirm. */
		answerNo: () => setPending(null),
		dismiss: (suggestionId: string) => {
			if (pending?.fields.suggestionId === suggestionId) {
				setPending(null);
			}
			dismissMutation.mutate(suggestionId);
		},
	};
}
