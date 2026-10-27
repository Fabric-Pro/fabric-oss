"use client";

import { useFeatureFlag } from "@saas/shared/components/FeatureFlagProvider";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@ui/components/collapsible";
import { Skeleton } from "@ui/components/skeleton";
import { useState } from "react";
import {
	isReplayNotFound,
	REPLAY_STALE_TIME,
	type TimelineEvent,
} from "./decision-replay";

function eventLine(event: TimelineEvent): string {
	const actor =
		event.actorKind === "ai"
			? "AI"
			: event.actorKind === "system"
				? "Fabric"
				: event.actorName || "Someone";
	if (event.eventType === "proposal_reviewed") {
		const selected = event.selectedCount ?? 0;
		if (event.offeredListComplete !== true) {
			return `${actor} selected ${selected} changes`;
		}
		const offered = event.offeredCount ?? selected;
		const omitted = Math.max(0, offered - selected);
		return `${actor} selected ${selected} of ${offered} changes${omitted ? ` · ${omitted} not selected` : ""}`;
	}
	if (event.eventType === "change_deduplicated") {
		return `Change${event.changeIndex === null ? "" : ` ${event.changeIndex + 1}`} already on roadmap`;
	}

	if (event.eventType === "proposed") {
		return "Proposed by AI";
	}
	if (event.eventType === "story_edited") {
		return "Story edited";
	}
	if (event.eventType === "change_applied") {
		const action =
			event.action === "create"
				? "created"
				: event.action === "update"
					? "updated"
					: null;
		return `Change${event.changeIndex === null ? "" : ` ${event.changeIndex + 1}`} applied${action && event.createdEntityType && event.createdEntityType !== "unknown" ? ` (${action} ${event.createdEntityType.toLowerCase()})` : ""}`;
	}
	if (
		(event.actorKind === "system" || event.toState === "PENDING") &&
		event.toState
	) {
		const states: Record<string, string> = {
			PENDING: "back to Pending",
			APPROVED: "to Approved",
			APPLYING: "to Applying",
			APPLIED: "to Applied",
			REJECTED: "to Rejected",
			FAILED: "to Failed",
			SUPERSEDED: "to Superseded",
			BACKLOG: "to Rejected",
		};
		if (states[event.toState]) {
			return `${actor} · moved ${states[event.toState]}`;
		}
	}
	if (event.toState === "BACKLOG") {
		return "Moved to Rejected";
	}
	if (event.toState === "REJECTED") {
		return `${actor} rejected`;
	}
	if (event.toState === "APPLIED") {
		return "Applied";
	}
	if (event.toState === "FAILED" || event.eventType === "failed") {
		return "Failed";
	}
	if (event.toState === "APPLYING" || event.toState === "APPROVED") {
		return `${actor} accepted (${event.toState === "APPLYING" ? "Applying" : "Approved"})`;
	}
	if (event.toState === "SUPERSEDED") {
		return "Superseded";
	}
	return `${actor} · ${event.eventType.replaceAll("_", " ")}`;
}

export function ProposalTimeline(props: {
	projectId: string;
	proposalId: string;
}) {
	const enabled = useFeatureFlag("DECISION_REPLAY");
	return enabled ? (
		<TimelineContent
			key={`${props.projectId}:${props.proposalId}`}
			{...props}
		/>
	) : null;
}
function TimelineContent({
	projectId,
	proposalId,
}: {
	projectId: string;
	proposalId: string;
}) {
	const [open, setOpen] = useState(false);
	const query = useQuery(
		orpc.projects.decisionReplay.getProposalTimeline.queryOptions({
			input: { projectId, proposalId },
			enabled: open,
			staleTime: REPLAY_STALE_TIME,
			retry: false,
		}),
	);
	if (isReplayNotFound(query.error)) {
		return null;
	}
	let reviewNumber = 0;
	return (
		<Collapsible
			open={open}
			onOpenChange={setOpen}
			className="rounded-md border border-border"
		>
			<CollapsibleTrigger asChild>
				<Button
					variant="ghost"
					size="sm"
					className="w-full justify-start"
				>
					Timeline
				</Button>
			</CollapsibleTrigger>
			<CollapsibleContent className="space-y-2 px-3 pb-3 text-xs">
				{query.isError ? (
					<div role="alert">
						History could not load.{" "}
						<Button
							size="sm"
							variant="outline"
							onClick={() => void query.refetch()}
						>
							Try again
						</Button>
					</div>
				) : !query.data ? (
					<Skeleton className="h-24" />
				) : (
					<>
						{query.data.truncated && (
							<p className="text-muted-foreground">
								Showing the latest 200 events
							</p>
						)}
						{query.data.events.length === 0 ? (
							<p className="text-muted-foreground">
								No history captured yet — history starts when
								Decision Replay is on.
							</p>
						) : (
							<ol className="space-y-2">
								{query.data.events.map((event, index) => {
									if (
										event.eventType === "proposal_reviewed"
									) {
										reviewNumber += 1;
									}
									const notSelectedCount = Math.max(
										0,
										(event.offeredCount ?? 0) -
											(event.selectedCount ?? 0),
									);
									const remainingCount = Math.max(
										0,
										notSelectedCount -
											event.notSelectedTitles.length,
									);
									return (
										<li
											key={`${new Date(event.occurredAt).toISOString()}:${index}`}
										>
											<span>{eventLine(event)}</span>
											{" · "}
											<time
												className="text-muted-foreground"
												dateTime={new Date(
													event.occurredAt,
												).toISOString()}
											>
												{new Date(
													event.occurredAt,
												).toLocaleString()}
											</time>
											{event.eventType ===
												"proposal_reviewed" &&
												event.notSelectedTitles.length >
													0 && (
													<Collapsible>
														<CollapsibleTrigger
															asChild
														>
															<Button
																variant="ghost"
																size="sm"
																aria-label={`Review ${reviewNumber}: show ${notSelectedCount} not selected changes`}
															>
																Show{" "}
																{
																	notSelectedCount
																}{" "}
																not selected
																changes
															</Button>
														</CollapsibleTrigger>
														<CollapsibleContent>
															<ul className="list-disc space-y-1 pl-4 text-muted-foreground">
																{event.notSelectedTitles.map(
																	(
																		title,
																		titleIndex,
																	) => (
																		<li
																			key={`${titleIndex}:${title}`}
																		>
																			{
																				title
																			}
																		</li>
																	),
																)}
															</ul>
															{remainingCount >
																0 && (
																<p className="text-muted-foreground">
																	and{" "}
																	{
																		remainingCount
																	}{" "}
																	more
																</p>
															)}
														</CollapsibleContent>
													</Collapsible>
												)}
										</li>
									);
								})}
							</ol>
						)}
					</>
				)}
			</CollapsibleContent>
		</Collapsible>
	);
}
