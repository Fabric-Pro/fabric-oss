"use client";

/**
 * Proposals dialog (G7) — presentational. Lists each proposal the AI
 * false-positive review produced (verdict, reasoning, confidence, evidence
 * quote, suggested action). The user checks which suggestions to apply, then
 * confirms; nothing is auto-applied.
 *
 * Copy follows the AI copy-tone standard: calm, advisory, the user decides.
 * This component owns NO data fetching — the parent passes the resolved review
 * and the apply handler, so it's trivially testable.
 */

import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Checkbox } from "@ui/components/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { cn } from "@ui/lib";
import {
	CheckCircle2Icon,
	HelpCircleIcon,
	ListChecksIcon,
	Loader2Icon,
	QuoteIcon,
	ShieldCheckIcon,
	SparklesIcon,
	SquareIcon,
} from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import {
	PROPOSAL_CONFIDENCE_LABEL,
	type ProposalConfidence,
	REVIEW_VERDICT_BADGE_VARIANT,
	REVIEW_VERDICT_LABEL,
	type ReviewVerdict,
	type ScanFindingReview,
	type ScanFindingReviewProposal,
	type ScanSeverity,
	SEVERITY_LABEL,
} from "./lib";

/** A decision the user chose to apply (passed back to `review.apply`). */
export type ReviewDecision = {
	findingId: string;
	status?: "DISMISSED";
	severity?: ScanSeverity;
};

/** Title lookup so a proposal can show the human finding title, not just an id. */
export type FindingTitleLookup = (findingId: string) => string | undefined;

/**
 * A proposal is "actionable" when it suggests a concrete change the user can
 * apply (dismiss as a false positive, or adjust severity). Confirmed/uncertain
 * proposals with no suggestion are informational only — shown, never auto-checked.
 *
 * Exported so the selection-toolbar logic and its tests share the exact same
 * "is this actionable?" definition as the rows.
 */
function proposalSuggestion(
	p: ScanFindingReviewProposal,
): ReviewDecision | null {
	const decision: ReviewDecision = { findingId: p.findingId };
	let actionable = false;
	if (p.suggestedStatus === "DISMISSED") {
		decision.status = "DISMISSED";
		actionable = true;
	}
	if (p.suggestedSeverity) {
		decision.severity = p.suggestedSeverity as ScanSeverity;
		actionable = true;
	}
	return actionable ? decision : null;
}

/**
 * A proposal is a "false positive" suggestion when the review flagged it for
 * dismissal — verdict `false_positive` and/or a suggested DISMISSED status. The
 * "Select false positives" quick action targets exactly these.
 */
function isFalsePositiveSuggestion(p: ScanFindingReviewProposal): boolean {
	return p.suggestedStatus === "DISMISSED" || p.verdict === "false_positive";
}

export function ReviewProposalsDialog({
	open,
	onOpenChange,
	review,
	getFindingTitle,
	isApplying,
	onApply,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	review: ScanFindingReview | null;
	getFindingTitle: FindingTitleLookup;
	isApplying: boolean;
	onApply: (decisions: ReviewDecision[]) => void;
}) {
	const proposals = useMemo(() => review?.proposals ?? [], [review]);

	// Which findingIds the user has checked to apply. Seed with every
	// actionable proposal pre-checked (the common case is "apply the
	// suggestions"), but the user can uncheck any before applying.
	const [selected, setSelected] = useState<Set<string>>(new Set());

	useEffect(() => {
		if (!open) {
			return;
		}
		const next = new Set<string>();
		for (const p of proposals) {
			if (proposalSuggestion(p)) {
				next.add(p.findingId);
			}
		}
		setSelected(next);
	}, [open, proposals]);

	const actionable = useMemo(
		() => proposals.filter((p) => proposalSuggestion(p) !== null),
		[proposals],
	);

	// The actionable false-positive (dismiss) suggestions — the target of the
	// "Select false positives" quick action.
	const falsePositives = useMemo(
		() => actionable.filter((p) => isFalsePositiveSuggestion(p)),
		[actionable],
	);

	const toggle = (findingId: string) => {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(findingId)) {
				next.delete(findingId);
			} else {
				next.add(findingId);
			}
			return next;
		});
	};

	// Bulk selection — all operate on the ACTIONABLE proposals (informational
	// rows have nothing to apply, so they're never selected).
	const selectAll = () =>
		setSelected(new Set(actionable.map((p) => p.findingId)));
	const selectNone = () => setSelected(new Set());
	const selectFalsePositives = () =>
		setSelected(new Set(falsePositives.map((p) => p.findingId)));

	const handleApply = () => {
		const decisions: ReviewDecision[] = [];
		for (const p of proposals) {
			if (!selected.has(p.findingId)) {
				continue;
			}
			const suggestion = proposalSuggestion(p);
			if (suggestion) {
				decisions.push(suggestion);
			}
		}
		onApply(decisions);
	};

	const selectedActionableCount = actionable.filter((p) =>
		selected.has(p.findingId),
	).length;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
				<DialogHeader className="shrink-0 space-y-1.5 border-border border-b px-6 py-4">
					<DialogTitle className="flex items-center gap-2">
						<SparklesIcon
							aria-hidden="true"
							className="size-4 text-primary"
						/>
						Review suggestions
					</DialogTitle>
					<DialogDescription>
						Suggested changes are ready for your review. Nothing is
						applied until you choose. The review looks at each open
						finding fresh and flags ones that may be false
						positives.
					</DialogDescription>
				</DialogHeader>

				{actionable.length > 0 ? (
					<SelectionToolbar
						selectedCount={selectedActionableCount}
						actionableCount={actionable.length}
						falsePositiveCount={falsePositives.length}
						disabled={isApplying}
						onSelectAll={selectAll}
						onSelectNone={selectNone}
						onSelectFalsePositives={selectFalsePositives}
					/>
				) : null}

				<div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
					{proposals.length === 0 ? (
						<EmptyReview />
					) : (
						<ul className="space-y-3">
							{proposals.map((p) => (
								<ProposalRow
									key={p.findingId}
									proposal={p}
									title={getFindingTitle(p.findingId)}
									checked={selected.has(p.findingId)}
									onToggle={() => toggle(p.findingId)}
								/>
							))}
						</ul>
					)}
				</div>

				<DialogFooter className="shrink-0 flex-row items-center justify-between gap-3 border-border border-t px-6 py-4">
					{/* Visible supplementary count. The single announced source of
					    selection status is the toolbar's aria-live region, so this
					    footer text is not also live (avoids double-announcing). */}
					<p className="text-muted-foreground text-xs">
						{actionable.length === 0
							? "No changes suggested."
							: `${selectedActionableCount} of ${actionable.length} suggested change${
									actionable.length === 1 ? "" : "s"
								} selected.`}
					</p>
					<div className="flex items-center gap-2">
						<Button
							variant="outline"
							onClick={() => onOpenChange(false)}
							disabled={isApplying}
						>
							Cancel
						</Button>
						<Button
							onClick={handleApply}
							disabled={
								isApplying || selectedActionableCount === 0
							}
							className="gap-2"
						>
							{isApplying ? (
								<Loader2Icon
									aria-hidden="true"
									className="size-4 motion-safe:animate-spin"
								/>
							) : (
								<CheckCircle2Icon
									aria-hidden="true"
									className="size-4"
								/>
							)}
							Apply selected
						</Button>
					</div>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/**
 * Quick-action toolbar above the proposals list (G7). Lets the user bulk-select
 * — everything, nothing, or just the likely false positives — so reviewing the
 * whole batch (or dismissing all false positives) is one click, not N. It sits
 * between the header and the scroll region (non-shrinking) so it's always
 * visible while the list scrolls underneath. All actions operate on the
 * ACTIONABLE proposals; informational rows have nothing to apply.
 */
function SelectionToolbar({
	selectedCount,
	actionableCount,
	falsePositiveCount,
	disabled,
	onSelectAll,
	onSelectNone,
	onSelectFalsePositives,
}: {
	selectedCount: number;
	actionableCount: number;
	falsePositiveCount: number;
	disabled: boolean;
	onSelectAll: () => void;
	onSelectNone: () => void;
	onSelectFalsePositives: () => void;
}) {
	const allSelected = selectedCount === actionableCount;
	const noneSelected = selectedCount === 0;
	return (
		<div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-border border-b bg-muted/30 px-6 py-2.5">
			<span
				className="font-medium text-foreground text-xs tabular-nums"
				aria-live="polite"
			>
				{selectedCount} of {actionableCount} selected
			</span>
			<div className="ml-auto flex flex-wrap items-center gap-1.5">
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="h-7 gap-1.5 px-2 text-xs"
					disabled={disabled || allSelected}
					onClick={onSelectAll}
				>
					<ListChecksIcon aria-hidden="true" className="size-3.5" />
					Select all
				</Button>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="h-7 gap-1.5 px-2 text-xs"
					disabled={disabled || noneSelected}
					onClick={onSelectNone}
				>
					<SquareIcon aria-hidden="true" className="size-3.5" />
					Select none
				</Button>
				{falsePositiveCount > 0 ? (
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="h-7 gap-1.5 px-2 text-xs"
						disabled={disabled}
						onClick={onSelectFalsePositives}
					>
						<SparklesIcon
							aria-hidden="true"
							className="size-3.5 text-primary"
						/>
						Select false positives ({falsePositiveCount})
					</Button>
				) : null}
			</div>
		</div>
	);
}

function ProposalRow({
	proposal,
	title,
	checked,
	onToggle,
}: {
	proposal: ScanFindingReviewProposal;
	title: string | undefined;
	checked: boolean;
	onToggle: () => void;
}) {
	const checkboxId = useId();
	const verdict = proposal.verdict as ReviewVerdict;
	const suggestion = proposalSuggestion(proposal);
	const confidence = proposal.confidence as ProposalConfidence | undefined;

	return (
		<li className="rounded-lg border border-border bg-card p-3.5">
			<div className="flex items-start gap-3">
				{suggestion ? (
					<Checkbox
						id={checkboxId}
						checked={checked}
						onCheckedChange={onToggle}
						aria-label={`Apply suggestion for ${title ?? "this finding"}`}
						className="mt-1"
					/>
				) : (
					// Informational-only proposal: keep the row aligned but
					// render no checkbox (nothing to apply).
					<span aria-hidden="true" className="mt-1 size-4 shrink-0" />
				)}

				<div className="min-w-0 flex-1 space-y-2">
					<div className="flex flex-wrap items-center gap-2">
						<Badge variant={REVIEW_VERDICT_BADGE_VARIANT[verdict]}>
							{REVIEW_VERDICT_LABEL[verdict]}
						</Badge>
						{confidence ? (
							<span className="text-muted-foreground text-xs">
								{PROPOSAL_CONFIDENCE_LABEL[confidence]}{" "}
								confidence
							</span>
						) : null}
					</div>

					<label
						htmlFor={suggestion ? checkboxId : undefined}
						className={cn(
							"block break-words font-medium text-foreground text-sm leading-snug",
							suggestion && "cursor-pointer",
						)}
					>
						{title ?? "Finding"}
					</label>

					<p className="break-words text-muted-foreground text-sm leading-relaxed">
						{proposal.reasoning}
					</p>

					{proposal.evidenceQuote ? (
						<blockquote className="flex gap-1.5 border-border border-l-2 pl-2.5 text-muted-foreground text-xs italic">
							<QuoteIcon
								aria-hidden="true"
								className="mt-0.5 size-3 shrink-0"
							/>
							<span className="break-words">
								{proposal.evidenceQuote}
							</span>
						</blockquote>
					) : null}

					<SuggestionLine verdict={verdict} suggestion={suggestion} />
				</div>
			</div>
		</li>
	);
}

/** The "what would change" line for a proposal — advisory, never imperative. */
function SuggestionLine({
	verdict,
	suggestion,
}: {
	verdict: ReviewVerdict;
	suggestion: ReviewDecision | null;
}) {
	if (suggestion) {
		const parts: string[] = [];
		if (suggestion.status === "DISMISSED") {
			parts.push("dismiss as a false positive");
		}
		if (suggestion.severity) {
			parts.push(
				`change severity to ${SEVERITY_LABEL[suggestion.severity]}`,
			);
		}
		return (
			<p className="flex items-center gap-1.5 text-foreground text-xs">
				<SparklesIcon
					aria-hidden="true"
					className="size-3 text-primary"
				/>
				<span>
					<span className="font-medium">Suggested:</span>{" "}
					{parts.join(" and ")}
				</span>
			</p>
		);
	}
	if (verdict === "confirmed") {
		return (
			<p className="flex items-center gap-1.5 text-muted-foreground text-xs">
				<ShieldCheckIcon
					aria-hidden="true"
					className="size-3 text-secondary"
				/>
				Looks like a real finding — no change suggested.
			</p>
		);
	}
	return (
		<p className="flex items-center gap-1.5 text-muted-foreground text-xs">
			<HelpCircleIcon aria-hidden="true" className="size-3" />
			Couldn't tell — left for you to decide.
		</p>
	);
}

function EmptyReview() {
	return (
		<div className="rounded-lg border border-dashed border-border bg-muted/30 px-6 py-10 text-center">
			<p className="text-muted-foreground text-sm">
				No suggestions this time — the review didn't flag any open
				findings as likely false positives.
			</p>
		</div>
	);
}
