"use client";

import { formatRelativeTime } from "@saas/shared/lib/format-time";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";

const SHOWN_PATHS = 10;

/**
 * "What changed since your last visit" on the Coding Instructions tab: the
 * versions published since, the files that differ, and the proposals
 * decided since, until the person marks them seen.
 *
 * Mounted only while the tab is on screen, so its mount is a real view. A
 * first visit (no marker) and a visit with nothing new record the marker
 * silently; a digest with news stays until "Mark all as seen". The marker
 * names the version this panel was shown, so a version published meanwhile
 * still shows next time.
 */
export function InstructionsDigestPanel({ projectId }: { projectId: string }) {
	const t = useTranslations("projects.codingInstructions.digest");
	const queryClient = useQueryClient();
	const digestOptions = orpc.projects.instructions.getDigest.queryOptions({
		input: { projectId },
	});
	const digest = useQuery(digestOptions);
	const markSeen = useMutation(
		orpc.projects.instructions.markSeen.mutationOptions({
			onSuccess: () =>
				queryClient.invalidateQueries({
					queryKey: digestOptions.queryKey,
				}),
		}),
	);
	const recordedFor = useRef<string | null>(null);
	const data = digest.data;
	const quietSeen =
		data !== undefined && (data.firstVisit || !data.hasChanges);
	const currentSnapshotId = data?.current?.snapshotId ?? null;

	useEffect(() => {
		const key = currentSnapshotId ?? "";
		if (!quietSeen || recordedFor.current === key) {
			return;
		}
		recordedFor.current = key;
		markSeen.mutate({ projectId, snapshotId: currentSnapshotId });
	}, [quietSeen, currentSnapshotId, projectId, markSeen.mutate]);

	if (!data || data.firstVisit || !data.hasChanges) {
		return null;
	}
	const paths = data.paths
		? [
				...data.paths.added.map((file) => ({
					path: file.path,
					change: "added" as const,
				})),
				...data.paths.changed.map((file) => ({
					path: file.path,
					change: "changed" as const,
				})),
				...data.paths.removed.map((file) => ({
					path: file.path,
					change: "removed" as const,
				})),
			]
		: [];

	return (
		<section
			aria-labelledby={`${projectId}-instructions-digest`}
			className="flex flex-col gap-3 rounded-lg border bg-card p-4"
			data-testid="instructions-digest"
		>
			<div className="flex flex-wrap items-baseline justify-between gap-2">
				<h2
					id={`${projectId}-instructions-digest`}
					className="font-semibold text-muted-foreground text-xs uppercase tracking-[0.2em]"
				>
					{t("title")}
				</h2>
				<span className="text-muted-foreground text-xs">
					{t("since", { time: formatRelativeTime(data.seen.seenAt) })}
				</span>
			</div>
			{data.versions.length > 0 ? (
				<div className="flex flex-col gap-1">
					<h3 className="font-medium text-sm">
						{t("versionsTitle", { count: data.versions.length })}
					</h3>
					<ul className="flex flex-col gap-0.5 text-sm">
						{data.versions.map((version) => (
							<li key={version.snapshotId}>
								{version.source === "REPOSITORY"
									? t("versionFromRepository", {
											version: version.version,
											ref:
												version.sourceRef ??
												t("repository"),
											sha: version.shortCommitSha ?? "",
										})
									: t("versionUploaded", {
											version: version.version,
											name:
												version.author.name ??
												t("teammate"),
										})}
							</li>
						))}
					</ul>
				</div>
			) : null}
			{data.paths ? (
				<div className="flex flex-col gap-1">
					<h3 className="font-medium text-sm">
						{t("pathsTitle", {
							count: paths.length,
							from: data.seen.version ?? 0,
							to: data.current?.version ?? 0,
						})}
					</h3>
					<ul className="flex flex-col gap-0.5 text-xs">
						{paths.slice(0, SHOWN_PATHS).map((entry) => (
							<li key={entry.path} className="flex gap-2">
								<span className="text-muted-foreground">
									{t(`change.${entry.change}`)}
								</span>
								<code className="min-w-0 truncate">
									{entry.path}
								</code>
							</li>
						))}
					</ul>
					{paths.length > SHOWN_PATHS ? (
						<p className="text-muted-foreground text-xs">
							{t("morePaths", {
								count: paths.length - SHOWN_PATHS,
							})}
						</p>
					) : null}
				</div>
			) : data.seen.comparable || data.seen.version === null ? null : (
				// A marker with no version was recorded while nothing was
				// published, so there is no earlier version to have lost: the
				// versions listed above are the whole news.
				<p className="text-muted-foreground text-xs">
					{t("seenVersionGone", { version: data.seen.version })}
				</p>
			)}
			{data.proposals.length > 0 ? (
				<div className="flex flex-col gap-1">
					<h3 className="font-medium text-sm">
						{t("proposalsTitle", { count: data.proposals.length })}
					</h3>
					<ul className="flex flex-col gap-0.5 text-sm">
						{data.proposals.map((proposal) => (
							<li key={proposal.id}>
								{t(
									proposal.status === "APPROVED"
										? "proposalApproved"
										: "proposalRejected",
									{
										title:
											proposal.title ??
											t("proposalVersion", {
												version: proposal.version,
											}),
										name:
											proposal.reviewer?.name ??
											t("teammate"),
									},
								)}
							</li>
						))}
					</ul>
				</div>
			) : null}
			<Button
				variant="outline"
				size="sm"
				className="self-end"
				disabled={markSeen.isPending}
				onClick={() =>
					markSeen.mutate({
						projectId,
						snapshotId: currentSnapshotId,
					})
				}
			>
				{t("markSeen")}
			</Button>
		</section>
	);
}
