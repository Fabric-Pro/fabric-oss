"use client";

/**
 * MeetingsCard — renders Teams/meeting transcripts for a Daily Brief.
 */

import type { MeetingItem, PartialFailure } from "@repo/database";
import { MicIcon } from "lucide-react";
import { formatRelativeOccurredAt } from "./format";
import { MeetingInsights } from "./MeetingInsights";
import { SourceCard } from "./SourceCard";

export interface MeetingsCardProps {
	items: MeetingItem[];
	partialFailure?: PartialFailure;
	emptyMessage?: string;
}

export function MeetingsCard({
	items,
	partialFailure,
	emptyMessage = "No meeting transcripts in this window.",
}: MeetingsCardProps) {
	return (
		<SourceCard
			title="Meetings"
			sourceLabel="Source — Teams meetings"
			count={items.length}
			emptyMessage={emptyMessage}
			icon={<MicIcon className="size-4" />}
			partialFailure={partialFailure}
		>
			<ul className="divide-y divide-border">
				{items.map((item) => (
					<li
						key={item.transcriptCuid}
						className="py-3 first:pt-0 last:pb-0"
					>
						<div className="min-w-0">
							<p className="font-sans text-sm font-medium text-foreground">
								{item.title}
							</p>
							{item.keywords && item.keywords.length > 0 ? (
								<div className="mt-2 flex flex-wrap gap-1.5">
									{item.keywords.slice(0, 6).map((kw) => (
										<span
											key={kw}
											className="inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
										>
											{kw}
										</span>
									))}
								</div>
							) : null}
							<p className="mt-1.5 text-xs text-muted-foreground">
								{item.speakerNames &&
								item.speakerNames.length > 0
									? `${item.speakerNames.slice(0, 3).join(", ")} · `
									: ""}
								{formatRelativeOccurredAt(item.meetingDate)}
							</p>
							<MeetingInsights meeting={item} />
							{item.summary ? (
								<details className="mt-2 text-xs text-muted-foreground">
									<summary className="cursor-pointer select-none">
										Transcript summary
									</summary>
									<p className="mt-1 whitespace-pre-wrap">
										{item.summary}
									</p>
								</details>
							) : null}
						</div>
					</li>
				))}
			</ul>
		</SourceCard>
	);
}
