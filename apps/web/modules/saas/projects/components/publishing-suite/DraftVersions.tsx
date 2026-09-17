"use client";

import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { formatDistanceToNowStrict } from "date-fns";
import { HistoryIcon } from "lucide-react";
import { useId, useState } from "react";
import { readCandidateRefinement } from "./DraftComparison";

/**
 * The versions of one content type, and a way back into an older one.
 *
 * A panel headed "Generated draft (version 2)" had no version 1 to open. Every
 * attempt row always persisted; `listTopicDrafts` folded them to
 * `latestAttempt` / `latestReady` and nothing else could reach them, so the
 * version number was a count of runs rather than a place you could go.
 *
 * Deliberately not a second History drawer. The Planning & Analysis tab has one
 * of those, and a third implementation of "list of versions" is what the
 * reviewer objected to in the first place — this is a short inline list under
 * the draft it belongs to, which is where the question "what did the last one
 * say?" is actually asked.
 *
 * ── Why a refinement is listed but cannot be adopted from here ───────────────
 *
 * A refine goes through `startTopicDraftAttempt` like any other generation, so
 * it consumes a version number and lands in `versions[]`. It is not an
 * alternative draft, though: it is the saved draft with the changes that were
 * asked for, and those changes are accepted ONE AT A TIME in the refined-draft
 * review. Offering adopt on such a row is a way to take every change at once —
 * including the ones the reader was on their way to rejecting — and it is one
 * click from a list that otherwise says nothing about what the row is.
 *
 * So the adopt control is withheld on those rows, in the card AND in the
 * version dialog's footer, and the row says what it is instead. A control that
 * silently vanishes is what sent a reader hunting for Restore in the first
 * place.
 */
export type DraftVersion = {
	id: string;
	version: number;
	createdAt: Date | string;
	/**
	 * The stored document, read ONLY to tell a refinement from an ordinary
	 * candidate. Optional and `unknown` because that is all this list does with
	 * it — the panels own the per-content-type shape, and each one already
	 * passes rows carrying this field for its own `renderBody`.
	 */
	content?: unknown;
};

export function DraftVersions({
	versions,
	adoptedId,
	renderBody,
	onAdopt,
	isAdopting = false,
}: {
	/** Every READY generation, newest first, as the read path returns them. */
	versions: readonly DraftVersion[];
	/**
	 * The version the saved draft came from, if any — marked rather than
	 * hidden. "Which one am I holding" is the first thing this list is asked.
	 */
	adoptedId?: string | null;
	/** How to show one version's text. The document shape differs per panel. */
	renderBody: (versionId: string) => React.ReactNode;
	/**
	 * Adopt an older version as the working draft. Omitted where a version is
	 * not a single document — the short-form panels generate several options
	 * per run, so adopting means picking one of them, which is the panel's own
	 * affordance rather than this list's.
	 */
	onAdopt?: (versionId: string) => void;
	isAdopting?: boolean;
}) {
	const [openId, setOpenId] = useState<string | null>(null);
	const [listOpen, setListOpen] = useState(false);
	// One id for the component, suffixed per version below. Each card's
	// "Version N" label is what gives its two same-named buttons their context
	// for a screen reader, via `aria-describedby` — description rather than
	// label so the buttons keep the short visible names the eye scans by.
	const labelIdPrefix = useId();

	// One version is not a history. Saying "version 1 of 1" invites a reader to
	// look for the others.
	if (versions.length < 2) {
		return null;
	}

	const open = versions.find((v) => v.id === openId) ?? null;
	// The footer's "Restore this version" is the same bypass as the card's
	// Restore, one click further in, so it needs the same guard.
	const openIsRefinement =
		open !== null && readCandidateRefinement(open.content ?? null) !== null;

	return (
		<>
			{/* A BUTTON, not a block.

			    The list was a full-width section of bordered rows sitting
			    between the draft and its candidates — a history nobody is
			    reading most of the time, given the vertical space of the thing
			    they are. Feature Maturation puts the same affordance behind
			    one small `v{N}` control in a toolbar, and that is the shape
			    this asks for: out of the way until wanted, one click away when
			    it is. */}
			<Button
				type="button"
				variant="ghost"
				size="sm"
				className="w-fit"
				onClick={() => setListOpen(true)}
			>
				<HistoryIcon className="mr-1 size-4" aria-hidden="true" />
				{`${versions.length} versions`}
			</Button>

			<Dialog
				open={listOpen}
				onOpenChange={(next) => {
					setListOpen(next);
					if (!next) {
						setOpenId(null);
					}
				}}
			>
				{/* Wider than the default 2xl ONLY here.

				    Eight runs stacked one per row read as a page that had gone
				    wrong rather than as a list — the first reaction to it was
				    "чого воно таке довге", which is a reader diagnosing a bug,
				    not reading content. Three columns make the count legible
				    at a glance instead of by scrolling. The version DETAIL
				    dialog below stays 2xl on purpose: it renders prose, and
				    prose gets worse as the measure gets wider. */}
				<DialogContent className="max-h-[85vh] max-w-4xl overflow-y-auto">
					<DialogHeader>
						<DialogTitle>Earlier versions</DialogTitle>
						<DialogDescription>
							{onAdopt
								? "Every run this content type has had. Restoring one brings its text back as your working draft — every other version stays right here, so nothing is lost by looking."
								: "Every run this content type has had. Open a version to take one of its drafts — your saved draft is untouched until you do."}
						</DialogDescription>
					</DialogHeader>
					{/* Viewport breakpoints, not container queries: this grid
					    only ever lives in a dialog whose own width is a
					    function of the viewport, so the two agree. Degrades to
					    two columns and then one, because three 280px cards do
					    not fit a phone. */}
					<ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
						{versions.map((v) => {
							const created = new Date(v.createdAt);
							const isAdopted = adoptedId === v.id;
							// The SAME reader the review uses, not a second
							// derivation of the same flag. It is defensive by
							// design: a row written before `generation` existed
							// answers "not a refinement", which is right — it
							// predates refinement-as-review and genuinely is an
							// ordinary candidate.
							const isRefinement =
								readCandidateRefinement(v.content ?? null) !==
								null;
							const labelId = `${labelIdPrefix}-${v.id}`;
							return (
								<li
									key={v.id}
									className="flex flex-col gap-2 rounded-lg border border-border bg-card px-3 py-2.5"
								>
									<div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
										<span
											id={labelId}
											className="font-medium text-foreground text-sm"
										>
											Version {v.version}
										</span>
										<time
											dateTime={created.toISOString()}
											className="text-muted-foreground text-xs"
										>
											{formatDistanceToNowStrict(
												created,
												{
													addSuffix: true,
												},
											)}
										</time>
									</div>
									{/* `mt-auto` so the action rows line up
									    across cards of unequal header height —
									    a wrapped "Version 10 · 3 months ago"
									    otherwise drags its buttons down out of
									    line with its neighbours'. */}
									<div className="mt-auto flex flex-wrap items-center gap-1">
										<Button
											type="button"
											variant="ghost"
											size="sm"
											aria-describedby={labelId}
											onClick={() => setOpenId(v.id)}
										>
											View
										</Button>
										{/* The adopted version gets TEXT where
										    the others get Restore, rather than
										    an empty slot. Rendering nothing was
										    read as "there is no Restore in this
										    product" by someone who happened to
										    have the current version in front of
										    them — a missing control cannot
										    explain why it is missing. */}
										{isAdopted ? (
											<span className="px-2 text-muted-foreground text-xs">
												Current version · saved from
												this
											</span>
										) : null}
										{/* Named as the mechanism, not as a
										    place. This list cannot verify the
										    review is on screen — the panel also
										    gates it on the candidate being
										    unadopted and not dismissed, neither
										    of which is visible from here — so
										    "review it above" would sometimes be
										    a lie. "Reviewed change by change"
										    is true of the newest refinement and
										    of a superseded one alike.

										    `isAdopted` wins if a row is somehow
										    both: it is the more useful sentence,
										    and neither branch offers adopt. */}
										{isRefinement && !isAdopted ? (
											<span className="px-2 text-muted-foreground text-xs">
												Refined draft · reviewed change
												by change
											</span>
										) : null}
										{onAdopt &&
										!isAdopted &&
										!isRefinement ? (
											<Button
												type="button"
												variant="ghost"
												size="sm"
												disabled={isAdopting}
												aria-describedby={labelId}
												onClick={() => onAdopt(v.id)}
											>
												Restore
											</Button>
										) : null}
									</div>
								</li>
							);
						})}
					</ul>
				</DialogContent>
			</Dialog>

			<Dialog
				open={open !== null}
				onOpenChange={(next) => {
					if (!next) {
						setOpenId(null);
					}
				}}
			>
				<DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
					<DialogHeader>
						<DialogTitle>Version {open?.version}</DialogTitle>
						{/* A refinement is not an alternative draft, so the
						    sentence about replacing the saved one would
						    describe the wrong thing entirely. */}
						<DialogDescription>
							{openIsRefinement
								? "What that refine produced. It is your saved draft with the changes that were asked for, so it is read against that draft in the review rather than swapped in here."
								: "What that run produced. Restoring it replaces the draft you have saved — the versions newer than this one stay in the list and can be restored back."}
						</DialogDescription>
					</DialogHeader>
					{open ? renderBody(open.id) : null}
					<DialogFooter>
						{/* First in DOM so `sm:mr-auto` seats it at the left of
						    the footer row, and so the reversed mobile column
						    puts it under the buttons rather than over them. */}
						{open && adoptedId === open.id ? (
							<span className="self-center text-muted-foreground text-sm sm:mr-auto">
								This is the version your saved draft came from.
							</span>
						) : null}
						{/* Occupies the slot the button would have had, for the
						    same reason the card's text does. */}
						{openIsRefinement && open && adoptedId !== open.id ? (
							<span className="self-center text-muted-foreground text-sm sm:mr-auto">
								A refined draft is accepted one change at a time
								in the review, not taken whole.
							</span>
						) : null}
						{onAdopt &&
						open &&
						adoptedId !== open.id &&
						!openIsRefinement ? (
							<Button
								type="button"
								disabled={isAdopting}
								onClick={() => {
									onAdopt(open.id);
									setOpenId(null);
								}}
							>
								Restore this version
							</Button>
						) : null}
						<Button
							type="button"
							variant="ghost"
							onClick={() => setOpenId(null)}
						>
							Close
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
