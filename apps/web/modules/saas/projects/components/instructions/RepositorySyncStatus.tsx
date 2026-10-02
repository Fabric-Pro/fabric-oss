"use client";

import { formatRelativeTime } from "@saas/shared/lib/format-time";
import { Button } from "@ui/components/button";
import { Loader2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import {
	checkPhaseMessageKey,
	checkProgressMessageKey,
} from "../../lib/instructions-check-progress";
import {
	type RepositorySyncState,
	type SyncRunProgress,
	settledByRetry,
	syncErrorMessage,
	syncOutcomeMessage,
	syncRunOutcome,
	syncRunProgress,
	triggerLabelKey,
} from "../../lib/instructions-repository-sync";
import { SyncProgressLine } from "../repository-sync/SyncProgressLine";

/**
 * The last repository sync, under the tab's summary: outcome, trigger and
 * time (design 2026-09-23 §7.3). Everyone who can read the tab sees it; its
 * actions exist only when the tab passes the callbacks, which it does for
 * configurers.
 *
 * A REJECTED run's detail is the rejected banner above, not this line.
 */
export function RepositorySyncStatus({
	state,
	onSyncNow,
	onConfigure,
	publishedVersion = null,
}: {
	state: RepositorySyncState;
	/**
	 * The version now published. A run whose staged version was stuck in its
	 * checks and has since been retried to publication is not a failure any
	 * more.
	 */
	publishedVersion?: number | null;
	onSyncNow?: () => void;
	onConfigure?: () => void;
}) {
	const t = useTranslations("projects.codingInstructions.repositorySync");
	// The snapshot's own check phases are worded where an upload's are.
	const tChecks = useTranslations(
		"projects.codingInstructions.publishedView",
	);
	// A run of a sync that was switched off belongs to History, not to the
	// line about this configuration: after a switch to upload mode it would
	// describe a sync that no longer exists and offer to run it again.
	const run =
		state.latestRun?.fromCurrentConfiguration === false
			? null
			: state.latestRun;
	const configuration = state.configured;
	// `state.running` is the project's (a sync workflow is open), not this
	// configuration's. A run left going by a switch to upload mode, or by a
	// switch-off-and-set-up-again whose old receipt is still the latest, is
	// the switched-off sync's: History shows it, this line does not.
	const running =
		state.running &&
		configuration !== null &&
		state.latestRun?.fromCurrentConfiguration !== false;
	const progress = running ? syncRunProgress(state) : null;
	const paused =
		configuration?.automatic && configuration.automaticPausedReason
			? configuration.automaticPausedReason
			: null;
	// Mounted for as long as a sync is configured, even with nothing to say:
	// a live region that appears already holding its text is often not
	// announced, so the run starting, finishing or failing has to land in a
	// region that was already there.
	if (configuration === null && !run) {
		return null;
	}
	const outcome = run ? syncRunOutcome(run, running) : null;
	const settled = outcome ? settledByRetry(outcome, publishedVersion) : null;
	const outcomeMessage =
		settled ?? (outcome ? syncOutcomeMessage(outcome) : null);
	const errorMessage =
		!settled && outcome?.kind === "failed"
			? syncErrorMessage(outcome, configuration)
			: null;
	return (
		<div
			role="status"
			aria-live="polite"
			// `empty:sr-only`: with nothing inside it takes no room and adds no
			// gap, but stays in the accessibility tree (`hidden` would not).
			className="flex flex-col gap-1 text-sm empty:sr-only"
		>
			{running && progress ? (
				// Only the phase is announced; the count beside it is not read
				// out on every poll (`SyncProgressLine`).
				<div className="text-primary">
					<SyncProgressLine
						{...progressLine(progress, t, tChecks)}
						testId="repository-sync-progress"
					/>
				</div>
			) : running ? (
				<p className="inline-flex items-center gap-1.5 text-primary">
					<Loader2Icon
						className="size-3.5 motion-safe:animate-spin"
						aria-hidden="true"
					/>
					{t("running")}
				</p>
			) : run && outcomeMessage ? (
				<p className="text-muted-foreground">
					{t(run.userName ? "lastRunBy" : "lastRun", {
						time: formatRelativeTime(run.startedAt),
						name: run.userName ?? "",
						trigger: t(triggerLabelKey(run.trigger)),
						outcome: t(outcomeMessage.key, outcomeMessage.values),
					})}
				</p>
			) : null}
			{!running && errorMessage ? (
				<p className="text-destructive">
					{t(errorMessage.key, errorMessage.values)}
				</p>
			) : null}
			{!running &&
			outcome?.kind === "not_published" &&
			outcome.reason === "configuration_changed" &&
			onSyncNow ? (
				<div>
					<Button size="sm" variant="outline" onClick={onSyncNow}>
						{t("syncAgainButton")}
					</Button>
				</div>
			) : null}
			{paused ? (
				<p className="flex items-center gap-2 text-muted-foreground">
					{t("pausedLine", { reason: t(`pausedReasons.${paused}`) })}
					{onConfigure ? (
						<Button
							size="sm"
							variant="link"
							className="h-auto px-0"
							onClick={onConfigure}
						>
							{t("reEnableButton")}
						</Button>
					) : null}
				</p>
			) : null}
		</div>
	);
}

type Translate = (
	key: string,
	values?: Record<string, string | number>,
) => string;

/**
 * The words for where an open run is: its own phase until the copy is done,
 * then the snapshot's check pass. The phase is the step's name alone (what a
 * screen reader hears); the text is the same step with its count.
 */
function progressLine(
	progress: SyncRunProgress,
	t: Translate,
	tChecks: Translate,
) {
	switch (progress.kind) {
		case "fetching":
			return { phase: t("fetching"), text: t("fetching") };
		case "preparing":
			return { phase: t("preparing"), text: t("preparing") };
		case "copying":
			return {
				phase: t("copyingPhase"),
				text: t("copying", {
					done: progress.done,
					total: progress.total,
				}),
				done: progress.done,
				total: progress.total,
			};
		case "checking":
			return {
				phase: tChecks(checkPhaseMessageKey(progress.phase)),
				text: tChecks(checkProgressMessageKey(progress.phase), {
					done: progress.done,
					total: progress.total,
				}),
				done: progress.done,
				total: progress.total,
			};
		default: {
			const unreachable: never = progress;
			return unreachable;
		}
	}
}
