"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Card } from "@ui/components/card";
import {
	formatClock,
	type ParlumeTranscriptSegment,
} from "../lib/parlume-format";
import { CARD_TITLE } from "../lib/parlume-styles";
import { TRANSCRIPT_QUERY_KEY } from "../lib/query-keys";

function TranscriptLine({ segment }: { segment: ParlumeTranscriptSegment }) {
	const time = (
		<time
			dateTime={new Date(segment.createdAt).toISOString()}
			className="shrink-0 pt-px font-mono text-[11px] tabular-nums text-muted-foreground"
		>
			{formatClock(segment.createdAt)}
		</time>
	);
	switch (segment.source) {
		case "EVENT":
			return (
				<li className="flex gap-3 py-1.5">
					{time}
					<p className="text-[13px] italic leading-[18px] text-muted-foreground">
						{segment.text}
					</p>
				</li>
			);
		case "CHAT":
		case "SPEECH":
			return (
				<li className="flex gap-3 py-1.5">
					{time}
					<p className="min-w-0 whitespace-pre-wrap break-words text-sm leading-[21px]">
						<span className="font-medium">
							{segment.speakerName ?? "Unidentified attendee"}
						</span>
						{segment.source === "CHAT" && (
							<Badge variant="info" className="ml-2 align-middle">
								Chat
							</Badge>
						)}{" "}
						{segment.text}
					</p>
				</li>
			);
		default: {
			const unreachable: never = segment.source;
			return unreachable;
		}
	}
}

/**
 * What the meeting has said so far, refreshed while Parlume is in it: spoken
 * lines, chat messages (marked Chat) and the moments listening paused or
 * resumed. Shown only to those who may read the meeting's transcript; the
 * procedure gives everyone else nothing.
 */
export function ParlumeLiveTranscript({
	projectId,
	sessionId,
	refetchInterval,
}: {
	projectId: string;
	sessionId: string;
	refetchInterval: number;
}) {
	const query = useQuery({
		queryKey: [TRANSCRIPT_QUERY_KEY, projectId, sessionId],
		queryFn: () =>
			orpcClient.projects.parlume.transcript({ projectId, sessionId }),
		retry: false,
		refetchInterval,
	});
	if (query.data && !query.data.readable) {
		return null;
	}
	const segments = query.data?.segments ?? [];
	const headingId = `parlume-transcript-${sessionId}`;
	return (
		<Card className="p-6">
			<section aria-labelledby={headingId} className="space-y-3">
				<h3 id={headingId} className={CARD_TITLE}>
					Live transcript
				</h3>
				{query.isError && (
					<p className="text-[13px] leading-[18px] text-muted-foreground">
						{segments.length > 0
							? "Couldn't refresh the transcript. Showing the last lines loaded."
							: "The transcript could not be loaded."}
					</p>
				)}
				{segments.length === 0 ? (
					!query.isError && (
						<p className="text-[13px] leading-[18px] text-muted-foreground">
							{query.isLoading
								? "Loading the transcript…"
								: "Nothing has been said yet."}
						</p>
					)
				) : (
					<ol
						// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling transcript has to be reachable from the keyboard to be read
						tabIndex={0}
						aria-labelledby={headingId}
						className="max-h-96 overflow-y-auto pr-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					>
						{segments.map((segment) => (
							<TranscriptLine
								key={segment.id}
								segment={segment}
							/>
						))}
					</ol>
				)}
			</section>
		</Card>
	);
}
