"use client";

import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import {
	formatDuration,
	formatTimestamp,
	modeLabel,
	type ParlumeSession,
	statusLabel,
} from "../lib/parlume-format";

export function ParlumeLiveSession({
	session,
	now,
	canStop,
	isStopping,
	onStop,
}: {
	session: ParlumeSession;
	now: number;
	canStop: boolean;
	isStopping: boolean;
	onStop: (sessionId: string) => void;
}) {
	const started = session.joinedAt ?? session.createdAt;
	return (
		<Card>
			<CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 p-6 pb-2">
				<CardTitle className="text-base">Live session</CardTitle>
				<Badge
					variant={
						session.status === "STOP_FAILED" ? "error" : "success"
					}
				>
					{statusLabel(session.status)}
				</Badge>
			</CardHeader>
			<CardContent className="space-y-4 p-6 pt-0">
				<dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
					<div>
						<dt className="text-xs text-muted-foreground">Agent</dt>
						<dd className="font-medium">{session.agentLabel}</dd>
					</div>
					<div>
						<dt className="text-xs text-muted-foreground">Mode</dt>
						<dd>{modeLabel(session.toolsReadOnly)}</dd>
					</div>
					<div>
						<dt className="text-xs text-muted-foreground">
							{session.joinedAt ? "Joined" : "Invited"}
						</dt>
						<dd>{formatTimestamp(started)}</dd>
					</div>
					<div>
						<dt className="text-xs text-muted-foreground">
							Elapsed
						</dt>
						<dd>{formatDuration(started, now)}</dd>
					</div>
				</dl>
				{session.status === "STOP_FAILED" && (
					<p role="alert" className="text-sm text-destructive">
						Parlume could not confirm it left the meeting. Try
						stopping it again.
					</p>
				)}
				{canStop && (
					<Button
						type="button"
						variant="outline"
						onClick={() => onStop(session.id)}
						disabled={isStopping || session.status === "LEAVING"}
					>
						{isStopping || session.status === "LEAVING"
							? "Stopping…"
							: "Stop"}
					</Button>
				)}
			</CardContent>
		</Card>
	);
}
