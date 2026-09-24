"use client";

import { formatRelativeTime } from "@saas/shared/lib/format-time";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import {
	type SyncRunView,
	shortCommit,
	syncOutcomeMessage,
	syncRunOutcome,
	triggerLabelKey,
} from "../../lib/instructions-repository-sync";

/**
 * History's "Sync runs" list (design 2026-09-23 §7.3): time, trigger,
 * outcome, commit, version and the member each run acted as, newest first.
 * Rendered inside the History dialog, so it is queried only while History
 * is open.
 */
export function RepositorySyncRuns({
	projectId,
	running,
}: {
	projectId: string;
	running: boolean;
}) {
	const t = useTranslations("projects.codingInstructions.repositorySync");
	const runs = useQuery(
		orpc.projects.instructions.repositorySync.listRuns.queryOptions({
			input: { projectId },
		}),
	);
	const rows =
		(runs.data as { runs?: SyncRunView[] } | undefined)?.runs ?? [];
	return (
		<section className="flex flex-col gap-2 border-border border-t pt-3">
			<h3 className="font-medium text-sm">{t("runs.title")}</h3>
			{runs.isError ? (
				<p role="alert" className="text-destructive text-xs">
					{t("runs.loadFailed")}
				</p>
			) : runs.isSuccess && rows.length === 0 ? (
				<p className="text-muted-foreground text-xs">
					{t("runs.empty")}
				</p>
			) : (
				<ul className="flex flex-col gap-1">
					{rows.map((run, index) => {
						// Only the newest row can still be in flight; an older
						// unfinished row's worker is gone.
						const message = syncOutcomeMessage(
							syncRunOutcome(run, running && index === 0),
						);
						const commit = shortCommit(run.commitSha);
						const parts = [
							formatRelativeTime(run.startedAt),
							t(triggerLabelKey(run.trigger)),
							t(message.key, message.values),
						];
						if (commit) {
							parts.push(t("runs.commit", { commit }));
						}
						if (run.snapshotVersion !== null) {
							parts.push(
								t("runs.version", {
									version: run.snapshotVersion,
								}),
							);
						}
						if (run.userName) {
							parts.push(t("runs.by", { name: run.userName }));
						}
						return (
							<li
								key={run.id}
								className="text-muted-foreground text-xs"
							>
								{parts.join(" · ")}
							</li>
						);
					})}
				</ul>
			)}
		</section>
	);
}
