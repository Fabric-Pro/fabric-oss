"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@ui/components/dialog";
import { useState } from "react";

function timestamp(value: Date | string): string {
	return new Intl.DateTimeFormat(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(new Date(value));
}

export function ParlumeHistoryDialog({ projectId }: { projectId: string }) {
	const [open, setOpen] = useState(false);
	const firstPage: { id: string; createdAt: Date } | undefined = undefined;
	const history = useInfiniteQuery({
		queryKey: ["parlume-history", projectId],
		initialPageParam: firstPage,
		queryFn: ({
			pageParam,
		}: {
			pageParam: { id: string; createdAt: Date } | undefined;
		}) =>
			orpcClient.projects.parlume.history({
				projectId,
				before: pageParam,
			}),
		getNextPageParam: (page) => page.nextCursor ?? undefined,
		enabled: open,
		retry: false,
	});
	const items = history.data?.pages.flatMap((page) => page.items) ?? [];
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<Button
					type="button"
					variant="link"
					className="px-0 underline"
					data-onboarding-target="parlume-history"
				>
					Parlume history
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-2xl max-sm:[&_:is(button,summary)]:min-h-11 pointer-coarse:[&_:is(button,summary)]:min-h-11">
				<DialogHeader>
					<DialogTitle>Parlume history</DialogTitle>
					<DialogDescription>
						Review meeting questions, requested actions, approvals
						and results. Speaker labels come from the meeting
						provider.
					</DialogDescription>
				</DialogHeader>
				<div className="flex items-center justify-between gap-3">
					<p className="text-sm text-muted-foreground">
						Newest requests first
					</p>
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => history.refetch()}
						disabled={history.isFetching}
					>
						Refresh
					</Button>
				</div>
				{history.isLoading ? (
					<output>Loading history…</output>
				) : history.isError ? (
					<p role="alert" className="text-sm text-destructive">
						Could not load Parlume history. Try refreshing.
					</p>
				) : items.length === 0 ? (
					<p className="py-6 text-center text-sm text-muted-foreground">
						No Parlume requests yet.
					</p>
				) : (
					<ol className="space-y-3">
						{items.map((turn) => (
							<li
								key={turn.id}
								className="space-y-2 rounded-md border p-3 text-sm"
							>
								<div className="flex flex-wrap items-baseline justify-between gap-2">
									<p className="font-medium">
										{turn.speakerName ??
											"Unidentified attendee"}
									</p>
									<time
										className="text-xs text-muted-foreground"
										dateTime={new Date(
											turn.createdAt,
										).toISOString()}
									>
										{timestamp(turn.createdAt)}
									</time>
								</div>
								<p className="text-xs text-muted-foreground">
									{turn.session.agentLabel} ·{" "}
									{turn.session.toolsReadOnly
										? "Read-only"
										: "Actions with confirmation"}{" "}
									· {turn.status.toLowerCase()}
								</p>
								<p className="whitespace-pre-wrap break-words">
									{turn.requestText}
								</p>
								{turn.responseText && (
									<p className="whitespace-pre-wrap break-words border-l-2 pl-3 text-muted-foreground">
										{turn.responseText}
									</p>
								)}
								{turn.error && (
									<p className="text-destructive">
										{turn.error}
									</p>
								)}
								{turn.actions.map((action) => (
									<details
										key={action.id}
										className="rounded-md bg-muted/40 px-3 py-2"
									>
										<summary className="min-h-6 cursor-pointer font-medium">
											Action ·{" "}
											{action.status ===
												"AWAITING_CONFIRMATION" &&
											new Date(action.expiresAt) <=
												new Date()
												? "expired"
												: action.status
														.toLowerCase()
														.replaceAll("_", " ")}
										</summary>
										<div className="mt-2 space-y-2">
											<p className="whitespace-pre-wrap break-words">
												{action.summary}
											</p>
											<p className="text-xs text-muted-foreground">
												Requested{" "}
												{timestamp(action.createdAt)}
												{action.confirmedAt
													? ` · Confirmed ${timestamp(action.confirmedAt)}`
													: ""}
												{action.completedAt
													? ` · Finished ${timestamp(action.completedAt)}`
													: ""}
											</p>
											<section aria-label="Exact action details">
												<pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">
													{JSON.stringify(
														action.arguments,
														null,
														2,
													)}
												</pre>
											</section>
											{action.outcome && (
												<p className="whitespace-pre-wrap break-words text-muted-foreground">
													{action.outcome}
												</p>
											)}
										</div>
									</details>
								))}
							</li>
						))}
					</ol>
				)}
				{history.hasNextPage && (
					<Button
						type="button"
						variant="outline"
						onClick={() => history.fetchNextPage()}
						disabled={history.isFetchingNextPage}
					>
						{history.isFetchingNextPage
							? "Loading…"
							: "Load older requests"}
					</Button>
				)}
			</DialogContent>
		</Dialog>
	);
}
