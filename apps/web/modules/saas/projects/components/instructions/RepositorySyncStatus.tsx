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
	type FabricCopyState,
	fabricCopyState,
} from "../../lib/instructions-copy-state";
import {
	type RepositoryMigrationControls,
	type RepositorySyncState,
	type SyncRunProgress,
	settledByRetry,
	shortCommit,
	syncErrorMessage,
	syncOutcomeMessage,
	syncRunOutcome,
	syncRunProgress,
	triggerLabelKey,
} from "../../lib/instructions-repository-sync";
import { SyncProgressLine } from "../repository-sync/SyncProgressLine";
import {
	MigrationEndedNoticeLine,
	RepositoryMigrationStatus,
} from "./RepositoryMigrationStatus";

/**
 * The commit and branch the published version was synced from, which Fabric's
 * copy is compared against. Which version, repository, branch and commit is
 * published is already said by the summary line above this block, so the block
 * does not say it again.
 */
type PublishedSource = {
	sourceCommitSha: string | null;
	sourceRef: string | null;
};

/**
 * The tab speaks state, not commands: under the summary, whether Fabric's copy
 * is what the last sync took and if not why (a commit the secret scan refused,
 * a sync that failed), the last sync's outcome, whether automatic sync is on,
 * and the one thing the tab cannot know — the state of anyone's own checkout
 * (design 2026-09-23 §7.3; Fizzy #2878). Everyone who can read the tab sees
 * it; its actions exist only when the tab passes the callbacks, which it does
 * for configurers.
 *
 * A REJECTED run's detail is the rejected banner above, not this block;
 * `onSeeFindings` is what takes the reader there.
 */
export function RepositorySyncStatus({
	projectId,
	migration,
	canManageMigration = false,
	onMigrationChanged,
	...lines
}: SyncLinesProps & {
	/**
	 * What the tab hands the move of uploaded instructions into a repository
	 * (Fizzy #2878 §9), with the project's id for its commands. While the sync
	 * state names a move, its status takes the place of the sync lines (the sync
	 * the move created is paused); once a move that ended without its files
	 * landing is gone, its notice stands above them until it is dismissed.
	 */
	projectId?: string;
	migration?: RepositoryMigrationControls;
	/** The member may create and update, so may cancel or retry the move. */
	canManageMigration?: boolean;
	onMigrationChanged?: () => Promise<void> | void;
}) {
	if (lines.state.migration && projectId !== undefined) {
		return (
			<RepositoryMigrationStatus
				projectId={projectId}
				state={lines.state}
				migration={migration}
				canManage={canManageMigration}
				onChanged={onMigrationChanged ?? (() => {})}
			/>
		);
	}
	return (
		<>
			{migration?.endedNotice ? (
				<MigrationEndedNoticeLine
					notice={migration.endedNotice}
					onDismiss={migration.onDismissEndedNotice}
				/>
			) : null}
			<SyncLines {...lines} />
		</>
	);
}

type SyncLinesProps = {
	state: RepositorySyncState;
	/**
	 * The version now published. A run whose staged version was stuck in its
	 * checks and has since been retried to publication is not a failure any
	 * more.
	 */
	publishedVersion?: number | null;
	/** The published version's source, when it came from the repository. */
	published?: PublishedSource | null;
	/**
	 * A commit made from this tab that Fabric's copy has not taken yet (Fizzy
	 * #2878 §10): the push landed, and the sync of the real tree that publishes
	 * it follows within seconds. Said in place of the copy line, which would
	 * otherwise call Fabric's copy behind the very commit that is on its way.
	 */
	syncingCommit?: { sha: string; ref: string } | null;
	onSyncNow?: () => void;
	onConfigure?: () => void;
	/** Present while a rejected-version banner is on the page to point at. */
	onSeeFindings?: () => void;
	/** This run's ready snapshot is waiting for the published pointer. */
	publishing?: boolean;
};

function SyncLines({
	state,
	onSyncNow,
	onConfigure,
	onSeeFindings,
	publishedVersion = null,
	published = null,
	publishing = false,
	syncingCommit = null,
}: SyncLinesProps) {
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
		settled ??
		(outcome ? syncOutcomeMessage(outcome, run?.commitSha ?? null) : null);
	// Fabric's copy, against the branch's tip. Computed against the published
	// version only when it came from the repository: an upload-sourced version
	// has no commit to compare.
	const copy =
		published && published.sourceCommitSha !== null
			? fabricCopyState(state, published)
			: ({ kind: "unknown" } as const);
	// A failure that explains why Fabric's copy is behind is said once, in the
	// copy line, not again under the last-run line.
	const errorMessage =
		!settled && outcome?.kind === "failed" && copy.kind !== "behind-error"
			? syncErrorMessage(outcome, configuration)
			: null;
	const ref = configuration?.ref ?? published?.sourceRef ?? "";
	return (
		<div
			role="status"
			aria-live="polite"
			// `empty:sr-only`: with nothing inside it takes no room and adds no
			// gap, but stays in the accessibility tree (`hidden` would not).
			className="flex flex-col gap-1 text-sm empty:sr-only"
		>
			{syncingCommit ? (
				<p
					className="inline-flex items-center gap-1.5 text-primary"
					data-testid="repository-sync-copy"
				>
					<Loader2Icon
						className="size-3.5 motion-safe:animate-spin"
						aria-hidden="true"
					/>
					{t("status.copySyncingCommit", {
						commit: shortCommit(syncingCommit.sha) ?? "",
						ref: syncingCommit.ref,
					})}
				</p>
			) : copy.kind !== "unknown" ? (
				<p
					className={
						copy.kind === "refused" || copy.kind === "behind-error"
							? "text-destructive"
							: "text-muted-foreground"
					}
					data-testid="repository-sync-copy"
				>
					{copyLine(copy, ref, t)}
					{copy.kind === "refused" && onSeeFindings ? (
						<>
							{" "}
							<Button
								size="sm"
								variant="link"
								className="h-auto px-0"
								onClick={onSeeFindings}
							>
								{t("status.seeFindings")}
							</Button>
						</>
					) : null}
				</p>
			) : null}
			{running && publishing ? (
				<div className="text-primary">
					<SyncProgressLine
						phase={tChecks("publishing")}
						text={tChecks("publishing")}
						testId="repository-sync-progress"
					/>
				</div>
			) : running && progress ? (
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
			) : configuration ? (
				<p className="text-muted-foreground">
					{t(
						configuration.automatic
							? configuration.provider === "GITHUB"
								? "status.automaticOnPush"
								: "status.automaticOnPoll"
							: "status.automaticOff",
					)}
				</p>
			) : null}
			{configuration ? (
				<p className="text-muted-foreground">
					{t("status.checkoutNote")}
				</p>
			) : null}
		</div>
	);
}

/** The line about Fabric's copy against the branch's tip. */
function copyLine(
	copy: Exclude<FabricCopyState, { kind: "unknown" }>,
	ref: string,
	t: Translate,
): string {
	switch (copy.kind) {
		case "current":
			return t("status.copyCurrent", {
				ref,
				time: formatRelativeTime(copy.syncedAt),
			});
		case "refused":
			return copy.commit
				? t("status.copyRefused", {
						ref,
						commit: shortCommit(copy.commit) ?? "",
						time: formatRelativeTime(copy.at),
					})
				: t("status.copyRefusedNoCommit", {
						ref,
						time: formatRelativeTime(copy.at),
					});
		case "behind-error":
			return t("status.copyBehindError", {
				ref,
				error: t(copy.message.key, copy.message.values),
			});
		default: {
			const unreachable: never = copy;
			return unreachable;
		}
	}
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
