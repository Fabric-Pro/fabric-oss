"use client";

import {
	FINDING_ANSWER_MAX_LENGTH,
	type FindingState,
} from "@repo/utils/proposal-artifact/finding-constants";
import { Badge, type BadgeProps } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Label } from "@ui/components/label";
import { Textarea } from "@ui/components/textarea";
import { cn } from "@ui/lib";
import { useTranslations } from "next-intl";
import {
	type MutableRefObject,
	type ReactNode,
	useCallback,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { getOrpcCode } from "../field-mapping/orpc-error";
import {
	getOrpcErrorData,
	type ProposalAnalysisActions,
	type ProposalAnalysisFinding,
	type ProposalAnalysisFindingState,
	type ProposalAnalysisResponse,
	type ProposalSavedAnswer,
} from "./use-proposal-analysis";

/** The refusal code for a finding written before stable keys existed. */
const FINDING_NOT_KEYED_CODE = "FINDING_NOT_KEYED";

/**
 * The saved answer a write names as the one the member saw: its row id and
 * version together. The server takes both or neither — neither only
 * creates — and replaces or clears only that row at that version, so an
 * answer a colleague cleared and gave again meanwhile (a new row, back at
 * version 1) is never taken for the one the member saw (Fizzy #2946).
 */
type SeenAnswer = { responseId: string; version: number };

/** The answer a write names, or null when the member saw none. */
function seenAnswer(
	answer: Pick<ProposalSavedAnswer, "id" | "version"> | null | undefined,
): SeenAnswer | null {
	return answer ? { responseId: answer.id, version: answer.version } : null;
}

/**
 * A member's unsaved answer to one finding, held by stable key above the
 * run list, so a refetch or a newer run keeps it. Its presence is what
 * keeps the finding's answer field open.
 */
export type FindingDraft = {
	stableKey: string;
	/** The finding's title when the draft was opened. */
	findingTitle: string;
	text: string;
	/**
	 * The answer the member saw when the draft was opened, by id and
	 * version; null when there was none. A refetch while the draft is open
	 * may show a colleague's newer answer — or one they cleared and gave
	 * again, at the same version — so the save names this answer, not the
	 * one shown at submit, and theirs is never replaced unseen.
	 */
	base: SeenAnswer | null;
	/** The earlier answer was a confirmation without a note. */
	previouslyConfirmed: boolean;
	/** Why the last submit was not saved; null before any. */
	conflict:
		| null
		| { reason: "RUN_CHANGED" }
		| { reason: "VERSION_CHANGED"; current: ProposalSavedAnswer | null };
};

type Translate = ReturnType<typeof useTranslations>;

/**
 * The finding the answers apply to, with what the controls need of it. A
 * finding of the shown run always has an id; the stable key is checked by
 * the caller before any action is offered.
 */
type AnswerableFinding = Pick<
	ProposalAnalysisFinding,
	"id" | "title" | "stableKey" | "state" | "response"
>;

/** The finding a member asks to apply the recommendation of. */
export type ApplyRecommendationRequest = {
	id: string;
	runId: string;
	stableKey: string;
};

/**
 * What the panel holds for every finding's controls: the drafts, the keys
 * being saved, the last inline error per key, and the actions. Kept by the
 * panel — above the run list — so a refetch or a newer run replaces the
 * findings, not the member's work.
 *
 * Every outcome is also said once in the panel's single polite live region
 * through `announce`; errors show generic copy, never the server's words.
 */
export function useFindingControls({
	actions,
	runId,
	announce,
	onApplyRecommendation,
	pendingRevisionFindingId = null,
}: {
	actions: ProposalAnalysisActions;
	/** The run the tab shows; answers are given against its findings. */
	runId: string | null;
	announce: (message: string) => void;
	/**
	 * Hands a finding's recommendation to the page, which revises its
	 * section on Main (Fizzy #2946). Without it nothing offers Apply.
	 */
	onApplyRecommendation?: (finding: ApplyRecommendationRequest) => void;
	/** The finding whose revision is under way; null when none is. */
	pendingRevisionFindingId?: string | null;
}) {
	const t = useTranslations("projects.proposalArtifact.analysis");
	const { respond, clear, pendingKeys } = actions;
	const [drafts, setDrafts] = useState<ReadonlyMap<string, FindingDraft>>(
		() => new Map(),
	);
	const [errors, setErrors] = useState<ReadonlyMap<string, string>>(
		() => new Map(),
	);

	const setDraft = useCallback(
		(stableKey: string, draft: FindingDraft | null) => {
			setDrafts((current) => {
				const next = new Map(current);
				if (draft) {
					next.set(stableKey, draft);
				} else {
					next.delete(stableKey);
				}
				return next;
			});
		},
		[],
	);

	const setError = useCallback(
		(stableKey: string, message: string | null) => {
			setErrors((current) => {
				if (!message && !current.has(stableKey)) {
					return current;
				}
				const next = new Map(current);
				if (message) {
					next.set(stableKey, message);
				} else {
					next.delete(stableKey);
				}
				return next;
			});
		},
		[],
	);

	/** Show the message under the finding and say it in the live region. */
	const fail = (stableKey: string, message: string) => {
		setError(stableKey, message);
		announce(message);
	};

	/** Generic copy for a refused or failed write; never the server's text. */
	const errorMessage = (error: unknown, fallback: string): string => {
		const code = getOrpcCode(error);
		const { code: reason } = getOrpcErrorData(error);
		if (code === "FORBIDDEN" || code === "UNAUTHORIZED") {
			return t("errors.forbidden");
		}
		if (code === "NOT_FOUND") {
			return t("errors.notFound");
		}
		if (
			code === "PRECONDITION_FAILED" &&
			reason === FINDING_NOT_KEYED_CODE
		) {
			return t("notKeyed");
		}
		if (code === "BAD_REQUEST" && reason === "textTooLong") {
			return t("errors.tooLong", {
				max: FINDING_ANSWER_MAX_LENGTH,
			});
		}
		if (code === "BAD_REQUEST" && reason === "textRequired") {
			return t("errors.required");
		}
		return fallback;
	};

	const openDraft = (finding: AnswerableFinding) => {
		if (!finding.stableKey) {
			return;
		}
		const earlier = finding.response;
		setError(finding.stableKey, null);
		setDraft(finding.stableKey, {
			stableKey: finding.stableKey,
			findingTitle: finding.title,
			text: earlier?.text ?? "",
			base: seenAnswer(earlier),
			previouslyConfirmed:
				earlier?.kind === "CONFIRMED" && !earlier.text?.trim(),
			conflict: null,
		});
	};

	const updateDraft = (stableKey: string, text: string) => {
		setDrafts((current) => {
			const draft = current.get(stableKey);
			if (!draft) {
				return current;
			}
			const next = new Map(current);
			next.set(stableKey, { ...draft, text });
			return next;
		});
	};

	const discardDraft = (stableKey: string) => {
		setDraft(stableKey, null);
		setError(stableKey, null);
	};

	/**
	 * Save the draft as the finding's answer. After a colleague's save the
	 * answer they saved is named, so "Replace with mine" overwrites exactly
	 * what the member saw — or only creates, when they cleared it; otherwise
	 * the answer the draft was opened on, so a colleague's save or clear in
	 * between answers VERSION_CHANGED instead of being replaced by an answer
	 * written without seeing it.
	 */
	const submitDraft = async (finding: AnswerableFinding) => {
		const stableKey = finding.stableKey;
		const draft = stableKey ? drafts.get(stableKey) : undefined;
		if (!stableKey || !draft || !runId) {
			return;
		}
		const seen =
			draft.conflict?.reason === "VERSION_CHANGED"
				? seenAnswer(draft.conflict.current)
				: draft.base;
		setError(stableKey, null);
		try {
			const result = await respond.mutateAsync({
				runId,
				findingId: finding.id,
				stableKey,
				kind: "RESPONDED",
				text: draft.text,
				...seen,
			});
			if (result.outcome === "written") {
				setDraft(stableKey, null);
				announce(t("announce.answered"));
				return;
			}
			setDraft(stableKey, {
				...draft,
				conflict:
					result.reason === "RUN_CHANGED"
						? { reason: "RUN_CHANGED" }
						: {
								reason: "VERSION_CHANGED",
								current: result.current,
							},
			});
			announce(
				result.reason === "RUN_CHANGED"
					? t("conflict.runChanged")
					: t("announce.versionChanged"),
			);
		} catch (error) {
			fail(stableKey, errorMessage(error, t("errors.saveFailed")));
		}
	};

	/**
	 * Confirm the finding. `confirm` records a confirmation, keeping the
	 * note of an earlier answer so nobody's words are dropped; `reaffirm`
	 * records the earlier answer again, as it stands, by the current member
	 * — for an answer that needs review or whose author lost edit rights.
	 */
	const confirmFinding = async (
		finding: AnswerableFinding,
		mode: "confirm" | "reaffirm",
	) => {
		const stableKey = finding.stableKey;
		if (!stableKey || !runId) {
			return;
		}
		const earlier = finding.response;
		// An applied recommendation is only ever written by its save, so
		// reaffirming one records a confirmation that keeps its note.
		const kind =
			mode === "reaffirm" && earlier && earlier.kind !== "RESOLVED"
				? earlier.kind
				: ("CONFIRMED" as const);
		setError(stableKey, null);
		try {
			const result = await respond.mutateAsync({
				runId,
				findingId: finding.id,
				stableKey,
				kind,
				text: earlier?.text ?? undefined,
				...seenAnswer(earlier),
			});
			if (result.outcome === "written") {
				announce(
					kind === "CONFIRMED"
						? t("announce.confirmed")
						: t("announce.answered"),
				);
				return;
			}
			fail(
				stableKey,
				result.reason === "RUN_CHANGED"
					? t("errors.runChanged")
					: t("errors.versionChanged"),
			);
		} catch (error) {
			fail(stableKey, errorMessage(error, t("errors.saveFailed")));
		}
	};

	/** Clear the answer for this key: the one the member saw, by id and version. */
	const clearAnswer = async (stableKey: string, seen: SeenAnswer) => {
		setError(stableKey, null);
		try {
			const result = await clear.mutateAsync({ stableKey, ...seen });
			if (result.outcome === "cleared") {
				announce(t("announce.cleared"));
				return;
			}
			fail(stableKey, t("errors.clearStale"));
		} catch (error) {
			fail(stableKey, errorMessage(error, t("errors.clearFailed")));
		}
	};

	/**
	 * Ask the page to apply the finding's recommendation. One revision at a
	 * time: nothing is asked while another is under way.
	 */
	const applyRecommendation = onApplyRecommendation
		? (finding: AnswerableFinding) => {
				if (!finding.stableKey || !runId || pendingRevisionFindingId) {
					return;
				}
				onApplyRecommendation({
					id: finding.id,
					runId,
					stableKey: finding.stableKey,
				});
			}
		: undefined;

	return {
		drafts,
		errors,
		pendingKeys,
		applyRecommendation,
		pendingRevisionFindingId,
		openDraft,
		updateDraft,
		discardDraft,
		submitDraft,
		confirmFinding,
		clearAnswer,
	};
}

export type FindingControls = ReturnType<typeof useFindingControls>;

const STATE_BADGE = {
	UNADDRESSED: "outline",
	CONFIRMED: "success",
	RESPONDED: "default",
	RESOLVED: "success",
	NEEDS_REVIEW: "warning",
} as const satisfies Record<FindingState, NonNullable<BadgeProps["variant"]>>;

/** A finding's or an answer's state, in words, never colour alone. */
function FindingStateChip({ state }: { state: ProposalAnalysisFindingState }) {
	const t = useTranslations("projects.proposalArtifact.analysis");
	return <Badge variant={STATE_BADGE[state]}>{t(`state.${state}`)}</Badge>;
}

/** Who gave an answer, by name; a deleted account reads as a former member. */
function authorName(
	author: ProposalAnalysisResponse["author"],
	t: Translate,
): string {
	if (!author) {
		return t("answer.formerMember");
	}
	return author.name?.trim() || t("answer.unnamedMember");
}

/**
 * Who gave a saved answer and how; an answer that needs review is the
 * earlier one, and one being saved names nobody yet.
 */
function answerByline(
	response: ProposalAnalysisResponse,
	needsReview: boolean,
	saving: boolean,
	t: Translate,
): string {
	if (saving) {
		return t("answer.saving");
	}
	const name = authorName(response.author, t);
	if (response.kind === "CONFIRMED") {
		return needsReview
			? t("answer.earlierConfirmedBy", { name })
			: t("answer.confirmedBy", { name });
	}
	if (response.kind === "RESOLVED") {
		return needsReview
			? t("answer.earlierResolvedBy", { name })
			: t("answer.resolvedBy", { name });
	}
	return needsReview
		? t("answer.earlierAnswerBy", { name })
		: t("answer.answeredBy", { name });
}

/**
 * A saved answer: who gave it and what it says. An answer that needs review
 * is labelled as the earlier one. While its write is in flight it says so
 * instead of naming anyone.
 */
function AnswerSummary({
	response,
	needsReview,
	saving,
}: {
	response: ProposalAnalysisResponse;
	needsReview: boolean;
	saving: boolean;
}) {
	const t = useTranslations("projects.proposalArtifact.analysis");
	const byline = answerByline(response, needsReview, saving, t);

	return (
		<div className="mt-2 space-y-1 rounded-md bg-muted/40 p-2 text-sm">
			<p className="text-muted-foreground text-xs">{byline}</p>
			{response.text ? (
				<p className="whitespace-pre-line">{response.text}</p>
			) : null}
		</div>
	);
}

/**
 * The answer is not applied to later generations because its author no
 * longer holds edit rights. An answer that needs review is held back for
 * that reason instead, and says so in its own words.
 */
export function answerAuthorLostRights(
	response: Pick<ProposalAnalysisResponse, "settledSkipReason"> | null,
	needsReview: boolean,
): boolean {
	return !needsReview && response?.settledSkipReason === "AUTHOR_RIGHTS";
}

/** Says an answer is not applied because its author lost edit rights. */
function AuthorRightsNote() {
	const t = useTranslations("projects.proposalArtifact.analysis");
	return <p className="text-muted-foreground text-xs">{t("authorRights")}</p>;
}

/**
 * Where an answer stands, for a finding of the shown run and for one no
 * longer raised alike: the state chip, why it needs review, the saved
 * answer, and whether its author lost edit rights. Rendered as siblings, so
 * the caller's spacing lays them out.
 */
export function AnswerStatus({
	state,
	reason,
	response,
	saving,
	authorLostRights,
}: {
	state: ProposalAnalysisFindingState;
	reason: ProposalAnalysisFinding["reason"];
	response: ProposalAnalysisResponse | null;
	saving: boolean;
	authorLostRights: boolean;
}) {
	const t = useTranslations("projects.proposalArtifact.analysis");
	const needsReview = state === "NEEDS_REVIEW";
	return (
		<>
			<div className="flex flex-wrap items-center gap-2">
				<FindingStateChip state={state} />
				{needsReview && reason ? (
					<span className="text-muted-foreground text-xs">
						{t(`reason.${reason}`)}
					</span>
				) : null}
			</div>
			{response ? (
				<AnswerSummary
					response={response}
					needsReview={needsReview}
					saving={saving}
				/>
			) : null}
			{authorLostRights ? <AuthorRightsNote /> : null}
		</>
	);
}

/** Finds, once an action settled, the element focus should move to. */
type FocusTarget = () => HTMLElement | null | undefined;

/**
 * Wraps a member's action so that, once it settled and the page shows its
 * outcome, focus that fell to the page — the control used was replaced or
 * removed — moves to the element `findTarget` names then. Focus anywhere
 * else stays where the member put it, and nothing but the member's own
 * action triggers this: a refetch never moves focus.
 *
 * Call it in a component that outlives the control: the target is looked up
 * after the action settled, by which time the control may be gone.
 */
export function useFocusAfterAction() {
	const [request, setRequest] = useState<{ findTarget: FocusTarget } | null>(
		null,
	);

	useEffect(() => {
		if (!request) {
			return;
		}
		const active = document.activeElement;
		if (active && active !== document.body) {
			return;
		}
		request.findTarget()?.focus();
	}, [request]);

	return useCallback(
		(run: () => unknown, findTarget: FocusTarget) => async () => {
			await run();
			setRequest({ findTarget });
		},
		[],
	);
}

/** The first enabled control left in a finding's controls, else its item. */
function firstControlOf(root: HTMLElement | null): HTMLElement | null {
	if (!root) {
		return null;
	}
	return (
		root.querySelector<HTMLElement>(
			"button:not(:disabled), textarea:not(:disabled)",
		) ?? root.closest<HTMLElement>("li[tabindex='-1']")
	);
}

/**
 * The answer controls of one finding (Fizzy #2946): its saved answer, why it
 * needs review, and — for a member with edit rights — the actions its state
 * allows and the answer field.
 *
 * | State        | Actions                                   |
 * |--------------|-------------------------------------------|
 * | Unaddressed  | Confirm, Answer                           |
 * | Confirmed    | Answer, Clear                             |
 * | Responded    | Edit answer, Confirm, Clear               |
 * | Resolved     | Answer, Clear                             |
 * | Needs Review | Confirm again, Answer again, Clear        |
 *
 * Confirmed and Resolved add Confirm when the answer's author lost edit
 * rights. A finding the server says can be applied (`canApply`) also offers
 * Apply recommendation; while its revision is under way it says so and its
 * other actions wait, and no other finding's Apply is offered meanwhile.
 *
 * A finding written before stable keys existed cannot be answered; it says
 * a re-run gives it one. An answer whose author no longer holds edit rights
 * is not applied to later generations until a member confirms it again.
 *
 * Confirm, Clear, Save and Cancel each replace the control that was used,
 * so once the action settles, focus that fell to the page returns to this
 * finding's first remaining control. Only the member's own action moves
 * it: a refetch never does, and focus the member moved elsewhere stays.
 */
export function FindingResponseControls({
	finding,
	controls,
	canEdit,
	titleId,
}: {
	finding: ProposalAnalysisFinding;
	controls: FindingControls;
	canEdit: boolean;
	/** The finding title's element id, describing each action. */
	titleId: string;
}) {
	const t = useTranslations("projects.proposalArtifact.analysis");
	const focusRequested = useRef(false);
	const rootRef = useRef<HTMLDivElement>(null);
	const focusAfter = useFocusAfterAction();
	const restoreFocus = (run: () => unknown) =>
		focusAfter(run, () => firstControlOf(rootRef.current));
	const stableKey = finding.stableKey;
	const response = finding.response;
	const needsReview = finding.state === "NEEDS_REVIEW";
	const saving = stableKey ? controls.pendingKeys.has(stableKey) : false;
	const draft = stableKey ? controls.drafts.get(stableKey) : undefined;
	const error = stableKey ? controls.errors.get(stableKey) : undefined;
	const authorLostRights = answerAuthorLostRights(response, needsReview);
	const revisionPending = controls.pendingRevisionFindingId === finding.id;
	const anyRevisionPending = controls.pendingRevisionFindingId != null;
	const busy = saving || revisionPending;

	const openEditor = () => {
		focusRequested.current = true;
		controls.openDraft(finding);
	};

	const action = (
		label: string,
		onClick: () => unknown,
		variant: "outline" | "ghost" = "outline",
	) => (
		<Button
			type="button"
			size="sm"
			variant={variant}
			onClick={onClick}
			disabled={busy}
			aria-describedby={titleId}
		>
			{label}
		</Button>
	);

	const confirm = () =>
		action(
			t("actions.confirm"),
			restoreFocus(() =>
				controls.confirmFinding(
					finding,
					authorLostRights ? "reaffirm" : "confirm",
				),
			),
		);
	const clearAction = (key: string) =>
		response
			? action(
					t("actions.clear"),
					restoreFocus(() =>
						controls.clearAnswer(key, {
							responseId: response.id,
							version: response.version,
						}),
					),
					"ghost",
				)
			: null;

	let actions: ReactNode = null;
	if (canEdit && stableKey && !draft) {
		switch (finding.state) {
			case "UNADDRESSED":
				actions = (
					<>
						{confirm()}
						{action(t("actions.answer"), openEditor)}
					</>
				);
				break;
			case "CONFIRMED":
			case "RESOLVED":
				actions = (
					<>
						{authorLostRights ? confirm() : null}
						{action(t("actions.answer"), openEditor)}
						{clearAction(stableKey)}
					</>
				);
				break;
			case "RESPONDED":
				actions = (
					<>
						{action(t("actions.editAnswer"), openEditor)}
						{confirm()}
						{clearAction(stableKey)}
					</>
				);
				break;
			case "NEEDS_REVIEW":
				actions = (
					<>
						{action(
							t("actions.confirmAgain"),
							restoreFocus(() =>
								controls.confirmFinding(finding, "reaffirm"),
							),
						)}
						{action(t("actions.answerAgain"), openEditor)}
						{clearAction(stableKey)}
					</>
				);
				break;
		}
	}

	const applyRecommendation = controls.applyRecommendation;
	const apply =
		canEdit &&
		stableKey &&
		!draft &&
		finding.canApply &&
		applyRecommendation ? (
			<Button
				type="button"
				size="sm"
				variant="secondary"
				onClick={() => applyRecommendation(finding)}
				disabled={saving || anyRevisionPending}
				loading={revisionPending}
				aria-busy={revisionPending || undefined}
				aria-describedby={titleId}
			>
				{t("actions.applyRecommendation")}
			</Button>
		) : null;

	return (
		<div
			ref={rootRef}
			className="mt-2 space-y-2"
			aria-busy={revisionPending || undefined}
		>
			<AnswerStatus
				state={finding.state}
				reason={finding.reason}
				response={response}
				saving={saving}
				authorLostRights={authorLostRights}
			/>
			{canEdit && !finding.keyed ? (
				<p className="text-muted-foreground text-xs">{t("notKeyed")}</p>
			) : null}
			{revisionPending ? (
				<p className="text-muted-foreground text-sm">
					{t("revisionInProgress")}
				</p>
			) : null}
			{actions || apply ? (
				<div className="flex flex-wrap items-center gap-2">
					{apply}
					{actions}
				</div>
			) : null}
			{canEdit && stableKey && draft ? (
				<AnswerEditor
					draft={draft}
					saving={saving}
					focusRequested={focusRequested}
					onChange={(text) => controls.updateDraft(stableKey, text)}
					onSubmit={restoreFocus(() => controls.submitDraft(finding))}
					onDiscard={restoreFocus(() =>
						controls.discardDraft(stableKey),
					)}
				/>
			) : null}
			{error ? <p className="text-destructive text-sm">{error}</p> : null}
		</div>
	);
}

/**
 * The plain-text answer field, with a counter at the server's limit. After
 * a stale save it keeps the draft and says why: the analysis changed (apply
 * it to the current finding) or a colleague saved meanwhile (their answer
 * beside the draft, and "Replace with mine").
 */
function AnswerEditor({
	draft,
	saving,
	focusRequested,
	onChange,
	onSubmit,
	onDiscard,
}: {
	draft: FindingDraft;
	saving: boolean;
	focusRequested?: MutableRefObject<boolean>;
	onChange: (text: string) => void;
	onSubmit: () => unknown;
	onDiscard: () => void;
}) {
	const t = useTranslations("projects.proposalArtifact.analysis");
	const fieldId = useId();
	const counterId = useId();
	const length = draft.text.length;
	const tooLong = length > FINDING_ANSWER_MAX_LENGTH;
	const empty = draft.text.trim().length === 0;
	const conflict = draft.conflict;

	const submitLabel =
		conflict?.reason === "VERSION_CHANGED"
			? t("actions.replaceWithMine")
			: conflict?.reason === "RUN_CHANGED"
				? t("actions.apply")
				: t("actions.save");

	return (
		<div className="space-y-2 rounded-md border border-border p-3">
			{conflict?.reason === "RUN_CHANGED" ? (
				<p className="text-sm">{t("conflict.runChanged")}</p>
			) : null}
			{conflict?.reason === "VERSION_CHANGED" ? (
				<TheirAnswer current={conflict.current} />
			) : null}
			{draft.previouslyConfirmed ? (
				<p className="text-muted-foreground text-xs">
					{t("editor.previouslyConfirmed")}
				</p>
			) : null}
			<Label htmlFor={fieldId}>
				{conflict?.reason === "VERSION_CHANGED"
					? t("editor.yourDraft")
					: t("editor.label")}
			</Label>
			<Textarea
				id={fieldId}
				ref={(element) => {
					if (element && focusRequested?.current) {
						focusRequested.current = false;
						element.focus();
					}
				}}
				value={draft.text}
				onChange={(event) => onChange(event.target.value)}
				rows={3}
				aria-describedby={counterId}
				aria-invalid={tooLong || undefined}
				disabled={saving}
			/>
			<p
				id={counterId}
				className={cn(
					"text-xs",
					tooLong ? "text-destructive" : "text-muted-foreground",
				)}
			>
				{t("editor.counter", {
					count: length,
					max: FINDING_ANSWER_MAX_LENGTH,
				})}
				{tooLong
					? ` ${t("errors.tooLong", { max: FINDING_ANSWER_MAX_LENGTH })}`
					: null}
			</p>
			<div className="flex flex-wrap items-center gap-2">
				<Button
					type="button"
					size="sm"
					onClick={onSubmit}
					disabled={empty || tooLong}
					loading={saving}
				>
					{submitLabel}
				</Button>
				<Button
					type="button"
					size="sm"
					variant="ghost"
					onClick={onDiscard}
					disabled={saving}
				>
					{conflict?.reason === "VERSION_CHANGED"
						? t("actions.keepTheirs")
						: t("actions.cancel")}
				</Button>
			</div>
		</div>
	);
}

/** The answer a colleague saved while the member was writing theirs. */
function TheirAnswer({ current }: { current: ProposalSavedAnswer | null }) {
	const t = useTranslations("projects.proposalArtifact.analysis");
	if (!current) {
		return <p className="text-sm">{t("conflict.versionCleared")}</p>;
	}
	const name = authorName(current.author, t);
	return (
		<div className="space-y-1 rounded-md bg-muted/40 p-2 text-sm">
			<p className="font-medium">
				{t("conflict.versionChanged", { name })}
			</p>
			<p className="text-muted-foreground text-xs">
				{t(`state.${current.kind}`)}
			</p>
			{current.text ? (
				<p className="whitespace-pre-line">{current.text}</p>
			) : null}
		</div>
	);
}
