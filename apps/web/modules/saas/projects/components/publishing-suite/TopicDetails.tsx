"use client";

import { FUNCTION_TAG_LABELS } from "@repo/database/src/function-tags";
import { Button } from "@ui/components/button";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import {
	formatMeetingParticipants,
	formatWhySuggested,
	isSafeHttpUrl,
	POST_TYPE_LABELS,
	type PublishingTopic,
} from "./topic-shared";

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
	onEditUrl,
	onEditPostTypes,
}: {
	topic: PublishingTopic;
	canEdit: boolean;
	isPending: boolean;
	onEditUrl: () => void;
	onEditPostTypes: () => void;
}) {
	return (
		<>
			{topic.whySuggested ? (
				<p className="text-xs text-muted-foreground">
					{formatWhySuggested(topic.whySuggested)}
				</p>
			) : null}
			{topic.rankReason ? (
				<p className="border-l-2 border-primary pl-2 text-xs text-muted-foreground">
					{topic.rankReason.kind === "contributed"
						? "Based on your contribution"
						: `Matches your role: ${topic.rankReason.matchedTags
								.map((t) => FUNCTION_TAG_LABELS[t])
								.join(", ")}`}
				</p>
			) : null}
			{topic.meetingSpeakers ? (
				<p
					className="text-xs text-muted-foreground"
					aria-label={`Meeting participants: ${topic.meetingSpeakers.members
						.map((m) => m.name ?? "")
						.filter((token) => token !== "")
						.join(", ")}${
						topic.meetingSpeakers.overflowCount > 0
							? `, and ${topic.meetingSpeakers.overflowCount} more`
							: ""
					}`}
				>
					{formatMeetingParticipants(topic.meetingSpeakers)}
				</p>
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
