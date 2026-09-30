"use client";

import { Badge } from "@ui/components/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import {
	endReasonLabel,
	formatCost,
	formatDuration,
	formatTimestamp,
	modeLabel,
	type ParlumeSession,
	statusLabel,
} from "../lib/parlume-format";

export function ParlumeSessionsList({
	sessions,
	costBySessionId,
	isLoading,
	isError,
	onRetry,
}: {
	sessions: ParlumeSession[];
	costBySessionId: ReadonlyMap<string, number>;
	isLoading: boolean;
	isError: boolean;
	onRetry: () => void;
}) {
	return (
		<Card>
			<CardHeader className="p-6 pb-4">
				<CardTitle className="text-base">Sessions</CardTitle>
			</CardHeader>
			<CardContent className="p-6 pt-0">
				{isError ? (
					<p
						className="flex flex-wrap items-center gap-2 text-sm text-destructive"
						role="alert"
					>
						Could not load Parlume sessions.
						<button
							type="button"
							className="underline"
							onClick={onRetry}
						>
							Retry sessions
						</button>
					</p>
				) : isLoading ? (
					<output className="text-sm text-muted-foreground">
						Loading sessions…
					</output>
				) : sessions.length === 0 ? (
					<p className="py-4 text-center text-sm text-muted-foreground">
						No Parlume sessions yet.
					</p>
				) : (
					<ol className="space-y-3">
						{sessions.map((session) => {
							const reason = endReasonLabel(session.endReason);
							const cost = costBySessionId.get(session.id);
							return (
								<li
									key={session.id}
									className="space-y-2 rounded-md border p-3 text-sm"
								>
									<div className="flex flex-wrap items-center justify-between gap-2">
										<p className="font-medium">
											{session.agentLabel}
										</p>
										<Badge
											variant={
												session.status === "FAILED"
													? "error"
													: "info"
											}
										>
											{statusLabel(session.status)}
										</Badge>
									</div>
									<p className="text-xs text-muted-foreground">
										{modeLabel(session.toolsReadOnly)} ·
										Started{" "}
										{formatTimestamp(
											session.joinedAt ??
												session.createdAt,
										)}
										{session.endedAt
											? ` · Ended ${formatTimestamp(session.endedAt)} · ${formatDuration(session.joinedAt, session.endedAt)}`
											: ""}
										{" · Cost "}
										{cost === undefined
											? "—"
											: formatCost(cost)}
									</p>
									{reason && <p>{reason}</p>}
									{session.lastError && (
										<p className="text-destructive">
											{session.lastError}
										</p>
									)}
									{session.notes && (
										<details>
											<summary className="cursor-pointer font-medium">
												Meeting notes
											</summary>
											<p className="mt-2 whitespace-pre-wrap text-muted-foreground">
												{session.notes}
											</p>
										</details>
									)}
									{session.transcriptContextId && (
										<p className="text-muted-foreground">
											Transcript saved in project Context
											{session.notes
												? ""
												: session.notesStatus ===
														"FAILED"
													? ". Meeting notes are unavailable."
													: ". Preparing meeting notes…"}
										</p>
									)}
								</li>
							);
						})}
					</ol>
				)}
			</CardContent>
		</Card>
	);
}
