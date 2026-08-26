"use client";

import { Badge } from "@ui/components/badge";
import { Card, CardContent } from "@ui/components/card";
import { Minus, Plus } from "lucide-react";
import { memo, useCallback } from "react";
import type { AgentSuggestionRecord } from "../SidekickSuggestionsContext";
import { SuggestionActionButtons, suggestionStateStyles } from "./shared";

interface ToolSuggestionPayload {
	action: "add" | "remove";
	toolId: string;
}

interface ToolSuggestionCardProps {
	suggestion: AgentSuggestionRecord;
	onAccept: (suggestion: AgentSuggestionRecord) => Promise<boolean>;
	onReject: (suggestion: AgentSuggestionRecord) => Promise<boolean>;
}

export const ToolSuggestionCard = memo(function ToolSuggestionCard({
	suggestion,
	onAccept,
	onReject,
}: ToolSuggestionCardProps) {
	const { state, title, description, payload } = suggestion;
	const isActionable = state === "pending";
	const action = (payload as ToolSuggestionPayload | null)?.action ?? "add";

	const handleAccept = useCallback(async () => {
		await onAccept(suggestion);
	}, [onAccept, suggestion]);

	const handleReject = useCallback(async () => {
		await onReject(suggestion);
	}, [onReject, suggestion]);

	return (
		<Card className={`my-2 ${suggestionStateStyles[state]}`}>
			<CardContent className="flex items-start gap-3 p-3">
				<div
					className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${
						action === "add"
							? "bg-secondary/10 text-secondary"
							: "bg-destructive/10 text-destructive"
					}`}
				>
					{action === "add" ? (
						<Plus className="h-3.5 w-3.5" />
					) : (
						<Minus className="h-3.5 w-3.5" />
					)}
				</div>

				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<span className="text-sm font-medium text-foreground">
							{title}
						</span>
						{state !== "pending" && (
							<Badge
								variant={
									state === "approved"
										? "default"
										: "secondary"
								}
								className="text-[10px] uppercase tracking-wider"
							>
								{state}
							</Badge>
						)}
					</div>
					{description && (
						<p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">
							{description}
						</p>
					)}
				</div>

				{isActionable && (
					<div className="flex shrink-0 gap-1">
						<SuggestionActionButtons
							onAccept={handleAccept}
							onReject={handleReject}
						/>
					</div>
				)}
			</CardContent>
		</Card>
	);
});
