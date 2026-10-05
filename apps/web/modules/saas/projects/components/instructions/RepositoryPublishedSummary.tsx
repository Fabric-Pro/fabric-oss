"use client";

import {
	type CommitRow,
	rowSubject,
} from "@saas/projects/lib/instructions-commits";
import { formatRelativeTime } from "@saas/shared/lib/format-time";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@ui/components/skeleton";
import { useTranslations } from "next-intl";

/**
 * The Published fact of a repository-backed project's status strip: who made
 * the commit Fabric's copy is of, when, and what they said, as git itself shows
 * it. The heading's pill already names the branch and the commit
 * (`main @ a1b2c3d`) and the Source fact the repository, so together they read
 * `main @ a1b2c3d`, `example-org/instructions @ main`, `Jane Doe · 2 hours ago
 * · “Tighten lint rules”`.
 *
 * The author, date and subject are the commit's own, so they come from the
 * branch's history (`listCommits`, the first page, the row for the published
 * commit): the sync records none of them on the version, which only knows who
 * ran it. When the commit is not on that page, or the history cannot be read,
 * the fact falls back to what the version itself knows, and says nothing wrong
 * in the meantime.
 */
export function RepositoryPublishedSummary({
	projectId,
	commitSha,
	version,
	fallbackName,
	fallbackTime,
	enabled,
}: {
	projectId: string;
	/** The commit the published version was taken from. */
	commitSha: string | null;
	version: number;
	/** Who ran the sync, for when the commit's own author is not to hand. */
	fallbackName: string;
	fallbackTime: string | Date;
	/** Whether the branch's history may be read: a confirmed, configured repository. */
	enabled: boolean;
}) {
	const t = useTranslations("projects.codingInstructions.publishedView");
	const history = useQuery({
		...orpc.projects.instructions.repositorySync.listCommits.queryOptions({
			input: { projectId, cursor: 1 },
		}),
		enabled,
		retry: false,
	});
	const commits = (history.data?.commits ?? []) as CommitRow[];
	const commit =
		commits.find((row) => row.sha === commitSha) ??
		commits.find((row) => row.published === version) ??
		null;

	if (enabled && history.isLoading) {
		return <Skeleton aria-busy="true" className="h-4 w-48 max-w-full" />;
	}
	if (commit === null) {
		return (
			<span data-testid="repository-published-summary">
				{t("statusPublishedBy", {
					name: fallbackName,
					time: formatRelativeTime(fallbackTime),
				})}
			</span>
		);
	}
	const subject = rowSubject(commit);
	return (
		<span
			className="[overflow-wrap:anywhere]"
			data-testid="repository-published-summary"
		>
			{subject === null
				? t("repositoryCommitLineWithheld", {
						author: commit.author.name || fallbackName,
						time: formatRelativeTime(commit.date),
					})
				: t("repositoryCommitLine", {
						author: commit.author.name || fallbackName,
						time: formatRelativeTime(commit.date),
						subject,
					})}
		</span>
	);
}
