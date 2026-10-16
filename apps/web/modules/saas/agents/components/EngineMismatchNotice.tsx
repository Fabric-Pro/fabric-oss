"use client";

import { Button } from "@ui/components/button";
import { InfoIcon } from "lucide-react";

/**
 * Said at the top of a chat that is still on the engine it was started on, after the
 * interface mode changed to one whose new chats run elsewhere (Fizzy #3093).
 * Simple mode hides the engine pills that otherwise explain this, so without
 * it the next question quietly goes to the older engine.
 */
export function EngineMismatchNotice({ onNewChat }: { onNewChat: () => void }) {
	return (
		<output
			data-testid="engine-mismatch-notice"
			className="flex items-center gap-2 border-b border-border bg-muted px-4 py-2 text-xs text-muted-foreground"
		>
			<InfoIcon className="size-3.5 shrink-0" aria-hidden />
			<span className="min-w-0 flex-1">
				This chat uses Direct chat, which it was started on. Start a new
				chat to use the Advisor.
			</span>
			<Button
				type="button"
				variant="outline"
				size="sm"
				className="shrink-0"
				onClick={onNewChat}
			>
				New chat
			</Button>
		</output>
	);
}
