"use client";

import { Button } from "@ui/components/button";
import {
	Table,
	TableBody,
	TableHead,
	TableHeader,
	TableRow,
} from "@ui/components/table";
import { useState } from "react";
import { isLiveSession, type ParlumeSession } from "../lib/parlume-format";
import { useNow } from "../lib/use-now";
import { ParlumeSessionRow } from "./ParlumeSessionRow";

const HEAD_CLASS =
	"font-mono text-[11px] font-normal normal-case tracking-[0.1em]";
const LIVE_LENGTH_REFRESH_MS = 10_000;

/** Sessions, newest first; finished sessions open to their detail, one at a time. */
export function ParlumeSessionsTable({
	sessions,
	costBySessionId,
	projectBasePath,
	isLoading,
	isError,
	onRetry,
	hasNextPage,
	isFetchingNextPage,
	loadMoreFailed,
	onLoadMore,
	onViewRequests,
}: {
	sessions: ParlumeSession[];
	costBySessionId: ReadonlyMap<string, number>;
	projectBasePath: string;
	isLoading: boolean;
	isError: boolean;
	onRetry: () => void;
	hasNextPage: boolean;
	isFetchingNextPage: boolean;
	loadMoreFailed: boolean;
	onLoadMore: () => void;
	onViewRequests: (sessionId: string) => void;
}) {
	const [expandedId, setExpandedId] = useState<string | null>(null);
	const now = useNow(
		LIVE_LENGTH_REFRESH_MS,
		sessions.some((session) => isLiveSession(session)),
	);

	if (isError) {
		return (
			<p
				className="flex flex-wrap items-center gap-2 px-6 py-5 text-sm text-destructive"
				role="alert"
			>
				Could not load Parlume sessions.
				<button type="button" className="underline" onClick={onRetry}>
					Retry sessions
				</button>
			</p>
		);
	}
	if (isLoading) {
		return (
			<output className="block px-6 py-5 text-sm text-muted-foreground">
				Loading sessions…
			</output>
		);
	}
	if (sessions.length === 0) {
		return (
			<p className="px-6 py-10 text-center text-sm text-muted-foreground">
				No Parlume sessions yet.
			</p>
		);
	}

	return (
		<>
			<Table>
				<TableHeader>
					<TableRow className="bg-muted/40 hover:bg-muted/40">
						<TableHead className={`${HEAD_CLASS} pl-6`}>
							Session
						</TableHead>
						<TableHead className={`${HEAD_CLASS} max-sm:hidden`}>
							Mode
						</TableHead>
						<TableHead className={`${HEAD_CLASS} max-sm:hidden`}>
							Length
						</TableHead>
						<TableHead className={HEAD_CLASS}>Outcome</TableHead>
						<TableHead className={`${HEAD_CLASS} text-right`}>
							Cost
						</TableHead>
						<TableHead className="w-10 pr-6">
							<span className="sr-only">Details</span>
						</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{sessions.map((session) => (
						<ParlumeSessionRow
							key={session.id}
							session={session}
							cost={costBySessionId.get(session.id)}
							now={now}
							expanded={expandedId === session.id}
							onToggle={() =>
								setExpandedId(
									expandedId === session.id
										? null
										: session.id,
								)
							}
							projectBasePath={projectBasePath}
							onViewRequests={onViewRequests}
						/>
					))}
				</TableBody>
			</Table>
			{(loadMoreFailed || hasNextPage) && (
				<div className="space-y-3 px-6 py-4">
					{loadMoreFailed && (
						<p role="alert" className="text-sm text-destructive">
							Could not load older sessions. Try again.
						</p>
					)}
					{hasNextPage && (
						<Button
							type="button"
							variant="outline"
							autoLoading={false}
							onClick={onLoadMore}
							disabled={isFetchingNextPage}
						>
							{isFetchingNextPage
								? "Loading…"
								: "Show older sessions"}
						</Button>
					)}
				</div>
			)}
		</>
	);
}
