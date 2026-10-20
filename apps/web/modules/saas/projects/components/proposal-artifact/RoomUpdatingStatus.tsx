"use client";

import { Button } from "@ui/components/button";
import { AlertTriangle, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";

/**
 * Where the sync pill is, while the room is behind the saved document: one
 * polite announcement while it is brought up to date, and a way out when it
 * could not be — one more attempt from the latest saved version.
 */
export function RoomUpdatingStatus({
	failed,
	onReloadLatest,
}: {
	failed: boolean;
	onReloadLatest: () => void;
}) {
	const tRoom = useTranslations("projects.documentEditorRoom");
	if (failed) {
		return (
			<div role="alert" className="flex items-center gap-2 text-xs">
				<AlertTriangle className="h-3 w-3 text-highlight" aria-hidden />
				<span>{tRoom("updateFailed")}</span>
				<Button
					type="button"
					size="sm"
					variant="outline"
					className="h-6 px-2 text-xs"
					onClick={onReloadLatest}
				>
					{tRoom("reloadLatest")}
				</Button>
			</div>
		);
	}
	return (
		<output
			aria-live="polite"
			className="flex items-center gap-1 text-xs text-muted-foreground"
		>
			<Loader2 className="h-3 w-3 animate-spin" aria-hidden />
			<span>{tRoom("updating")}</span>
		</output>
	);
}
