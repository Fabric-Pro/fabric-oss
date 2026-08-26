"use client";

import { pmDetectedTypeDisplayName } from "@repo/utils";
import { Button } from "@ui/components/button";
import { cn } from "@ui/lib";
import { RotateCcwIcon, SettingsIcon } from "lucide-react";

/**
 * Why the PM side of a sync conflict could not be loaded or pushed. Kept in
 * sync with `PmSyncErrorKind` in
 * packages/temporal/.../preview-pm-sync-conflict.ts and the `z.enum` in the
 * `checkPmSyncConflicts` / `resolveConflict` procedure outputs.
 */
export type PmSyncErrorKind =
	| "MISSING"
	| "EXPIRED"
	| "INVALID"
	| "DISABLED"
	| "NO_ACCESS"
	| "TRANSIENT"
	| "NOT_CONFIGURED";

export type PmSyncError = { kind: PmSyncErrorKind; code?: string };

type Copy = {
	title: string;
	body: string;
	/** Which affordance to offer: link to settings, retry, or none. */
	action: "settings" | "retry" | "none";
};

function toolLabel(pmTool: string | null): string {
	if (!pmTool) {
		return "your PM tool";
	}
	return pmDetectedTypeDisplayName(pmTool) ?? pmTool;
}

/**
 * Human copy for each failure kind. In the per-user model the PM connection is
 * each member's own — so MISSING means "you haven't connected your account",
 * NOT "you lack permission".
 */
export function pmSyncErrorCopy(
	kind: PmSyncErrorKind,
	pmTool: string | null,
): Copy {
	const tool = toolLabel(pmTool);
	switch (kind) {
		case "MISSING":
			return {
				title: `Connect your ${tool} account`,
				body: `Conflicts are resolved with your own ${tool} connection, and you haven't connected one yet. Connect ${tool} in settings to review and resolve this conflict.`,
				action: "settings",
			};
		case "EXPIRED":
			return {
				title: `Reconnect ${tool}`,
				body: `Your ${tool} connection has expired. Reconnect it in settings to review and resolve this conflict.`,
				action: "settings",
			};
		case "INVALID":
			return {
				title: `${tool} connection needs attention`,
				body: `Your ${tool} connection looks misconfigured. Check it in settings, then try again.`,
				action: "settings",
			};
		case "DISABLED":
			return {
				title: `${tool} is turned off`,
				body: `Your ${tool} connection is disabled. Enable it in settings to review and resolve this conflict.`,
				action: "settings",
			};
		case "NO_ACCESS":
			return {
				title: `No access to this board in ${tool}`,
				body: `Your ${tool} account can't access this project's board. Connect an account that has access, then try again.`,
				action: "settings",
			};
		case "TRANSIENT":
			return {
				title: `Couldn't reach ${tool}`,
				body: `We couldn't reach ${tool} just now. Try again in a moment.`,
				action: "retry",
			};
		case "NOT_CONFIGURED":
			return {
				title: "No PM tool is linked",
				body: "This project isn't linked to a project-management tool, so there's nothing to reconcile.",
				action: "none",
			};
	}
}

/**
 * Inline error state shown in place of the conflict diff when the current
 * user's PM connection can't load the PM side. Uses the warm-neutral design
 * tokens (editorial label, serif-free body) consistent with the resolve modal.
 */
export function PmSyncErrorPanel({
	error,
	pmTool,
	settingsHref,
	onRetry,
	className,
}: {
	error: PmSyncError;
	pmTool: string | null;
	settingsHref?: string;
	onRetry?: () => void;
	className?: string;
}) {
	const copy = pmSyncErrorCopy(error.kind, pmTool);
	return (
		<div
			className={cn(
				"flex flex-col items-start gap-3 rounded-md border border-border bg-muted/40 p-6",
				className,
			)}
			aria-live="polite"
		>
			<span className="editorial-label">PM TOOL UNAVAILABLE</span>
			<h3 className="font-medium text-base text-foreground">
				{copy.title}
			</h3>
			<p className="max-w-prose text-sm text-muted-foreground">
				{copy.body}
			</p>
			{copy.action === "settings" && settingsHref ? (
				<Button asChild size="sm" variant="outline">
					<a href={settingsHref}>
						<SettingsIcon
							className="size-3.5 mr-1.5"
							aria-hidden="true"
						/>
						Open settings
					</a>
				</Button>
			) : null}
			{copy.action === "retry" && onRetry ? (
				<Button size="sm" variant="outline" onClick={onRetry}>
					<RotateCcwIcon
						className="size-3.5 mr-1.5"
						aria-hidden="true"
					/>
					Try again
				</Button>
			) : null}
		</div>
	);
}
