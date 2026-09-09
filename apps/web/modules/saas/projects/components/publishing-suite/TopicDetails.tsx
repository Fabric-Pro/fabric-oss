"use client";

import { FUNCTION_TAG_LABELS } from "@repo/database/src/function-tags";
import { Button } from "@ui/components/button";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { useId, useState } from "react";
import {
	buildMeetingParticipantsLine,
	formatMeetingParticipants,
	formatWhySuggested,
	isSafeHttpUrl,
	type MeetingParticipantsLine,
	type MeetingSpeakers,
	POST_TYPE_LABELS,
	type PublishingTopic,
} from "./topic-shared";

/**
 * Why this topic ranked where it did (1B) — its own component so the Inbox row
 * can render it in the COLLAPSED summary column.
 *
 * The line is computed server-side for every row, and it answers the question
 * a reader has BEFORE they decide to open anything: why is this near the top
 * of my list? Behind a disclosure it only ever reached people who had already
 * decided. `className` is how the collapsed mount adds its own wrapping rules
 * without touching the base classes, which the flag-off row's parity snapshot
 * pins.
 */
export function TopicRankReason({
	topic,
	className,
}: {
	topic: PublishingTopic;
	className?: string;
}) {
	if (!topic.rankReason) {
		return null;
	}
	return (
		<p
			className={cn(
				"border-l-2 border-primary pl-2 text-xs text-muted-foreground",
				className,
			)}
		>
			{topic.rankReason.kind === "contributed"
				? "Based on your contribution"
				: `Matches your role: ${topic.rankReason.matchedTags
						.map((t) => FUNCTION_TAG_LABELS[t])
						.join(", ")}`}
		</p>
	);
}

/**
 * The "Meeting participants —" line, with the names the payload holds back
 * available behind a disclosure.
 *
 * WHICH mount gets the disclosure is decided by the PAYLOAD, not by a prop.
 * The Inbox read caps participants at three server-side, so `hiddenCount` is
 * always 0 on a row and this renders the same single `<p>` it always has —
 * same element, same classes, same string, which is what keeps the flag-off
 * row parity snapshot still true. The single-topic read raises that cap
 * (`MEETING_PARTICIPANTS_DETAIL_CAP`), so on the topic page there is something
 * to unfold and the button appears. One entry point, no `isDetailPage` flag to
 * pass down and get wrong.
 *
 * `overflowCount` is NOT part of what unfolds — those names never left the
 * server — so it stays a trailing count in both states. Expanding a line that
 * still says "+4 more" is correct, not a bug.
 *
 * The two branches are two COMPONENTS rather than one with an early return,
 * and that is load-bearing rather than tidiness: the expandable branch needs
 * `useId`, and a `useId` called before an early return still consumes an id on
 * the collapsed path. React's id counter is shared with Radix, so the Select
 * further down the same row would silently renumber — which is what the
 * flag-off row parity snapshot caught the first time this was written as one
 * component. Keeping the hooks inside the branch that mounts them means the
 * Inbox row renders the identical tree it always has.
 */
function MeetingParticipants({ speakers }: { speakers: MeetingSpeakers }) {
	const line = buildMeetingParticipantsLine(speakers);

	if (line.hiddenCount === 0) {
		return (
			<p
				className="text-xs text-muted-foreground"
				aria-label={`Meeting participants: ${speakers.members
					.map((m) => m.name ?? "")
					.filter((token) => token !== "")
					.join(", ")}${
					speakers.overflowCount > 0
						? `, and ${speakers.overflowCount} more`
						: ""
				}`}
			>
				{formatMeetingParticipants(speakers)}
			</p>
		);
	}

	return <ExpandableMeetingParticipants speakers={speakers} line={line} />;
}

/**
 * The participants line when the payload holds names back — the Topic Item
 * Page, and only there today.
 *
 * The trigger's accessible name is its visible text ("Show 8 more" /
 * "Show fewer"), rather than a fuller `aria-label` that would no longer contain
 * it — WCAG 2.5.3. `aria-expanded` and `aria-controls` carry the state and the
 * target; the wording stays soft ("participants", not "attendees") for the same
 * reason the line does: the match is a strict-exact-normalized name heuristic
 * and an external attendee sharing a member's name can false-positive it.
 */
function ExpandableMeetingParticipants({
	speakers,
	line,
}: {
	speakers: MeetingSpeakers;
	line: MeetingParticipantsLine;
}) {
	const [expanded, setExpanded] = useState(false);
	const namesId = useId();
	const shown = expanded ? line.all : line.visible;

	return (
		<p className="text-xs text-muted-foreground">
			{/* The controlled region is the names the button unfolds, and
			    NOTHING else — `overflowCount` sits outside it because those
			    names never left the server and no click will reveal them. */}
			<span id={namesId}>Meeting participants — {shown.join(", ")}</span>
			{speakers.overflowCount > 0
				? ` +${speakers.overflowCount} more`
				: ""}{" "}
			<button
				type="button"
				onClick={() => setExpanded((wasExpanded) => !wasExpanded)}
				aria-expanded={expanded}
				aria-controls={namesId}
				className="underline underline-offset-2 hover:text-foreground"
			>
				{expanded ? "Show fewer" : `Show ${line.hiddenCount} more`}
			</button>
		</p>
	);
}

/**
 * The topic's metadata fields, in one definition with two mount points.
 *
 * Flag off, the row mounts this inline exactly where these fields render
 * today. Flag on, the row mounts it inside the disclosure region. Copying the
 * markup into an "inbox row" instead would guarantee the two paths drift, and
 * the flag-off path is the rollback path — it has to stay correct.
 */
export function TopicDetails({
	topic,
	canEdit,
	isPending,
	showRankReason = true,
	onEditUrl,
	onEditPostTypes,
	onEditContributors,
	onEditAssignees,
}: {
	topic: PublishingTopic;
	canEdit: boolean;
	isPending: boolean;
	/**
	 * False when the row already renders `TopicRankReason` itself — the Inbox
	 * row lifts that line into its collapsed summary column, and the expanded
	 * region must not repeat it. Defaults to true so the flag-off row, which
	 * has no summary column of its own to lift it into, keeps rendering the
	 * line exactly where it shipped.
	 */
	showRankReason?: boolean;
	onEditUrl: () => void;
	onEditPostTypes: () => void;
	onEditContributors: () => void;
	onEditAssignees: () => void;
}) {
	return (
		<>
			{topic.whySuggested ? (
				<p className="text-xs text-muted-foreground">
					{formatWhySuggested(topic.whySuggested)}
				</p>
			) : null}
			{showRankReason ? <TopicRankReason topic={topic} /> : null}
			{topic.meetingSpeakers ? (
				<MeetingParticipants speakers={topic.meetingSpeakers} />
			) : null}
			{topic.subject ? (
				<p
					className="text-xs text-muted-foreground"
					aria-label={`Subject: ${topic.subject}`}
				>
					Subject · {topic.subject}
				</p>
			) : null}
			{topic.status === "PUBLISHED" ? (
				<div className="flex items-center gap-2">
					{topic.publishedUrl ? (
						isSafeHttpUrl(topic.publishedUrl) ? (
							<a
								href={topic.publishedUrl}
								target="_blank"
								rel="noopener noreferrer"
								className="inline-block truncate text-sm text-primary underline underline-offset-2"
							>
								{topic.publishedUrl}
							</a>
						) : (
							<span
								className="inline-block truncate text-sm text-muted-foreground"
								title={topic.publishedUrl}
							>
								{topic.publishedUrl}
							</span>
						)
					) : null}
					{canEdit ? (
						<Button
							type="button"
							variant="ghost"
							size="sm"
							aria-label={
								topic.publishedUrl ? "Edit URL" : "Add URL"
							}
							// C-Med2 (extended to this new affordance): a
							// status mutation for THIS topic is in flight —
							// block a second, racing mutation the same way
							// the Select is already blocked below.
							disabled={isPending}
							onClick={onEditUrl}
						>
							{topic.publishedUrl ? "Edit URL" : "Add URL"}
						</Button>
					) : null}
				</div>
			) : null}
			{topic.contributors.length > 0 ? (
				<ul
					className="flex flex-wrap items-center gap-1.5 pt-1"
					aria-label="Contributors"
				>
					{topic.contributors.map((c) => (
						<li
							key={c.id}
							className="flex items-center gap-1"
							aria-label={`Contributor: ${c.name}`}
						>
							{c.image ? (
								// eslint-disable-next-line @next/next/no-img-element
								<img
									src={c.image}
									alt=""
									className="size-4 rounded-full"
								/>
							) : (
								<span
									aria-hidden
									className="flex size-4 items-center justify-center rounded-full bg-muted text-[9px] font-medium text-muted-foreground"
								>
									{c.name.charAt(0).toUpperCase()}
								</span>
							)}
							<span className="text-xs text-muted-foreground">
								{c.username ?? c.name}
							</span>
						</li>
					))}
				</ul>
			) : null}
			{/* A8: who should PICK THIS UP, rendered as its own labelled row
			    rather than folded into the contributor row above. The two are
			    different claims — one is attribution, the other is a request —
			    and a reader who cannot tell them apart gets both wrong. The
			    visible "Assigned" prefix is what carries that distinction to
			    sighted readers; `aria-label` carries it to everyone else. */}
			{topic.assignees.length > 0 ? (
				<ul
					className="flex flex-wrap items-center gap-1.5 pt-1"
					aria-label="Assignees"
				>
					<li className="text-[11px] text-muted-foreground uppercase tracking-[0.15em]">
						Assigned
					</li>
					{topic.assignees.map((a) => (
						<li
							key={a.id}
							className="flex items-center gap-1"
							aria-label={`Assignee: ${a.name}`}
						>
							{a.image ? (
								// eslint-disable-next-line @next/next/no-img-element
								<img
									src={a.image}
									alt=""
									className="size-4 rounded-full"
								/>
							) : (
								<span
									aria-hidden
									className="flex size-4 items-center justify-center rounded-full bg-muted text-[9px] font-medium text-muted-foreground"
								>
									{a.name.charAt(0).toUpperCase()}
								</span>
							)}
							<span className="text-xs text-muted-foreground">
								{a.username ?? a.name}
							</span>
						</li>
					))}
				</ul>
			) : null}
			{/* Both gated on `canEdit` ONLY — deliberately NOT nested inside
			    their respective `<ul>` conditionals above. The post-type row
			    already shipped this exact bug: an override of `[]` empties the
			    chip row, and if the only Edit affordance lived inside that same
			    conditional, saving "nobody" would strand the editor with no way
			    back to add anyone or reset. See the post-type row's "shows the
			    Edit button but no chips…" test for the guard this mirrors. The
			    assignee control has the same hazard for the same reason, and
			    both are text buttons rather than icons — no `aria-label` to get
			    wrong, and no new i18n key in a module that hardcodes English. */}
			{canEdit ? (
				<div className="flex flex-wrap items-center gap-1">
					<Button
						type="button"
						variant="ghost"
						size="sm"
						disabled={isPending}
						onClick={onEditContributors}
					>
						Edit contributors
					</Button>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						disabled={isPending}
						onClick={onEditAssignees}
					>
						{topic.assignees.length > 0
							? "Edit assignees"
							: "Assign people"}
					</Button>
				</div>
			) : null}
			{topic.authorRecommendation ? (
				<p
					className="text-xs text-muted-foreground"
					aria-label={`${
						topic.authorRecommendation.model === "single"
							? "Recommended author"
							: "Recommended co-authors"
					}: ${topic.authorRecommendation.authors
						.map(
							(a) =>
								`${a.name}, ${a.matchedTags
									.map((t) => FUNCTION_TAG_LABELS[t])
									.join(" and ")}`,
						)
						.join("; ")}`}
				>
					{topic.authorRecommendation.model === "single"
						? "Recommended author — "
						: "Recommended co-authors — "}
					{topic.authorRecommendation.authors
						.map(
							(a) =>
								`${a.username ? `@${a.username}` : a.name} · ${a.matchedTags
									.map((t) => FUNCTION_TAG_LABELS[t])
									.join(", ")}`,
						)
						.join("; ")}
				</p>
			) : null}
			{(() => {
				const effectivePostTypes =
					topic.userPostTypes ?? topic.suggestedPostTypes;
				if (effectivePostTypes.length === 0 && !canEdit) {
					return null;
				}
				const recByType = new Map(
					topic.postTypeRecommendations.map((r) => [r.type, r]),
				);
				const chipClassName =
					"appearance-none rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground";
				return (
					<TooltipProvider>
						<div
							data-testid="post-type-row"
							role="group"
							className="flex flex-wrap items-center gap-1.5 pt-1"
							aria-label="Post types"
						>
							{POST_TYPE_LABELS.filter((p) =>
								effectivePostTypes.includes(p.value),
							).map((p) => {
								const rec = recByType.get(p.value);
								const chipContent = (
									<>
										<span>{p.label}</span>
										{rec?.theme ? (
											<span className="text-muted-foreground/70">
												{" · "}
												{rec.theme}
											</span>
										) : null}
									</>
								);
								// Enriched chip: a real, focusable, nameable
								// control. A bare <span> has the implicit ARIA
								// role `generic`, which PROHIBITS naming from
								// `aria-label` (WAI-ARIA 1.2 §5.2.8.6) — the
								// rationale would be inert to screen readers —
								// and Radix's `TooltipTrigger asChild` never
								// adds `tabIndex` to a non-interactive clone, so
								// a keyboard-only user could never focus it to
								// reveal the tooltip either. `button` is
								// natively focusable AND its role permits
								// `aria-label` naming, fixing both gaps.
								return rec?.rationale ? (
									<Tooltip key={p.value}>
										<TooltipTrigger asChild>
											<button
												type="button"
												className={chipClassName}
												aria-label={`Why ${p.label}${rec.theme ? `: ${rec.theme}` : ""}. ${rec.rationale}`}
											>
												{chipContent}
											</button>
										</TooltipTrigger>
										<TooltipContent>
											{rec.rationale}
										</TooltipContent>
									</Tooltip>
								) : (
									<span
										key={p.value}
										className={chipClassName}
									>
										{chipContent}
									</span>
								);
							})}
							{canEdit ? (
								<Button
									type="button"
									variant="ghost"
									size="sm"
									disabled={isPending}
									onClick={onEditPostTypes}
								>
									Edit post types
								</Button>
							) : null}
						</div>
					</TooltipProvider>
				);
			})()}
		</>
	);
}
