"use client";

import { Button } from "@ui/components/button";
import { HistoryIcon } from "lucide-react";

/**
 * Said above a conversation that was reopened: it does not return to the page
 * it began on. What the drawer attaches (the project, the feature, the code in
 * view) is what is open now.
 */
export function ResumedSessionNote({ title }: { title: string | null }) {
	return (
		<div
			data-testid="resumed-session-note"
			className="flex items-start gap-2 border-b border-border bg-muted px-4 py-2 text-xs text-muted-foreground"
		>
			<HistoryIcon className="mt-0.5 size-3 shrink-0" aria-hidden />
			<p>
				{title?.trim() ? (
					<>
						Continuing{" "}
						<span className="font-medium text-foreground">
							{title.trim()}
						</span>
						.{" "}
					</>
				) : null}
				This conversation continues with the context of the page you are
				on now.
			</p>
		</div>
	);
}

/** A conversation that was chosen and is gone: deleted since the list was drawn. */
export function ResumedSessionGone({
	onStartOver,
}: {
	onStartOver: () => void;
}) {
	return (
		<div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
			<p role="alert" className="text-sm text-muted-foreground">
				That conversation is no longer available.
			</p>
			<Button variant="outline" size="sm" onClick={onStartOver}>
				Start a new chat
			</Button>
		</div>
	);
}

/** A conversation that could not be read, which is not the same as being gone: it may be there. */
export function ResumedSessionFailed({
	onRetry,
	onStartOver,
}: {
	onRetry: () => void;
	onStartOver: () => void;
}) {
	return (
		<div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
			<p role="alert" className="text-sm text-muted-foreground">
				Could not load this conversation.
			</p>
			<div className="flex flex-wrap items-center justify-center gap-2">
				<Button variant="outline" size="sm" onClick={onRetry}>
					Try again
				</Button>
				<Button variant="ghost" size="sm" onClick={onStartOver}>
					Start a new chat
				</Button>
			</div>
		</div>
	);
}
