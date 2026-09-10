"use client";

import type { ReactNode } from "react";

/**
 * The saved draft and the newest candidate, side by side (Fizzy #1851, slice
 * A6).
 *
 * Every long-form panel already promised the comparison in prose —
 * "Regenerating writes a new version to compare against" — and then stacked the
 * two texts, the editor above and the candidate several sections below, with
 * the safety blocks in between. Comparing them meant scrolling between them,
 * which for a 900-word draft is not comparing at all.
 *
 * Nothing here changes what adopting does; the adopt control keeps its
 * behaviour and its wording, and only moves with the text it belongs to.
 *
 * Two columns ONLY when there are two things to compare. A single-column grid
 * for the common case — a saved draft with no unadopted version — would leave
 * an editor at half width beside empty space.
 */
export function DraftComparison({
	saved,
	candidate,
}: {
	/** The working draft: an editor for an author, read-only for a viewer. */
	saved: ReactNode;
	/** The latest generated version, when the reader has not adopted it. */
	candidate: ReactNode;
}) {
	if (!saved || !candidate) {
		return (
			<>
				{saved}
				{candidate}
			</>
		);
	}

	return (
		// `min-w-0` on BOTH children, not decoration: a grid track is `auto`
		// by default, so one unbroken token — a URL in a draft is the ordinary
		// case — widens its column past the viewport and takes the whole page
		// into a horizontal scroll. `items-start` keeps a short candidate from
		// stretching to the height of a long editor.
		<div className="grid gap-5 lg:grid-cols-2 lg:items-start">
			<div className="min-w-0">{saved}</div>
			<div className="min-w-0">{candidate}</div>
		</div>
	);
}

/**
 * The generated candidate, framed as the thing it is: not saved, and offered
 * rather than applied.
 *
 * One component for all three long-form panels, because the three blocks it
 * replaces were the same block with a different heading — and because the
 * labelling is the point of the slice. A reader looking at two texts must not
 * have to work out which one the topic actually holds.
 */
export function CandidateDraft({
	version,
	title,
	subtitle,
	body,
	replacesSavedDraft,
	action,
}: {
	version: number | null;
	title: string;
	/** Blog posts carry one; a case study and an email do not. */
	subtitle?: string | null;
	body: string;
	/** Whether adopting would overwrite saved text, or seed the first draft. */
	replacesSavedDraft: boolean;
	/** The adopt control, or null for a viewer who cannot adopt. */
	action: ReactNode;
}) {
	return (
		<section className="space-y-2">
			<div className="space-y-1">
				<h3 className="publishing-label">
					New candidate
					{version !== null ? ` (version ${version})` : ""}
				</h3>
				<p className="text-muted-foreground text-xs leading-relaxed">
					{/*
					 * Never "the draft on the left". The two columns stack
					 * below `lg`, and a caption naming a position is wrong on
					 * every phone.
					 */}
					{replacesSavedDraft
						? "Not saved. Adopting it replaces your saved draft."
						: "Not saved. Adopting it makes this the topic's draft."}
				</p>
			</div>
			<div className="rounded-xl border border-border bg-card">
				{/*
				 * The text scrolls, the adopt control does not. A generated
				 * case study runs to thousands of words, and a button at the
				 * bottom of that is a button nobody finds.
				 */}
				<div className="max-h-[32rem] overflow-y-auto p-4">
					<h4 className="break-words font-medium text-sm">{title}</h4>
					{subtitle ? (
						<p className="mt-1 break-words text-muted-foreground text-sm italic">
							{subtitle}
						</p>
					) : null}
					<p className="mt-3 whitespace-pre-wrap break-words text-sm leading-relaxed">
						{body}
					</p>
				</div>
				{action ? (
					<div className="border-border border-t px-4 py-3">
						{action}
					</div>
				) : null}
			</div>
		</section>
	);
}

/**
 * Said under the working draft's heading while a candidate sits beside it.
 *
 * Only then: on a panel showing one draft there is nothing to disambiguate,
 * and a caption under every heading is a caption nobody reads.
 */
export function SavedDraftCaption({ children }: { children: ReactNode }) {
	return (
		<p className="text-muted-foreground text-xs leading-relaxed">
			{children}
		</p>
	);
}
