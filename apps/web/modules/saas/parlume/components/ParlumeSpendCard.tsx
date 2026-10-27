"use client";

import { Card } from "@ui/components/card";
import { Progress } from "@ui/components/progress";
import {
	formatCost,
	formatShortDate,
	type ParlumeSession,
	type ParlumeUsage,
} from "../lib/parlume-format";
import { CARD_TITLE, MONO_LABEL } from "../lib/parlume-styles";

const TOP_SESSIONS = 3;
const MIN_BAR_PERCENT = 3;

/** The project's Parlume spend, with its costliest sessions among those loaded. */
export function ParlumeSpendCard({
	usage,
	isLoading,
	isError,
	sessions,
	sessionCount,
	costBySessionId,
}: {
	usage: ParlumeUsage | undefined;
	isLoading: boolean;
	isError: boolean;
	sessions: ParlumeSession[];
	sessionCount: number | null;
	costBySessionId: ReadonlyMap<string, number>;
}) {
	const costliest = sessions
		.map((session) => ({
			session,
			cost: costBySessionId.get(session.id) ?? 0,
		}))
		.filter((entry) => entry.cost > 0)
		.sort((a, b) => b.cost - a.cost)
		.slice(0, TOP_SESSIONS);
	const largest = costliest[0]?.cost ?? 1;

	return (
		<Card className="space-y-4.5 px-6 pt-5.5 pb-6">
			<div className="flex items-baseline justify-between gap-2">
				<h3 className={CARD_TITLE}>Spend</h3>
				<span className={MONO_LABEL}>This project</span>
			</div>
			{isError ? (
				<p role="alert" className="text-sm text-destructive">
					Could not load Parlume spend.
				</p>
			) : isLoading || !usage ? (
				<output className="block text-sm text-muted-foreground">
					Loading spend…
				</output>
			) : (
				<>
					<div className="space-y-0.5">
						<p className="text-[32px] leading-9 font-medium tracking-tight tabular-nums">
							{formatCost(usage.totalCostMicroUsd)}
						</p>
						{sessionCount !== null && (
							<p className="text-[13px] leading-[18px] text-muted-foreground">
								{sessionCount}{" "}
								{sessionCount === 1 ? "session" : "sessions"}
							</p>
						)}
					</div>
					{costliest.length > 0 && (
						<ul
							aria-label="Costliest sessions"
							className="space-y-3 border-t border-border pt-3.5"
						>
							{costliest.map(({ session, cost }) => {
								const label = `${formatShortDate(session.createdAt)} · ${session.agentLabel}`;
								return (
									<li
										key={session.id}
										className="space-y-1.5"
									>
										<div className="flex justify-between gap-2 text-[13px] leading-[18px]">
											<span className="truncate text-muted-foreground">
												{label}
											</span>
											<span className="tabular-nums">
												{formatCost(cost)}
											</span>
										</div>
										{/* The amount beside it says it; the bar only compares. */}
										<Progress
											className="h-1 bg-muted"
											aria-hidden="true"
											value={Math.max(
												MIN_BAR_PERCENT,
												(cost / largest) * 100,
											)}
										/>
									</li>
								);
							})}
						</ul>
					)}
				</>
			)}
			<p className="text-xs text-muted-foreground">
				Covers agent turns, realtime voice, speech, live transcription,
				meeting notes and meeting-provider bot time. A live meeting's
				bot and transcription time are added when it ends.
			</p>
		</Card>
	);
}
