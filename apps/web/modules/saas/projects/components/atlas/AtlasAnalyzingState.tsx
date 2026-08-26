"use client";

/**
 * In-flight ("Analyzing…") state for the Atlas tab.
 *
 * Beyond the spinner it shows a live elapsed timer (driven off the run's
 * `inFlightSince` timestamp) and, once a run crosses the long-run threshold, a
 * reassuring note that large repositories take a while and the work continues
 * in the background. This keeps a legitimately long analysis legible instead of
 * an indefinite, silent spinner. A genuinely interrupted run is surfaced as a
 * failure separately (the server self-heals an orphaned run to FAILED, which
 * renders the dedicated failed state with a retry).
 *
 * A "Cancel analysis" affordance lets the user stop a run they no longer want
 * (e.g. wrong branch, huge repo) — guarded behind a confirm dialog. The cancel
 * mutation itself lives in the parent (`ProjectAtlas`); this component
 * just surfaces the button + confirmation and reports the confirmed intent.
 */
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ui/components/alert-dialog";
import { Button } from "@ui/components/button";
import {
	EmptyState,
	EmptyStateDescription,
	EmptyStateIcon,
	EmptyStateTitle,
} from "@ui/components/empty-state";
import { Loader2Icon, XCircleIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

/** After this long we reassure the user the (still-healthy) run is just large. */
const LONG_RUN_MS = 10 * 60 * 1000;

function formatElapsed(ms: number): string {
	const totalMinutes = Math.floor(ms / 60_000);
	if (totalMinutes < 1) {
		return "<1m";
	}
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export function AtlasAnalyzingState({
	inFlightSince,
	onCancel,
	isCancelling = false,
}: {
	inFlightSince: string | null;
	/** Invoked once the user confirms cancellation. Omit to hide the control. */
	onCancel?: () => void;
	isCancelling?: boolean;
}) {
	const t = useTranslations("projects.atlas");
	const [now, setNow] = useState(() => Date.now());
	const [confirmOpen, setConfirmOpen] = useState(false);

	// Tick while a run is in flight so the elapsed label advances even when the
	// polled status payload is byte-identical between refetches.
	useEffect(() => {
		if (!inFlightSince) {
			return;
		}
		const id = setInterval(() => setNow(Date.now()), 15_000);
		return () => clearInterval(id);
	}, [inFlightSince]);

	const elapsedMs = inFlightSince
		? Math.max(0, now - new Date(inFlightSince).getTime())
		: null;
	const isLongRunning = elapsedMs !== null && elapsedMs > LONG_RUN_MS;

	return (
		<div className="rounded-2xl border border-border/60 bg-card/70 py-16">
			<EmptyState>
				<EmptyStateIcon>
					<Loader2Icon
						aria-hidden="true"
						className="size-10 text-primary motion-safe:animate-spin"
					/>
				</EmptyStateIcon>
				<EmptyStateTitle className="font-serif text-2xl font-normal">
					{t("analyzing.title")}
				</EmptyStateTitle>
				<EmptyStateDescription className="max-w-md">
					{t("analyzing.description")}
				</EmptyStateDescription>
				{elapsedMs !== null && (
					<p
						className="mt-1 text-muted-foreground/80 text-xs tabular-nums"
						aria-live="polite"
					>
						{t("analyzing.elapsed", {
							elapsed: formatElapsed(elapsedMs),
						})}
					</p>
				)}
				{isLongRunning && (
					<p className="mt-2 max-w-md text-muted-foreground text-xs">
						{t("analyzing.longRunning")}
					</p>
				)}
				{onCancel && (
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onClick={() => setConfirmOpen(true)}
						disabled={isCancelling}
						className="mt-4 gap-1.5 text-muted-foreground hover:text-destructive"
					>
						{isCancelling ? (
							<Loader2Icon
								aria-hidden="true"
								className="size-4 motion-safe:animate-spin"
							/>
						) : (
							<XCircleIcon
								aria-hidden="true"
								className="size-4"
							/>
						)}
						{t("cancel.button")}
					</Button>
				)}
			</EmptyState>

			{onCancel && (
				<AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>
								{t("cancel.confirmTitle")}
							</AlertDialogTitle>
							<AlertDialogDescription>
								{t("cancel.confirmBody")}
							</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel disabled={isCancelling}>
								{t("cancel.confirmKeep")}
							</AlertDialogCancel>
							<AlertDialogAction
								onClick={(e) => {
									e.preventDefault();
									onCancel();
								}}
								disabled={isCancelling}
								variant="destructive"
							>
								{isCancelling ? (
									<>
										<Loader2Icon className="mr-2 size-4 motion-safe:animate-spin" />
										{t("cancel.confirmPending")}
									</>
								) : (
									t("cancel.confirmAccept")
								)}
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			)}
		</div>
	);
}
