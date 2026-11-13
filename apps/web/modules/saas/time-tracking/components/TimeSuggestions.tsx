"use client";

import { Button } from "@ui/components/button";
import { cn } from "@ui/lib";
import { SparklesIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { useSuggestionConfirm } from "../hooks/use-suggestion-confirm";
import type { SuggestionRunNotice } from "../hooks/use-suggestion-run";
import type { DraftProblem } from "../lib/entry-draft";
import {
	batchConfirmable,
	buildConfirmFields,
	type ConfirmSuggestionFields,
	type SuggestionDraft,
	suggestionDraft,
	type TimeSuggestion,
} from "../lib/suggestion-model";
import type { TimeEntry } from "../lib/time-entry-model";
import { InfoHint } from "./InfoHint";
import { SuggestionRow } from "./SuggestionRow";

const NOTICE_KEYS: Record<SuggestionRunNotice, string> = {
	alreadyChecking: "notices.alreadyChecking",
	unavailable: "notices.unavailable",
	failed: "notices.failed",
	nothingNew: "notices.nothingNew",
};

/** "Check my activity", with its running state. */
export function CheckActivityButton({
	checking,
	onCheck,
	className,
}: {
	checking: boolean;
	onCheck: () => void;
	className?: string;
}) {
	const t = useTranslations("timeTracking.suggestions");
	return (
		<Button
			type="button"
			variant="outline"
			size="sm"
			onClick={onCheck}
			loading={checking}
			className={className}
		>
			{checking ? null : <SparklesIcon aria-hidden="true" />}
			{checking ? t("checking") : t("check")}
		</Button>
	);
}

/**
 * "To confirm": the time Fabric suggests from the caller's own activity,
 * one line each, above the day and week.
 *
 * Each row's edits stay here, keyed by suggestion, until it is confirmed, so
 * the batch confirm sends what every row shows. The page renders this only
 * while there is something to confirm, a check is running, or a check has
 * just said how it ended.
 */
export function TimeSuggestions({
	organizationId,
	suggestions,
	knownEntries,
	checking,
	notice,
	onCheck,
}: {
	organizationId: string;
	suggestions: readonly TimeSuggestion[];
	knownEntries: readonly TimeEntry[];
	checking: boolean;
	notice: SuggestionRunNotice | null;
	onCheck: () => void;
}) {
	const t = useTranslations("timeTracking.suggestions");
	const headingId = useId();
	const confirmer = useSuggestionConfirm();
	const [drafts, setDrafts] = useState<Record<string, SuggestionDraft>>({});
	const [problems, setProblems] = useState<
		Record<string, DraftProblem | null>
	>({});
	const [batching, setBatching] = useState(false);

	const draftFor = (suggestion: TimeSuggestion) =>
		drafts[suggestion.id] ?? suggestionDraft(suggestion);

	const setProblem = (suggestionId: string, problem: DraftProblem | null) =>
		setProblems((current) => ({ ...current, [suggestionId]: problem }));

	const update = (
		suggestion: TimeSuggestion,
		patch: Partial<SuggestionDraft>,
	) => {
		setDrafts((current) => ({
			...current,
			[suggestion.id]: {
				...(current[suggestion.id] ?? suggestionDraft(suggestion)),
				...patch,
			},
		}));
		setProblem(suggestion.id, null);
		if (confirmer.question?.suggestionId === suggestion.id) {
			confirmer.answerNo();
		}
	};

	/** The confirm request for a row, or `null` after flagging its problem. */
	const fieldsFor = (
		suggestion: TimeSuggestion,
	): ConfirmSuggestionFields | null => {
		const result = buildConfirmFields(suggestion, draftFor(suggestion));
		if (!result.ok) {
			setProblem(suggestion.id, result.problem);
			return null;
		}
		setProblem(suggestion.id, null);
		return result.fields;
	};

	const batch = batchConfirmable(suggestions);
	const confirmAll = async () => {
		const requests: ConfirmSuggestionFields[] = [];
		for (const suggestion of batch) {
			const fields = fieldsFor(suggestion);
			if (!fields) {
				break;
			}
			requests.push(fields);
		}
		setBatching(true);
		await confirmer.confirmAll(requests);
		setBatching(false);
	};

	const busy = batching || confirmer.confirmingId !== null;

	return (
		<section
			aria-labelledby={headingId}
			className="space-y-2 rounded-lg border border-border bg-card px-4 py-3"
			data-onboarding-target="time-suggestions"
		>
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="flex items-center gap-1">
					<h2 id={headingId} className="font-semibold text-base">
						{t("title")}
					</h2>
					<InfoHint label={t("aboutTitle")}>{t("about")}</InfoHint>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					<output
						className={cn(
							"text-sm",
							notice === "failed"
								? "text-destructive"
								: "text-muted-foreground",
						)}
					>
						{notice ? t(NOTICE_KEYS[notice]) : null}
					</output>
					{batch.length > 0 ? (
						<Button
							type="button"
							size="sm"
							variant="outline"
							onClick={() => void confirmAll()}
							loading={batching}
							disabled={busy && !batching}
						>
							{t("confirmAll", { count: batch.length })}
						</Button>
					) : null}
					<CheckActivityButton
						checking={checking}
						onCheck={onCheck}
					/>
				</div>
			</div>

			{suggestions.length > 0 ? (
				<ul className="divide-y divide-border">
					{suggestions.map((suggestion) => (
						<SuggestionRow
							key={suggestion.id}
							suggestion={suggestion}
							draft={draftFor(suggestion)}
							problem={problems[suggestion.id] ?? null}
							question={
								confirmer.question?.suggestionId ===
								suggestion.id
									? confirmer.question.warning
									: null
							}
							knownEntries={knownEntries}
							organizationId={organizationId}
							confirming={
								confirmer.confirmingId === suggestion.id
							}
							dismissing={
								confirmer.dismissingId === suggestion.id
							}
							disabled={busy}
							onChange={(patch) => update(suggestion, patch)}
							onConfirm={() => {
								const fields = fieldsFor(suggestion);
								if (fields) {
									confirmer.confirm(fields);
								}
							}}
							onDismiss={() => confirmer.dismiss(suggestion.id)}
							onAnswerYes={confirmer.answerYes}
							onAnswerNo={confirmer.answerNo}
						/>
					))}
				</ul>
			) : null}
		</section>
	);
}
