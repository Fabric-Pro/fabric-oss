"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { formatCost, type ParlumeUsage } from "../lib/parlume-format";

export function ParlumeUsageTile({
	usage,
	isLoading,
	isError,
}: {
	usage: ParlumeUsage | undefined;
	isLoading: boolean;
	isError: boolean;
}) {
	return (
		<Card>
			<CardHeader className="p-6 pb-2">
				<CardTitle className="text-base">Spend</CardTitle>
			</CardHeader>
			<CardContent className="space-y-1 p-6 pt-0">
				{isError ? (
					<p role="alert" className="text-sm text-destructive">
						Could not load Parlume spend.
					</p>
				) : isLoading || !usage ? (
					<output className="text-sm text-muted-foreground">
						Loading spend…
					</output>
				) : (
					<>
						<p className="text-2xl font-semibold">
							{formatCost(usage.totalCostMicroUsd)}
						</p>
						<p className="text-sm text-muted-foreground">
							{usage.calls} {usage.calls === 1 ? "call" : "calls"}{" "}
							in this project
						</p>
					</>
				)}
				<p className="text-xs text-muted-foreground">
					Covers agent turns, speech, meeting notes and
					meeting-provider bot time.
				</p>
			</CardContent>
		</Card>
	);
}
