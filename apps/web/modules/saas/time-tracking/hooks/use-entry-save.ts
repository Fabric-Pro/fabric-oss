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
import {
	nextUnansweredWarning,
	type TimeEntryFields,
} from "../lib/entry-draft";
import type { TimeEntry } from "../lib/time-entry-model";
import { invalidateTimeEntries } from "../lib/time-tracking-api";

interface PendingConfirmation {
	fields: TimeEntryFields;
	warnings: TimeEntryWarning[];
	acknowledged: TimeWarningCode[];
}

/**
 * Saving an entry, including the server's "are you sure?" round.
 *
 * A save the server finds suspicious (a likely duplicate, a day over the
 * limit) comes back `needs_confirmation` instead of saving. The form then asks
 * one question at a time; "yes" to the last open one resends the same fields
 * with every answered code in `acknowledgedWarnings`. `dismiss` only drops the
 * question; what "no" does to the typed entry is the form's to decide.
 */
export function useEntrySave(params: {
	/** Set when editing; the save then replaces this entry. */
	entryId?: string;
	onSaved: (entry: TimeEntry) => void;
}) {
	const t = useTranslations("timeTracking.form");
	const queryClient = useQueryClient();
	const [pending, setPending] = useState<PendingConfirmation | null>(null);

	const mutation = useMutation({
		mutationFn: (fields: TimeEntryFields) =>
			params.entryId
				? orpc.timeTracking.updateEntry.call({
						...fields,
						entryId: params.entryId,
					})
				: orpc.timeTracking.createEntry.call(fields),
		onSuccess: async (result, fields) => {
			if (result.status === "needs_confirmation") {
				setPending({
					fields,
					warnings: result.warnings,
					acknowledged: fields.acknowledgedWarnings ?? [],
				});
				return;
			}
			setPending(null);
			await invalidateTimeEntries(queryClient);
			toast.success(params.entryId ? t("updated") : t("added"));
			params.onSaved(result.entry);
		},
		onError: () => {
			toast.error(t("saveFailed"));
		},
	});

	const question = pending
		? nextUnansweredWarning(pending.warnings, pending.acknowledged)
		: null;

	return {
		isSaving: mutation.isPending,
		question,
		save: (fields: TimeEntryFields) => {
			setPending(null);
			mutation.mutate(fields);
		},
		confirm: () => {
			if (!pending || !question) {
				return;
			}
			const acknowledged = [...pending.acknowledged, question.code];
			if (nextUnansweredWarning(pending.warnings, acknowledged)) {
				setPending({ ...pending, acknowledged });
				return;
			}
			mutation.mutate({
				...pending.fields,
				acknowledgedWarnings: acknowledged,
			});
		},
		dismiss: () => setPending(null),
	};
}
