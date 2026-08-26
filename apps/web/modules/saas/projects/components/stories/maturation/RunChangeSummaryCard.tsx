"use client";

import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Check, Loader2, Undo2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

type LatestRun = {
	version: number;
	changeSummary: string[];
	createdAt: Date;
};

type Props = {
	storyId: string;
	latestRun: LatestRun;
	/** Restore to the version BEFORE this run (`latestRun.version - 1`). */
	onRevert: () => void;
	isReverting: boolean;
};

/**
 * SSR-safe localStorage key for a per-story, per-run dismissal. Keyed by version
 * so a NEW run (new version) resurfaces a fresh card even if the prior one was
 * dismissed.
 */
function dismissKey(storyId: string, version: number): string {
	return `maturation:run-summary-dismissed:${storyId}:${version}`;
}

function readDismissed(storyId: string, version: number): boolean {
	if (typeof window === "undefined") {
		return false;
	}
	try {
		return (
			window.localStorage.getItem(dismissKey(storyId, version)) === "1"
		);
	} catch {
		return false;
	}
}

function writeDismissed(storyId: string, version: number): void {
	if (typeof window === "undefined") {
		return;
	}
	try {
		window.localStorage.setItem(dismissKey(storyId, version), "1");
	} catch {
		// Private mode / quota — dismissal just won't persist; non-fatal.
	}
}

/**
 * "Changes from this run" review card (v2 only). Renders the section-tagged
 * change bullets from the most recent maturation run with two soft review
 * actions: "Looks good" (client-side dismiss, persisted per run) and "Revert
 * this run" (confirm → restore to the pre-run version). Dismiss is scoped to the
 * run version, so the next run produces a fresh card.
 */
export function RunChangeSummaryCard({
	storyId,
	latestRun,
	onRevert,
	isReverting,
}: Props) {
	const t = useTranslations("projects.stories.maturation.runSummary");
	const [dismissed, setDismissed] = useState(false);
	const [confirmOpen, setConfirmOpen] = useState(false);

	// Read the persisted dismissal after mount (avoids an SSR/client mismatch)
	// and re-evaluate whenever the run version changes.
	useEffect(() => {
		setDismissed(readDismissed(storyId, latestRun.version));
	}, [storyId, latestRun.version]);

	if (dismissed) {
		return null;
	}

	const handleDismiss = () => {
		writeDismissed(storyId, latestRun.version);
		setDismissed(true);
	};

	const handleRevertConfirm = () => {
		setConfirmOpen(false);
		onRevert();
	};

	return (
		<div className="border-b bg-muted/40 px-6 py-4">
			<div className="mx-auto max-w-4xl">
				<div className="rounded-lg border bg-card p-4">
					<div className="flex items-start justify-between gap-3">
						<h3 className="editorial-label text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
							{t("heading")}
						</h3>
					</div>

					<ul className="mt-3 space-y-1.5">
						{latestRun.changeSummary.map((bullet) => (
							<li
								key={bullet}
								className="flex gap-2 text-sm leading-relaxed text-foreground"
							>
								<span
									aria-hidden="true"
									className="mt-2 size-1.5 shrink-0 rounded-full bg-muted-foreground/60"
								/>
								<span>{bullet}</span>
							</li>
						))}
					</ul>

					<div className="mt-4 flex items-center justify-end gap-2">
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={() => setConfirmOpen(true)}
							disabled={isReverting}
							className="gap-1.5 text-xs text-muted-foreground"
						>
							{isReverting ? (
								<Loader2 className="size-3.5 animate-spin" />
							) : (
								<Undo2 className="size-3.5" />
							)}
							{t("revert")}
						</Button>
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={handleDismiss}
							disabled={isReverting}
							className="gap-1.5 text-xs"
						>
							<Check className="size-3.5" />
							{t("looksGood")}
						</Button>
					</div>
				</div>
			</div>

			<Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>{t("confirmTitle")}</DialogTitle>
						<DialogDescription>
							{t("confirmBody")}
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={() => setConfirmOpen(false)}
							disabled={isReverting}
						>
							{t("confirmCancel")}
						</Button>
						<Button
							type="button"
							variant="destructive"
							onClick={handleRevertConfirm}
							disabled={isReverting}
							className="gap-1.5"
						>
							{isReverting && (
								<Loader2 className="size-3.5 animate-spin" />
							)}
							{t("confirmAction")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
