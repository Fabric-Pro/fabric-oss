"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { formatClock, type ParlumeSuggestionItem } from "../lib/parlume-format";
import { CARD_TITLE, MONO_LABEL } from "../lib/parlume-styles";
import { SUGGESTIONS_QUERY_KEY } from "../lib/query-keys";

function kindLabel(kind: ParlumeSuggestionItem["kind"]): string {
	switch (kind) {
		case "ANSWER":
			return "Suggestion";
		case "MISSED_QUESTION":
			return "Possibly missed question";
		case "RECAP":
			return "Recap";
		default: {
			const unreachable: never = kind;
			return unreachable;
		}
	}
}

/**
 * Where a suggestion went: the meeting chat, or the team only. The tag is
 * kept when the post is sent, before the chat confirms it arrived.
 */
function deliveryLabel(suggestion: ParlumeSuggestionItem): string {
	if (suggestion.chatTag) {
		return `Sent to the chat as ${suggestion.chatTag}`;
	}
	switch (suggestion.audience) {
		case "TEAM":
			return "Team only";
		case "MEETING":
			return "Not posted: the chat did not take it";
		default: {
			const unreachable: never = suggestion.audience;
			return unreachable;
		}
	}
}

function SuggestionItem({ suggestion }: { suggestion: ParlumeSuggestionItem }) {
	return (
		<li className="space-y-1.5 py-3.5 first:pt-0 last:pb-0">
			<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
				<span className="flex min-w-0 flex-wrap items-center gap-2">
					<Badge
						variant={
							suggestion.kind === "MISSED_QUESTION"
								? "warning"
								: "info"
						}
					>
						{kindLabel(suggestion.kind)}
					</Badge>
					{suggestion.topic && (
						<span className="text-sm font-medium">
							{suggestion.topic}
						</span>
					)}
				</span>
				<span className="text-xs text-muted-foreground">
					<time
						dateTime={new Date(suggestion.createdAt).toISOString()}
					>
						{formatClock(suggestion.createdAt)}
					</time>{" "}
					· {deliveryLabel(suggestion)}
				</span>
			</div>
			{suggestion.speaker && suggestion.quote && (
				<p className="text-[13px] leading-[18px] text-muted-foreground">
					Re {suggestion.speaker}: “{suggestion.quote}”
				</p>
			)}
			<p className="whitespace-pre-wrap break-words text-sm leading-[21px]">
				{suggestion.text}
			</p>
		</li>
	);
}

function Heading({ id, variant }: { id: string; variant: "card" | "details" }) {
	switch (variant) {
		case "card":
			return (
				<h3 id={id} className={CARD_TITLE}>
					Suggestions
				</h3>
			);
		case "details":
			return (
				<h4 id={id} className={MONO_LABEL}>
					Suggestions
				</h4>
			);
		default: {
			const unreachable: never = variant;
			return unreachable;
		}
	}
}

/**
 * A session's suggestions, missed questions and recap, newest first: those
 * sent to the meeting chat and those kept for the team.
 */
export function ParlumeSuggestionsList({
	projectId,
	sessionId,
	refetchInterval,
	variant,
}: {
	projectId: string;
	sessionId: string;
	/** Polls while the session is live; a finished one is read once. */
	refetchInterval: number | false;
	/** A card of its own beside the live card, or a block in a session's details. */
	variant: "card" | "details";
}) {
	const query = useQuery({
		queryKey: [SUGGESTIONS_QUERY_KEY, projectId, sessionId],
		queryFn: () =>
			orpcClient.projects.parlume.suggestions({ projectId, sessionId }),
		retry: false,
		refetchInterval,
	});
	const items = query.data?.items ?? [];
	return (
		<section
			aria-labelledby={`parlume-suggestions-${sessionId}`}
			className="space-y-3"
		>
			<Heading
				id={`parlume-suggestions-${sessionId}`}
				variant={variant}
			/>
			{items.length === 0 ? (
				query.isError ? (
					<p className="text-[13px] leading-[18px] text-destructive">
						Suggestions could not be loaded.
					</p>
				) : (
					<p className="text-[13px] leading-[18px] text-muted-foreground">
						{query.isLoading
							? "Loading suggestions…"
							: "No suggestions yet."}
					</p>
				)
			) : (
				<>
					{/* A failed poll keeps what was already shown. */}
					{query.isError && (
						<p className="text-xs text-muted-foreground">
							Couldn't refresh suggestions. Showing the last ones
							loaded.
						</p>
					)}
					<ul className="divide-y divide-border">
						{items.map((suggestion) => (
							<SuggestionItem
								key={suggestion.id}
								suggestion={suggestion}
							/>
						))}
					</ul>
				</>
			)}
		</section>
	);
}
