"use client";

import { Button } from "@ui/components/button";
import { CircleDashed } from "lucide-react";
import {
	type ChatTurnTruncation,
	CONTINUE_PROMPT,
	TRUNCATION_NOTICE_COPY,
} from "../../../lib/chat-turn-truncation";

/**
 * Says, under an answer, that it stopped on a limit rather than finishing —
 * and, on the latest turn, offers to pick it back up (review F25).
 */
export function TruncationNotice({
	truncated,
	onContinue,
	disabled,
}: {
	truncated: ChatTurnTruncation;
	/** Omitted on older turns: continuing only makes sense from the last one. */
	onContinue?: (prompt: string) => void;
	disabled?: boolean;
}) {
	return (
		<div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-muted-foreground text-xs">
			<span className="flex items-center gap-1.5">
				<CircleDashed className="size-3 shrink-0" aria-hidden />
				{TRUNCATION_NOTICE_COPY[truncated]}
			</span>
			{onContinue && (
				<Button
					type="button"
					variant="outline"
					size="sm"
					className="h-6 px-2 text-xs"
					disabled={disabled}
					onClick={() => onContinue(CONTINUE_PROMPT)}
				>
					Continue
				</Button>
			)}
		</div>
	);
}
