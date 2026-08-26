"use client";

import { Button } from "@ui/components/button";
import { AlertTriangle } from "lucide-react";
import { useEffect } from "react";

/**
 * Error-boundary fallback for the Nexus page.
 *
 * The Nexus surface (`CopilotPage`) is a large client component — chat,
 * streaming, history — that previously had no error boundary anywhere in its
 * route chain, so an unexpected render/runtime error blanked the whole page
 * with no way to recover. This renders a calm, reloadable panel instead, using
 * design-system tokens so it reads correctly in both light and dark themes.
 *
 * Rendered by the route-level `error.tsx` in both the personal and
 * organization Nexus segments.
 */
export function NexusError({
	error,
	reset,
}: {
	error: Error & { digest?: string };
	reset: () => void;
}) {
	useEffect(() => {
		console.error("[Nexus] Client-side error:", error);
	}, [error]);

	return (
		<div className="flex min-h-[60vh] items-center justify-center p-6">
			<div className="max-w-md text-center space-y-4">
				<AlertTriangle
					className="h-10 w-10 text-destructive mx-auto"
					aria-hidden="true"
				/>
				<h2 className="text-lg font-semibold">Something went wrong</h2>
				<p className="text-sm text-muted-foreground">
					The Fabric Agent workspace hit an unexpected error. Your
					conversations are saved — try again, or reload the page.
				</p>
				{error.digest && (
					<p className="text-xs text-muted-foreground font-mono">
						Error ID: {error.digest}
					</p>
				)}
				<div className="flex items-center justify-center gap-3 pt-2">
					<Button variant="outline" onClick={reset}>
						Try again
					</Button>
					<Button onClick={() => window.location.reload()}>
						Reload page
					</Button>
				</div>
			</div>
		</div>
	);
}
