"use client";

import { formatRelativeTime } from "@saas/shared/lib/format-time";
import { Button } from "@ui/components/button";
import { Loader2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import {
	type RepositorySyncState,
	syncErrorMessage,
	syncOutcomeMessage,
	syncRunOutcome,
} from "../../lib/instructions-repository-sync";

/**
 * The last repository sync, under the tab's summary (design 2026-09-23
 * §7.3). Everyone who can read the tab sees it; its actions exist only when
 * the tab passes the callbacks, which it does for configurers.
 *
 * A REJECTED run's detail is the rejected banner above, not this line.
 */
export function RepositorySyncStatus({
	state,
	onSyncNow,
	onConfigure,
}: {
	state: RepositorySyncState;
	onSyncNow?: () => void;
	onConfigure?: () => void;
}) {
	const t = useTranslations("projects.codingInstructions.repositorySync");
	const run = state.latestRun;
	const configuration = state.configured;
	const paused =
		configuration?.automatic && configuration.automaticPausedReason
			? configuration.automaticPausedReason
			: null;
	if (!state.running && !run && !paused) {
		return null;
	}
	const outcome = run ? syncRunOutcome(run, state.running) : null;
	const outcomeMessage = outcome ? syncOutcomeMessage(outcome) : null;
	const errorMessage =
		outcome?.kind === "failed"
			? syncErrorMessage(outcome.error, configuration)
			: null;
	return (
		<div
			role="status"
			aria-live="polite"
			className="flex flex-col gap-1 text-sm"
		>
			{state.running ? (
				<p className="inline-flex items-center gap-1.5 text-primary">
					<Loader2Icon
						className="size-3.5 animate-spin"
						aria-hidden="true"
					/>
					{t("running")}
				</p>
			) : run && outcomeMessage ? (
				<p className="text-muted-foreground">
					{t(run.userName ? "lastRunBy" : "lastRun", {
						time: formatRelativeTime(run.startedAt),
						name: run.userName ?? "",
						outcome: t(outcomeMessage.key, outcomeMessage.values),
					})}
				</p>
			) : null}
			{!state.running && errorMessage ? (
				<p className="text-destructive">
					{t(errorMessage.key, errorMessage.values)}
				</p>
			) : null}
			{!state.running &&
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
