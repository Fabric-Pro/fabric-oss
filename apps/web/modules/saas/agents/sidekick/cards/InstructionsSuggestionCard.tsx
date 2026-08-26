"use client";

import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card, CardContent } from "@ui/components/card";
import { Eye, FileText } from "lucide-react";
import { memo, useCallback, useMemo } from "react";
import type { AgentSuggestionRecord } from "../SidekickSuggestionsContext";
import {
	SuggestionActionButtons,
	stripHtml,
	suggestionStateStyles,
} from "./shared";

// ---- Types ----

interface InstructionsPayload {
	type: "replace";
	content: string;
	targetBlockId: string;
}

interface InstructionsSuggestionCardProps {
	suggestion: AgentSuggestionRecord;
	onAccept: (suggestion: AgentSuggestionRecord) => Promise<boolean>;
	onReject: (suggestion: AgentSuggestionRecord) => Promise<boolean>;
	onFocus?: (targetBlockId: string) => void;
}

// ---- Component ----

export const InstructionsSuggestionCard = memo(
	function InstructionsSuggestionCard({
		suggestion,
		onAccept,
		onReject,
		onFocus,
	}: InstructionsSuggestionCardProps) {
		const { state, title, description, payload } = suggestion;
		const isActionable = state === "pending";

		const preview = useMemo(() => {
			const p = payload as InstructionsPayload | null;
			if (!p?.content) {
				return null;
			}
			return stripHtml(p.content, 120);
		}, [payload]);

		const targetBlockId = (payload as InstructionsPayload | null)
			?.targetBlockId;

		const handleAccept = useCallback(async () => {
			await onAccept(suggestion);
		}, [onAccept, suggestion]);

		const handleReject = useCallback(async () => {
			await onReject(suggestion);
		}, [onReject, suggestion]);

		const handleFocus = useCallback(() => {
			if (targetBlockId && onFocus) {
				onFocus(targetBlockId);
			}
		}, [targetBlockId, onFocus]);

		return (
			<Card className={`my-2 ${suggestionStateStyles[state]}`}>
				<CardContent className="flex items-start gap-3 p-3">
					{/* Icon */}
					<div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
						<FileText className="h-3.5 w-3.5" />
					</div>

					{/* Content */}
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
						{preview && isActionable && (
							<p className="mt-1.5 rounded bg-muted/50 px-2 py-1 font-mono text-[11px] text-muted-foreground line-clamp-3">
								{preview}
							</p>
						)}
					</div>

					{/* Actions */}
					{isActionable && (
						<div className="flex shrink-0 gap-1">
							{targetBlockId && onFocus && (
								<Button
									size="sm"
									variant="ghost"
									className="h-7 w-7 p-0 text-muted-foreground hover:bg-muted hover:text-foreground"
									onClick={handleFocus}
									aria-label="Focus on block in editor"
								>
									<Eye className="h-3.5 w-3.5" />
								</Button>
							)}
							<SuggestionActionButtons
								onAccept={handleAccept}
								onReject={handleReject}
							/>
						</div>
					)}
				</CardContent>
			</Card>
		);
	},
);
