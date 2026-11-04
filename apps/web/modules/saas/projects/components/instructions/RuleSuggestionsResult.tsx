"use client";

/**
 * What became of applied rules suggestions, as one compact line on Rules
 * health once the edits dialog has closed: "Committed 5 files · abc1234 ↗"
 * with a link to the commit, or "Pull request #12 ↗" when the branch sent
 * the commit to a pull request. The links are read the way the commit list
 * and the pull-request notice read them, and the line stands without them
 * (the sha alone, "Opening a pull request…") until they are known.
 */

import { safeHttpsUrl } from "@saas/projects/lib/instructions-direct-commit";
import { shortCommit } from "@saas/projects/lib/instructions-repository-sync";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import {
	CheckIcon,
	ExternalLinkIcon,
	GitPullRequestIcon,
	XIcon,
} from "lucide-react";

export type AppliedRuleSuggestions =
	| {
			kind: "committed";
			sha: string;
			files: number;
			/** The repository is read directly (`repository.*`), not through a sync. */
			direct: boolean;
	  }
	| { kind: "pull-request"; snapshotId: string | null; files: number };

function filesWord(files: number): string {
	return `${files} ${files === 1 ? "file" : "files"}`;
}

function ExternalLink({ href, children }: { href: string; children: string }) {
	return (
		<a
			href={href}
			target="_blank"
			rel="noopener noreferrer"
			className="inline-flex items-center gap-1 font-medium underline"
		>
			{children}
			<ExternalLinkIcon className="size-3" aria-hidden="true" />
			<span className="sr-only">(opens in a new tab)</span>
		</a>
	);
}

type CommitRow = { sha: string; url?: string | null };

function useCommitUrl(
	projectId: string,
	sha: string,
	direct: boolean,
): string | null {
	const state = useQuery({
		...orpc.projects.instructions.repository.getState.queryOptions({
			input: { projectId },
		}),
		enabled: direct,
	});
	const head = state.data as
		| {
				availability?: string;
				generation?: number;
				currentCommitSha?: string;
		  }
		| undefined;
	const pinned =
		direct &&
		head?.availability === "READY" &&
		head.currentCommitSha === sha &&
		typeof head.generation === "number";
	const directCommits = useQuery({
		...orpc.projects.instructions.repository.listCommits.queryOptions({
			input: {
				projectId,
				generation: head?.generation ?? 0,
				commitSha: sha,
			},
		}),
		enabled: pinned,
		retry: false,
	});
	const syncedCommits = useQuery({
		...orpc.projects.instructions.repositorySync.listCommits.queryOptions({
			input: { projectId },
		}),
		enabled: !direct,
		retry: false,
	});
	const rows = (
		(direct ? directCommits.data : syncedCommits.data) as
			| { commits?: CommitRow[] }
			| undefined
	)?.commits;
	return safeHttpsUrl(rows?.find((row) => row.sha === sha)?.url ?? null);
}

function CommittedLine({
	projectId,
	result,
}: {
	projectId: string;
	result: Extract<AppliedRuleSuggestions, { kind: "committed" }>;
}) {
	const url = useCommitUrl(projectId, result.sha, result.direct);
	const sha7 = shortCommit(result.sha) ?? "";
	return (
		<>
			<CheckIcon
				className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
				aria-hidden="true"
			/>
			<span>Committed {filesWord(result.files)}</span>
			<span aria-hidden="true">·</span>
			{url ? (
				<ExternalLink href={url}>{sha7}</ExternalLink>
			) : (
				<code>{sha7}</code>
			)}
		</>
	);
}

function PullRequestLine({
	projectId,
	snapshotId,
}: {
	projectId: string;
	snapshotId: string | null;
}) {
	const status = useQuery({
		...orpc.projects.instructions.proposals.getPullRequestStatus.queryOptions(
			{ input: { projectId, snapshotId: snapshotId ?? "" } },
		),
		enabled: snapshotId !== null,
		retry: 1,
		refetchInterval: (query) =>
			query.state.data?.pullRequest?.url ||
			query.state.dataUpdateCount > 36
				? false
				: 5_000,
	});
	const pullRequest = status.data?.pullRequest as
		| { url?: string | null; externalId?: string | null }
		| null
		| undefined;
	const url = safeHttpsUrl(pullRequest?.url ?? null);
	const number = pullRequest?.externalId?.match(/^\d+$/)
		? `#${pullRequest.externalId}`
		: null;
	return (
		<>
			<GitPullRequestIcon
				className="size-3.5 shrink-0 text-muted-foreground"
				aria-hidden="true"
			/>
			{url ? (
				<ExternalLink href={url}>
					{number ? `Pull request ${number}` : "Pull request"}
				</ExternalLink>
			) : (
				<span>Opening a pull request…</span>
			)}
		</>
	);
}

export function RuleSuggestionsResult({
	projectId,
	result,
	onDismiss,
}: {
	projectId: string;
	result: AppliedRuleSuggestions;
	onDismiss: () => void;
}) {
	return (
		<output
			data-testid="rule-suggestions-result"
			className="flex flex-wrap items-center gap-1.5 text-xs"
		>
			{result.kind === "committed" ? (
				<CommittedLine projectId={projectId} result={result} />
			) : (
				<PullRequestLine
					projectId={projectId}
					snapshotId={result.snapshotId}
				/>
			)}
			<button
				type="button"
				className="ml-1 rounded p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
				aria-label="Dismiss"
				onClick={onDismiss}
			>
				<XIcon className="size-3" aria-hidden="true" />
			</button>
		</output>
	);
}
