/**
 * What curation is told about each release when screenshots are captured
 * automatically, so it can say which highlights change something a reader
 * can see and where: the files the release changed since the previous
 * production tag, and the work items behind the pull requests its notes name.
 *
 * Optional context only. Every failure is logged and leaves that release with
 * less context; nothing here ever fails the newsletter.
 */
import { compareRepositoryRefs } from "@repo/connectors";
import {
	type DeploymentItem,
	db,
	getProjectReposForCodeSearch,
} from "@repo/database";
import { logger } from "@repo/logs";
import { heartbeat } from "@temporalio/activity";
import type { GitHubRelease } from "../daily-brief/collect-github-releases";
import { resolveRepoAuth } from "../daily-brief/resolve-repo-auth";
import {
	clipText,
	extractPullRequestRefs,
	type NewsletterReleaseTargeting,
	type NewsletterTargetingPullRequest,
	type NewsletterTargetingWorkItem,
	plainStoryText,
	previousProductionTag,
	readReleaseListing,
	RELEASE_LISTING_PAGE_SIZE,
	TARGETING_PATHS_MAX,
	TARGETING_PULL_REQUESTS_MAX,
	TARGETING_WORK_ITEMS_MAX,
} from "./screenshot-targeting-context";

/** Characters kept of a work item's description and of its criteria. */
const WORK_ITEM_TEXT_MAX = 600;
/** Characters kept of a pull request's description. */
const PULL_REQUEST_TEXT_MAX = 600;
const REQUEST_TIMEOUT_MS = 10_000;

interface CollectNewsletterTargetingInput {
	projectId: string;
	organizationId: string | null;
	userId: string;
	releases: DeploymentItem[];
}

export interface CollectNewsletterTargetingOutput {
	releases: NewsletterReleaseTargeting[];
}

type RepositoryContext = Map<
	string,
	{
		paths: string[];
		truncated: boolean;
		pullRequests: NewsletterTargetingPullRequest[];
	}
>;

function gitHubRequest(token: string): RequestInit {
	return {
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: "application/vnd.github.v3+json",
			"X-GitHub-Api-Version": "2022-11-28",
			"User-Agent": "Fabric-Newsletter",
		},
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	};
}

async function fetchGitHubReleasePage(
	token: string,
	owner: string,
	repo: string,
	page: number,
): Promise<GitHubRelease[]> {
	const response = await fetch(
		`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases?per_page=${RELEASE_LISTING_PAGE_SIZE}&page=${page}`,
		gitHubRequest(token),
	);
	if (!response.ok) {
		throw new Error(`GitHub API error: HTTP ${response.status}`);
	}
	return (await response.json()) as GitHubRelease[];
}

/**
 * The title and description of pull request `number`, or null when it is not
 * one (a `#n` in release notes can name an issue) or cannot be read.
 */
async function fetchGitHubPullRequest(
	token: string,
	owner: string,
	repo: string,
	number: number,
): Promise<NewsletterTargetingPullRequest | null> {
	const response = await fetch(
		`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`,
		gitHubRequest(token),
	);
	if (!response.ok) {
		return null;
	}
	const pull = (await response.json()) as {
		title?: string;
		body?: string | null;
	};
	const title = pull.title?.trim();
	if (!title) {
		return null;
	}
	const body = clipText(
		(pull.body ?? "").replace(/\s+/g, " ").trim(),
		PULL_REQUEST_TEXT_MAX,
	);
	return { number, title, ...(body ? { body } : {}) };
}

/**
 * Per release, keyed `repo@tag`: the files it changed since the previous
 * production tag, and the pull requests its notes name. GitHub repositories
 * only: the previous production tag comes from the release listing (a few
 * pages at most), which the other providers do not offer. Their releases
 * still get work items.
 */
async function collectRepositoryContext(
	input: CollectNewsletterTargetingInput,
): Promise<RepositoryContext> {
	const changed: RepositoryContext = new Map();
	const repos = await getProjectReposForCodeSearch(input.projectId);
	for (const repo of repos) {
		if (repo.provider !== "GITHUB") {
			continue;
		}
		const repoFullName = `${repo.owner}/${repo.repo}`;
		const releases = input.releases.filter(
			(release) => release.repoFullName === repoFullName,
		);
		if (releases.length === 0) {
			continue;
		}
		try {
			const auth = await resolveRepoAuth(repo, {
				userId: input.userId,
				organizationId: input.organizationId,
			});
			if (auth.kind !== "github") {
				continue;
			}
			const listing = await readReleaseListing(
				(page) =>
					fetchGitHubReleasePage(
						auth.token,
						repo.owner,
						repo.repo,
						page,
					),
				releases.map((release) => release.tagName),
			);
			for (const release of releases) {
				heartbeat(`newsletter targeting: ${repoFullName}`);
				const pullRequests: NewsletterTargetingPullRequest[] = [];
				const named = extractPullRequestRefs(
					release.body,
					repoFullName,
				).numbers.slice(0, TARGETING_PULL_REQUESTS_MAX);
				for (const number of named) {
					const pull = await fetchGitHubPullRequest(
						auth.token,
						repo.owner,
						repo.repo,
						number,
					);
					if (pull) {
						pullRequests.push(pull);
					}
				}
				const from = previousProductionTag(listing, release.tagName);
				const result = from
					? await compareRepositoryRefs({
							provider: "GITHUB",
							token: auth.token,
							repositoryUrl: repo.repositoryUrl,
							owner: repo.owner,
							repo: repo.repo,
							from,
							to: release.tagName,
						})
					: null;
				const files = result?.ok ? result.files : [];
				changed.set(`${repoFullName}@${release.tagName}`, {
					paths: files
						.slice(0, TARGETING_PATHS_MAX)
						.map((file) => file.path),
					truncated:
						(result?.ok === true && result.truncated) ||
						files.length > TARGETING_PATHS_MAX,
					pullRequests,
				});
			}
		} catch (error) {
			logger.warn("[Newsletter] targeting: changed files not read", {
				projectId: input.projectId,
				repoFullName,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return changed;
}

/** The work items whose coding runs opened the pull requests a release names. */
async function collectWorkItems(
	projectId: string,
	release: DeploymentItem,
): Promise<NewsletterTargetingWorkItem[]> {
	const refs = extractPullRequestRefs(release.body, release.repoFullName);
	const [owner, repo] = release.repoFullName.split("/");
	const matchers = [
		...(refs.urls.length > 0
			? [{ pullRequestUrl: { in: refs.urls } }]
			: []),
		...(refs.numbers.length > 0 && owner && repo
			? [
					{
						repositoryOwner: owner,
						repositoryName: repo,
						pullRequestNumber: { in: refs.numbers },
					},
				]
			: []),
	];
	if (matchers.length === 0) {
		return [];
	}
	const runs = await db.codingRun.findMany({
		where: { projectId, OR: matchers },
		select: {
			story: {
				select: {
					id: true,
					identifier: true,
					title: true,
					description: true,
					acceptanceCriteria: true,
				},
			},
		},
		take: 20,
	});
	const seen = new Set<string>();
	const items: NewsletterTargetingWorkItem[] = [];
	for (const { story } of runs) {
		if (seen.has(story.id) || items.length >= TARGETING_WORK_ITEMS_MAX) {
			continue;
		}
		seen.add(story.id);
		const description = clipText(
			plainStoryText(story.description),
			WORK_ITEM_TEXT_MAX,
		);
		const acceptanceCriteria = clipText(
			plainStoryText(story.acceptanceCriteria),
			WORK_ITEM_TEXT_MAX,
		);
		items.push({
			identifier: story.identifier,
			title: story.title,
			...(description ? { description } : {}),
			...(acceptanceCriteria ? { acceptanceCriteria } : {}),
		});
	}
	return items;
}

/**
 * Activity: targeting context for every release curation will read. Never
 * throws; a failure returns whatever was gathered, possibly nothing.
 */
export async function collectNewsletterTargetingActivity(
	input: CollectNewsletterTargetingInput,
): Promise<CollectNewsletterTargetingOutput> {
	heartbeat("newsletter targeting: starting");
	if (input.releases.length === 0) {
		return { releases: [] };
	}
	let changed: RepositoryContext = new Map();
	try {
		changed = await collectRepositoryContext(input);
	} catch (error) {
		logger.warn("[Newsletter] targeting: repositories not read", {
			projectId: input.projectId,
			error: error instanceof Error ? error.message : String(error),
		});
	}
	const releases: NewsletterReleaseTargeting[] = [];
	for (const release of input.releases) {
		let workItems: NewsletterTargetingWorkItem[] = [];
		try {
			workItems = await collectWorkItems(input.projectId, release);
		} catch (error) {
			logger.warn("[Newsletter] targeting: work items not read", {
				projectId: input.projectId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		const paths = changed.get(`${release.repoFullName}@${release.tagName}`);
		releases.push({
			repoFullName: release.repoFullName,
			tagName: release.tagName,
			changedPaths: paths?.paths ?? [],
			pathsTruncated: paths?.truncated ?? false,
			workItems,
			pullRequests: paths?.pullRequests ?? [],
		});
	}
	return { releases };
}
