"use client";

import { Button } from "@ui/components/button";
import { Checkbox } from "@ui/components/checkbox";
import { Label } from "@ui/components/label";
import { cn } from "@ui/lib";
import { ChevronDownIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { readContentTypeBuckets } from "./generation-tab-state";
import type { PlanningAnalysisDocument } from "./planning-analysis-content";
import { POST_TYPE_LABELS, type PostType } from "./topic-shared";

/**
 * When the suggestion engine began recommending formats at all.
 *
 * `suggestedPostTypes` started populating on 2026-07-18 and
 * `postTypeRecommendations` on 07-23; this is the later of the two, so a topic
 * created before it could not have carried either.
 *
 * It exists to separate two states that look identical and mean opposite
 * things: "the analysis considered the formats and recommended none" and "this
 * topic is older than the feature that recommends them". Sixteen topics sat
 * near the top of the queue showing an empty picker, which is what the card
 * owner reported as broken (`found-defects.md` §4). A date is the only signal
 * that can tell them apart — the absence of recommendations is identical in
 * both.
 */
const RECOMMENDATIONS_AVAILABLE_FROM = new Date("2026-07-23T00:00:00.000Z");

/**
 * Which formats to produce for a topic — as a list, not a dialog.
 *
 * The card owner's words: *"its simple setting, not question, it could be
 * checkbox"*, and later *"i dont think modal is a good fit here, maybe it could
 * be just list with checkboxes"*. Both are the same complaint from two
 * directions, and this is the one control that answers both:
 *
 *  - It replaces the modal on the topic page. A choice you revisit while
 *    reading the questions beside it should not live behind a button that
 *    hides the thing you are deciding about.
 *  - It replaces the CONTENT_TYPE questions. "Should we produce a LinkedIn
 *    Post for this topic?" is this checkbox wearing a question's clothes —
 *    and it was ALSO one of the two producers asking about LinkedIn twice.
 *    Ticking a box is the answer; asking for it again is not.
 *
 * The AI's reasoning sits ON the choice rather than being re-asked underneath
 * it, grouped by the verdict the analysis reached. A format the analysis
 * deferred is still selectable — the classification is advice, and the whole
 * point of a setting is that the person decides.
 *
 * COLLAPSED once a choice exists, expanded when none has been made. A decision
 * already taken should not occupy a screen of vertical space above the
 * questions that still need one, and the header carries the answer so
 * collapsing costs no information.
 */
export function ContentTypesChecklist({
	analysis,
	selected,
	canEdit,
	isPending,
	createdAt,
	onChange,
}: {
	analysis: PlanningAnalysisDocument | null;
	/** The topic's effective post types — the override when set, else the AI's. */
	selected: readonly PostType[];
	canEdit: boolean;
	isPending?: boolean;
	/** When the topic was created — see `RECOMMENDATIONS_AVAILABLE_FROM`. */
	createdAt?: Date | string | null;
	/** `null` resets to the AI's suggestion; an array is an explicit override. */
	onChange: (postTypes: PostType[] | null) => void;
}) {
	const buckets = readContentTypeBuckets(analysis);
	const chosen = new Set(selected);

	/**
	 * Open only while nothing has been chosen.
	 *
	 * Seeded once and then owned by the reader: re-deriving it from `selected`
	 * would slam the panel shut under the hand of someone who has just ticked
	 * their first box and is still choosing.
	 */
	const [open, setOpen] = useState(selected.length === 0);
	const [touched, setTouched] = useState(false);
	useEffect(() => {
		if (!touched) {
			setOpen(selected.length === 0);
		}
	}, [selected.length, touched]);

	const toggle = (postType: PostType, checked: boolean) => {
		setTouched(true);
		const next = new Set(chosen);
		if (checked) {
			next.add(postType);
		} else {
			next.delete(postType);
		}
		onChange(
			POST_TYPE_LABELS.map((p) => p.value).filter((v) => next.has(v)),
		);
	};

	const groups = [
		{
			key: "recommended" as const,
			label: "Recommended",
			empty: null,
		},
		{
			key: "needsConfirmation" as const,
			label: "Needs your call",
			empty: null,
		},
		{
			key: "deferred" as const,
			label: "Deferred — the analysis found no evidence for these",
			empty: null,
		},
	];

	// Anything the analysis never classified. Every manual topic is entirely in
	// here, as is every topic from before the buckets existed — so the list can
	// never be empty just because an analysis has not run.
	const unclassified = POST_TYPE_LABELS.filter(
		(p) => !buckets.has(p.value),
	).map((p) => p.value);

	const summary =
		selected.length === 0
			? "None chosen yet"
			: POST_TYPE_LABELS.filter((p) => chosen.has(p.value))
					.map((p) => p.label)
					.join(" · ");

	// An empty list on an old topic is not the analysis declining — it is a
	// topic from before there was anything to decline with. Only said when
	// there is genuinely nothing classified, since a topic with buckets is
	// explaining itself already.
	const created = createdAt ? new Date(createdAt) : null;
	const predatesRecommendations =
		buckets.size === 0 &&
		created !== null &&
		!Number.isNaN(created.getTime()) &&
		created < RECOMMENDATIONS_AVAILABLE_FROM;

	return (
		<section className="rounded-xl border border-border bg-card">
			<button
				type="button"
				onClick={() => {
					setTouched(true);
					setOpen((v) => !v);
				}}
				aria-expanded={open}
				className="flex w-full items-center gap-3 px-4 py-3 text-left"
			>
				<span className="editorial-label shrink-0">Content types</span>
				<span className="min-w-0 flex-1 truncate text-muted-foreground text-sm">
					{summary}
				</span>
				<ChevronDownIcon
					className={cn(
						"size-4 shrink-0 text-muted-foreground transition-transform duration-200",
						open && "rotate-180",
					)}
					aria-hidden="true"
				/>
			</button>

			{open ? (
				<div className="space-y-1 border-border border-t px-4 py-3">
					{predatesRecommendations ? (
						<p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-muted-foreground text-xs leading-relaxed">
							This topic was created before the suite started
							recommending formats, so there is nothing to
							recommend here — not because the analysis considered
							them and declined. Choose whichever apply.
						</p>
					) : null}
					{groups.map((group) => {
						const rows = POST_TYPE_LABELS.filter(
							(p) => buckets.get(p.value)?.bucket === group.key,
						);
						if (rows.length === 0) {
							return null;
						}
						return (
							<div key={group.key}>
								<p className="pt-3 pb-1 text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
									{group.label}
								</p>
								{rows.map((p) => (
									<ChecklistRow
										key={p.value}
										label={p.label}
										rationale={
											buckets.get(p.value)?.rationale ??
											null
										}
										checked={chosen.has(p.value)}
										dimmed={group.key === "deferred"}
										disabled={
											!canEdit || isPending === true
										}
										onCheckedChange={(c) =>
											toggle(p.value, c)
										}
									/>
								))}
							</div>
						);
					})}

					{unclassified.length > 0 ? (
						<div>
							<p className="pt-3 pb-1 text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
								{buckets.size === 0
									? "Available"
									: "Not classified by the analysis"}
							</p>
							{POST_TYPE_LABELS.filter((p) =>
								unclassified.includes(p.value),
							).map((p) => (
								<ChecklistRow
									key={p.value}
									label={p.label}
									rationale={null}
									checked={chosen.has(p.value)}
									dimmed={false}
									disabled={!canEdit || isPending === true}
									onCheckedChange={(c) => toggle(p.value, c)}
								/>
							))}
						</div>
					) : null}

					{canEdit ? (
						<div className="pt-3">
							{/* The reset the dialog had. Without it an override
							    is one-way: once a person has ticked anything,
							    nothing can hand the topic back to the AI's own
							    recommendation. */}
							<Button
								type="button"
								variant="ghost"
								size="sm"
								disabled={isPending}
								onClick={() => {
									setTouched(true);
									onChange(null);
								}}
							>
								Reset to the AI's suggestion
							</Button>
						</div>
					) : null}
				</div>
			) : null}
		</section>
	);
}

function ChecklistRow({
	label,
	rationale,
	checked,
	dimmed,
	disabled,
	onCheckedChange,
}: {
	label: string;
	rationale: string | null;
	checked: boolean;
	dimmed: boolean;
	disabled: boolean;
	onCheckedChange: (checked: boolean) => void;
}) {
	const id = `content-type-${label.replace(/\s+/g, "-").toLowerCase()}`;
	return (
		<Label
			htmlFor={id}
			className={cn(
				"flex items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors",
				checked
					? "border-primary/50 bg-primary/5"
					: "border-transparent",
				dimmed && !checked && "opacity-60",
				disabled
					? "cursor-not-allowed"
					: "cursor-pointer hover:bg-accent",
			)}
		>
			<Checkbox
				id={id}
				checked={checked}
				disabled={disabled}
				onCheckedChange={(c) => onCheckedChange(c === true)}
				className="mt-0.5"
			/>
			<span className="min-w-0">
				<span className="block font-medium text-sm">{label}</span>
				{rationale ? (
					<span className="block text-muted-foreground text-xs leading-relaxed">
						{rationale}
					</span>
				) : null}
			</span>
		</Label>
	);
}
