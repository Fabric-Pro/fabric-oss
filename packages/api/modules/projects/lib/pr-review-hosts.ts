/**
 * The three code hosts, each answering the same three questions.
 *
 * Every endpoint here was read from the vendor's own reference rather than
 * recalled, because a plausible-looking path that does not exist costs a full
 * round trip to discover and the review lenses cannot tell you it is wrong.
 *
 * Base URLs come from the connected repository's own URL, not a constant, so a
 * self-hosted GitLab or an Azure DevOps Server instance works without a second
 * setting. Only Azure needs more than the origin, because its API path carries
 * the organization.
 */

import { logger } from "@repo/logs";
import { structuredPatch } from "diff";

import type {
	ProviderFileChange,
	PrReviewProvider,
} from "./pr-review-providers";
import {
	hostRefused,
	packAzureCommentId,
	toUnifiedDiff,
	truncateToBytes,
	unpackAzureCommentId,
} from "./pr-review-providers";

/** Azure's API version, pinned. Its payload shapes change between versions. */
const ADO_API_VERSION = "7.1";

/** The host's own origin, so self-hosted instances need no extra configuration. */
function originOf(repositoryUrl: string): string {
	return new URL(repositoryUrl).origin;
}

async function readJson<T>(response: Response): Promise<T> {
	return (await response.json()) as T;
}

/**
 * GitHub. Hands back a unified diff for the whole pull request in one request,
 * under a different Accept header on the same endpoint.
 */
export const githubProvider: PrReviewProvider = {
	async read(input) {
		const api =
			originOf(input.repositoryUrl) === "https://github.com"
				? "https://api.github.com"
				: `${originOf(input.repositoryUrl)}/api/v3`;
		const endpoint = `${api}/repos/${encodeURIComponent(input.repositoryOwner)}/${encodeURIComponent(input.repositoryName)}/pulls/${input.prNumber}`;
		const auth = {
			Authorization: `Bearer ${input.token}`,
			"X-GitHub-Api-Version": "2022-11-28",
		};

		const meta = await fetch(endpoint, {
			headers: { ...auth, Accept: "application/vnd.github+json" },
		});
		if (!meta.ok) {
			// Naming the repository matters on a 404: the usual cause is a pull
			// request number from a different repository, and "not found" without
			// the place it looked sends the reader hunting.
			throw hostRefused(
				meta.status,
				`read pull request #${input.prNumber} in ${input.repositoryOwner}/${input.repositoryName}`,
			);
		}
		const pr = await readJson<{
			title?: string;
			html_url?: string;
			changed_files?: number;
			user?: { login?: string };
			head?: { sha?: string };
			base?: { sha?: string };
		}>(meta);

		// Stop before the diff when there is no commit range: the caller refuses
		// such a pull request anyway, and fetching a diff for it spends a call
		// against the customer's rate limit to learn nothing.
		if (!pr.head?.sha || !pr.base?.sha) {
			return {
				pullRequest: {
					title: pr.title ?? `#${input.prNumber}`,
					authorLabel: pr.user?.login ?? null,
					headSha: pr.head?.sha ?? "",
					baseSha: pr.base?.sha ?? "",
					webUrl: pr.html_url ?? null,
					changedFiles: pr.changed_files ?? 0,
				},
				diff: null,
				diffTruncated: false,
				failureText: null,
			};
		}

		const diffResponse = await fetch(endpoint, {
			headers: { ...auth, Accept: "application/vnd.github.v3.diff" },
		});
		let diff: string | null = null;
		let diffTruncated = false;
		if (diffResponse.ok) {
			const cut = truncateToBytes(
				await diffResponse.text(),
				input.maxDiffBytes,
			);
			diff = cut.text;
			diffTruncated = cut.truncated;
		}

		return {
			pullRequest: {
				title: pr.title ?? `#${input.prNumber}`,
				authorLabel: pr.user?.login ?? null,
				headSha: pr.head?.sha ?? "",
				baseSha: pr.base?.sha ?? "",
				webUrl: pr.html_url ?? null,
				changedFiles: pr.changed_files ?? 0,
			},
			diff,
			diffTruncated,
			failureText: diff
				? null
				: `GitHub returned no diff for this pull request (HTTP ${diffResponse.status}).`,
		};
	},

	async createComment(input) {
		const api =
			originOf(input.repositoryUrl) === "https://github.com"
				? "https://api.github.com"
				: `${originOf(input.repositoryUrl)}/api/v3`;
		const response = await fetch(
			`${api}/repos/${encodeURIComponent(input.repositoryOwner)}/${encodeURIComponent(input.repositoryName)}/issues/${input.prNumber}/comments`,
			{
				method: "POST",
				headers: githubWriteHeaders(input.token),
				body: JSON.stringify({ body: input.body }),
			},
		);
		if (!response.ok) {
			throw hostRefused(response.status, "comment");
		}
		const created = await readJson<{ id?: number; html_url?: string }>(
			response,
		);
		return { id: created.id ?? 0, webUrl: created.html_url ?? null };
	},

	async editComment(input) {
		const api =
			originOf(input.repositoryUrl) === "https://github.com"
				? "https://api.github.com"
				: `${originOf(input.repositoryUrl)}/api/v3`;
		// Editing hangs off the REPOSITORY, not the issue. Deriving this from the
		// issue URL is the obvious mistake and it 404s every time.
		const response = await fetch(
			`${api}/repos/${encodeURIComponent(input.repositoryOwner)}/${encodeURIComponent(input.repositoryName)}/issues/comments/${input.commentId}`,
			{
				method: "PATCH",
				headers: githubWriteHeaders(input.token),
				body: JSON.stringify({ body: input.body }),
			},
		);
		if (response.status === 404) {
			return null;
		}
		if (!response.ok) {
			throw hostRefused(response.status, "comment");
		}
		const edited = await readJson<{ id?: number; html_url?: string }>(
			response,
		);
		return {
			id: edited.id ?? input.commentId,
			webUrl: edited.html_url ?? null,
		};
	},
};

function githubWriteHeaders(token: string): Record<string, string> {
	return {
		Authorization: `Bearer ${token}`,
		"X-GitHub-Api-Version": "2022-11-28",
		Accept: "application/vnd.github+json",
		"Content-Type": "application/json",
	};
}

/**
 * GitLab. A merge request, addressed by project path and internal id, with its
 * diff returned per file.
 *
 * Uses `/diffs` rather than `/changes`: GitLab deprecated `/changes` in 15.7 and
 * will remove it in API v5. Both return the same per-file fields.
 */
export const gitlabProvider: PrReviewProvider = {
	async read(input) {
		const base = gitlabBase(input);
		const auth = { Authorization: `Bearer ${input.token}` };

		const meta = await fetch(`${base}/${input.prNumber}`, {
			headers: auth,
		});
		if (!meta.ok) {
			throw hostRefused(
				meta.status,
				`read merge request !${input.prNumber} in ${input.repositoryOwner}/${input.repositoryName}`,
			);
		}
		const mr = await readJson<{
			title?: string;
			web_url?: string;
			changes_count?: string;
			author?: { username?: string };
			diff_refs?: { head_sha?: string; base_sha?: string };
		}>(meta);

		if (!mr.diff_refs?.head_sha || !mr.diff_refs?.base_sha) {
			return {
				pullRequest: {
					title: mr.title ?? `!${input.prNumber}`,
					authorLabel: mr.author?.username ?? null,
					headSha: mr.diff_refs?.head_sha ?? "",
					baseSha: mr.diff_refs?.base_sha ?? "",
					webUrl: mr.web_url ?? null,
					changedFiles: 0,
				},
				diff: null,
				diffTruncated: false,
				failureText: null,
			};
		}

		const diffsResponse = await fetch(
			`${base}/${input.prNumber}/diffs?per_page=100`,
			{ headers: auth },
		);
		let diff: string | null = null;
		let diffTruncated = false;
		if (diffsResponse.ok) {
			const changes =
				await readJson<
					Array<{
						old_path?: string;
						new_path?: string;
						diff?: string;
						new_file?: boolean;
						deleted_file?: boolean;
						renamed_file?: boolean;
					}>
				>(diffsResponse);
			const files: ProviderFileChange[] = changes.map((c) => ({
				path: c.new_path ?? c.old_path ?? "",
				previousPath:
					c.renamed_file && c.old_path !== c.new_path
						? (c.old_path ?? undefined)
						: undefined,
				diff: c.diff ?? "",
				isNew: c.new_file,
				isDeleted: c.deleted_file,
				isRenamed: c.renamed_file,
			}));
			const cut = truncateToBytes(
				toUnifiedDiff(files.filter((f) => f.path)),
				input.maxDiffBytes,
			);
			diff = cut.text;
			diffTruncated = cut.truncated;
		}

		return {
			pullRequest: {
				title: mr.title ?? `!${input.prNumber}`,
				authorLabel: mr.author?.username ?? null,
				headSha: mr.diff_refs?.head_sha ?? "",
				baseSha: mr.diff_refs?.base_sha ?? "",
				webUrl: mr.web_url ?? null,
				// GitLab reports this as a string, and as "20+" once it stops
				// counting. Anything unparseable becomes 0 rather than NaN.
				changedFiles: Number.parseInt(mr.changes_count ?? "0", 10) || 0,
			},
			diff,
			diffTruncated,
			failureText: diff
				? null
				: `GitLab returned no diff for this merge request (HTTP ${diffsResponse.status}).`,
		};
	},

	async createComment(input) {
		const response = await fetch(
			`${gitlabBase(input)}/${input.prNumber}/notes`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${input.token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ body: input.body }),
			},
		);
		if (!response.ok) {
			throw hostRefused(response.status, "comment");
		}
		const note = await readJson<{ id?: number }>(response);
		return { id: note.id ?? 0, webUrl: null };
	},

	async editComment(input) {
		const response = await fetch(
			`${gitlabBase(input)}/${input.prNumber}/notes/${input.commentId}`,
			{
				method: "PUT",
				headers: {
					Authorization: `Bearer ${input.token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ body: input.body }),
			},
		);
		if (response.status === 404) {
			return null;
		}
		if (!response.ok) {
			throw hostRefused(response.status, "comment");
		}
		const note = await readJson<{ id?: number }>(response);
		return { id: note.id ?? input.commentId, webUrl: null };
	},
};

/** `/api/v4/projects/{owner%2Fname}/merge_requests`, on the host's own origin. */
function gitlabBase(input: {
	repositoryUrl: string;
	repositoryOwner: string;
	repositoryName: string;
}): string {
	const project = encodeURIComponent(
		`${input.repositoryOwner}/${input.repositoryName}`,
	);
	return `${originOf(input.repositoryUrl)}/api/v4/projects/${project}/merge_requests`;
}

/**
 * Azure DevOps. A pull request addressed by id, with its diff assembled from the
 * iteration's changes.
 *
 * Comments live in threads rather than on the pull request directly, so Fabric's
 * comment is the first comment of its own thread and both ids are needed to edit
 * it. They travel packed into the single id column every other host uses.
 */
export const azureProvider: PrReviewProvider = {
	async read(input) {
		const { org, project, repo } = azureParts(input);
		const auth = { Authorization: azureAuth(input.token) };
		const base = `${originOf(input.repositoryUrl)}/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo)}`;

		const meta = await fetch(
			`${base}/pullrequests/${input.prNumber}?api-version=${ADO_API_VERSION}`,
			{ headers: auth },
		);
		if (!meta.ok) {
			throw hostRefused(
				meta.status,
				`read pull request !${input.prNumber}`,
			);
		}
		const pr = await readJson<{
			title?: string;
			createdBy?: { displayName?: string };
			lastMergeSourceCommit?: { commitId?: string };
			lastMergeTargetCommit?: { commitId?: string };
			repository?: { webUrl?: string };
		}>(meta);

		const headSha = pr.lastMergeSourceCommit?.commitId ?? "";
		const baseSha = pr.lastMergeTargetCommit?.commitId ?? "";

		// Azure has no endpoint that returns a unified diff, so the change is
		// assembled from the commit range: which files changed, then each file's
		// diff. Bounded by MAX_AZURE_FILES because this is one request per file
		// and a large pull request would otherwise mean hundreds.
		let diff: string | null = null;
		let diffTruncated = false;
		let failureText: string | null = null;
		let assembledFiles = 0;
		if (headSha && baseSha) {
			const changes = await fetch(
				`${base}/diffs/commits?baseVersion=${baseSha}&targetVersion=${headSha}&$top=${MAX_AZURE_FILES}&api-version=${ADO_API_VERSION}`,
				{ headers: auth },
			);
			if (changes.ok) {
				const payload = await readJson<{
					changes?: Array<{
						item?: { path?: string; isFolder?: boolean };
						changeType?: string;
						/** The path before a rename, when the item moved. */
						sourceServerItem?: string;
						originalPath?: string;
					}>;
					allChangesIncluded?: boolean;
				}>(changes);
				const paths = (payload.changes ?? [])
					.filter((c) => c.item?.path && !c.item.isFolder)
					.map((c) => {
						const changeType = c.changeType ?? "edit";
						const path = (c.item?.path ?? "").replace(/^\//, "");
						// A rename moves the file, so the OLD content lives at the OLD
						// path. Fetching the new path at the base commit 404s, which
						// used to render an ordinary move as a whole-file rewrite —
						// and with every line then counting as added, a model could
						// hallucinate anywhere in it and still ground.
						const previous = changeType.includes("rename")
							? (
									c.sourceServerItem ??
									c.originalPath ??
									""
								).replace(/^\//, "")
							: "";
						return {
							path,
							changeType,
							previousPath:
								previous && previous !== path ? previous : "",
						};
					});

				// Azure charges two requests per file and offers no bulk diff, so a
				// 60-file pull request is 120 round trips. Sequentially that is slow
				// enough for the caller to give up first, so they run in bounded
				// batches: fast enough to finish, gentle enough not to look like an
				// attack on the customer's own instance.
				const wanted = paths.slice(0, MAX_AZURE_FILES);
				const files: ProviderFileChange[] = [];
				for (
					let i = 0;
					i < wanted.length;
					i += AZURE_DIFF_CONCURRENCY
				) {
					const batch = wanted.slice(i, i + AZURE_DIFF_CONCURRENCY);
					const texts = await Promise.all(
						batch.map((entry) =>
							azureFileDiff({
								base,
								auth,
								path: entry.path,
								previousPath: entry.previousPath || entry.path,
								baseSha,
								headSha,
							}),
						),
					);
					batch.forEach((entry, index) => {
						const text = texts[index];
						// `""` is a real answer for a rename with no content change, so
						// this tests for null rather than truthiness.
						if (text !== null) {
							files.push({
								path: entry.path,
								previousPath: entry.previousPath || undefined,
								diff: text,
								isNew: entry.changeType.includes("add"),
								isDeleted: entry.changeType.includes("delete"),
								isRenamed: Boolean(entry.previousPath),
							});
						}
					});
				}
				assembledFiles = files.length;
				const cut = truncateToBytes(
					toUnifiedDiff(files),
					input.maxDiffBytes,
				);
				diff = cut.text;
				// Three ways this read is partial, and the reader must be told about
				// any of them: the byte cap, Azure's own paging, and our file cap.
				diffTruncated =
					cut.truncated ||
					payload.allChangesIncluded === false ||
					paths.length > MAX_AZURE_FILES;
				if (!diff) {
					failureText =
						"Azure DevOps returned no file changes for this pull request.";
					diff = null;
				}
			} else {
				failureText = `Azure DevOps returned no diff for this pull request (HTTP ${changes.status}).`;
			}
		} else {
			failureText =
				"Azure DevOps returned no commit range for this pull request, so there is nothing to review.";
		}

		return {
			pullRequest: {
				title: pr.title ?? `!${input.prNumber}`,
				authorLabel: pr.createdBy?.displayName ?? null,
				headSha,
				baseSha,
				webUrl: pr.repository?.webUrl
					? `${pr.repository.webUrl}/pullrequest/${input.prNumber}`
					: null,
				// The files actually assembled, not a substring count of the
				// rendered text: a diff whose own content contains "diff --git "
				// would inflate that.
				changedFiles: assembledFiles,
			},
			diff,
			diffTruncated,
			failureText,
		};
	},

	async createComment(input) {
		const { org, project, repo } = azureParts(input);
		const response = await fetch(
			`${originOf(input.repositoryUrl)}/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo)}/pullRequests/${input.prNumber}/threads?api-version=${ADO_API_VERSION}`,
			{
				method: "POST",
				headers: {
					Authorization: azureAuth(input.token),
					"Content-Type": "application/json",
				},
				// A thread with no file context is a pull-request-level comment,
				// which is what this is.
				//
				// status 4 is "closed", NOT 1 ("active"). Azure DevOps has a
				// comment-requirements policy that blocks completing a pull
				// request while any thread is active, and nothing here can ever
				// resolve one — so an active thread made this comment gate the
				// merge, while its own last line promises "Advisory only — this
				// comment blocks nothing". Closed is the neutral resolved state:
				// Fixed, WontFix and ByDesign each assert a judgement about a
				// problem that nobody made.
				// CommentThreadStatus: Unknown 0, Active 1, Fixed 2, WontFix 3,
				// Closed 4, ByDesign 5, Pending 6.
				body: JSON.stringify({
					comments: [
						{
							parentCommentId: 0,
							content: input.body,
							commentType: 1,
						},
					],
					status: 4,
				}),
			},
		);
		if (!response.ok) {
			throw hostRefused(response.status, "comment");
		}
		const thread = await readJson<{
			id?: number;
			comments?: Array<{ id?: number }>;
		}>(response);
		return {
			id: packAzureCommentId(
				thread.id ?? 0,
				thread.comments?.[0]?.id ?? 1,
			),
			webUrl: null,
		};
	},

	async editComment(input) {
		const { org, project, repo } = azureParts(input);
		const { threadId, commentId } = unpackAzureCommentId(input.commentId);
		const response = await fetch(
			`${originOf(input.repositoryUrl)}/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo)}/pullRequests/${input.prNumber}/threads/${threadId}/comments/${commentId}?api-version=${ADO_API_VERSION}`,
			{
				method: "PATCH",
				headers: {
					Authorization: azureAuth(input.token),
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ content: input.body }),
			},
		);
		if (response.status === 404) {
			return null;
		}
		if (!response.ok) {
			throw hostRefused(response.status, "comment");
		}
		return { id: input.commentId, webUrl: null };
	},
};

/**
 * File diffs fetched per file, so this is capped.
 *
 * Azure charges one request per file and offers no bulk diff, so a 300-file pull
 * request would mean 300 round trips before a model sees anything. The cap is
 * surfaced as `diffTruncated`, which the prompt already tells the model about, so
 * a partial read never reads as a whole one.
 */
const MAX_AZURE_FILES = 60;

async function azureFileDiff(input: {
	base: string;
	auth: Record<string, string>;
	path: string;
	/** Where the file lived at the base commit. Differs only for a rename. */
	previousPath: string;
	baseSha: string;
	headSha: string;
}): Promise<string | null> {
	// Azure has no per-file diff endpoint, so both versions are fetched and the
	// hunks computed here.
	//
	// This used to emit the whole old file as `-` lines and the whole new file as
	// `+` lines, which is legal unified diff and useless: a one-line edit to a
	// 500-line file produced 1,000 changed lines, and `diffAddedLines` then
	// marked every line in the file as added — so the grounding filter, whose
	// entire job is rejecting invented line citations, would have verified a
	// citation to any line at all. A real diff keeps that check meaningful.
	const [before, after] = await Promise.all([
		azureFileText({
			...input,
			path: input.previousPath,
			version: input.baseSha,
		}),
		azureFileText({ ...input, version: input.headSha }),
	]);
	// Both sides unreadable: nothing to say about this file.
	if (before.text === null && after.text === null) {
		return null;
	}
	// One side failed for a reason that is NOT "it did not exist there". Treating
	// that as an empty file renders the whole of the other side as added or
	// removed, which is a fabricated diff — and with every line then counting as
	// added, a model can hallucinate anywhere in it and still ground. Skipping the
	// file is a smaller lie than inventing its contents.
	if (
		(before.text === null && !before.missing) ||
		(after.text === null && !after.missing)
	) {
		logger.warn(
			"[pr-review] skipping an Azure file whose contents did not load",
			{
				path: input.path,
			},
		);
		return null;
	}

	const patch = structuredPatch(
		input.path,
		input.path,
		before.text ?? "",
		after.text ?? "",
		"",
		"",
		{ context: DIFF_CONTEXT_LINES },
	);
	if (patch.hunks.length === 0) {
		// A rename with no edit still changed something a reviewer cares about, and
		// GitHub and GitLab both keep emitting their rename headers for it. An
		// empty entry here carries the `rename from/to` lines and no hunks, which
		// is exactly what a real diff does.
		if (input.previousPath && input.previousPath !== input.path) {
			return "";
		}
		// Identical at both ends. Azure listed it as changed — a mode or property
		// change, or a rename with no edit — and there is nothing for a lens to
		// read, so it is left out rather than emitted as an empty file entry.
		return null;
	}

	return patch.hunks
		.map((hunk) =>
			[
				`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
				...hunk.lines,
			].join("\n"),
		)
		.join("\n");
}

/** Files diffed at once. Two requests each, so this is 2x this many in flight. */
const AZURE_DIFF_CONCURRENCY = 6;

/**
 * Unchanged lines kept either side of a change.
 *
 * Three is git's own default. It matters here beyond convention: a finding often
 * concerns the line above or below what changed, and the lens can only cite a
 * line the diff actually contains.
 */
const DIFF_CONTEXT_LINES = 3;

async function azureFileText(input: {
	base: string;
	auth: Record<string, string>;
	path: string;
	version: string;
}): Promise<{ text: string | null; missing: boolean }> {
	try {
		const response = await fetch(
			`${input.base}/items?path=${encodeURIComponent(`/${input.path}`)}&versionDescriptor.version=${input.version}&versionDescriptor.versionType=commit&includeContent=true&api-version=${ADO_API_VERSION}`,
			{ headers: { ...input.auth, Accept: "application/json" } },
		);
		if (!response.ok) {
			// 404 is ordinary and meaningful: the file did not exist at this
			// commit, which is what an addition or a deletion looks like. Anything
			// else is a failure to read a file that does exist, and the two must
			// not be confused — see `azureFileDiff`.
			return { text: null, missing: response.status === 404 };
		}
		const item = await readJson<{ content?: string }>(response);
		return { text: item.content ?? "", missing: false };
	} catch (error) {
		// A network-level throw — timeout, reset, DNS — used to reject the whole
		// batch and lose every file read before it. One flaky connection should
		// cost one file.
		logger.warn("[pr-review] could not read an Azure file version", {
			path: input.path,
			error: error instanceof Error ? error.message : String(error),
		});
		return { text: null, missing: false };
	}
}

/**
 * Azure's URL needs three names and the integration stores only two of them.
 *
 * `repositoryOwner` holds the ORGANIZATION, not the project. The URL parser sets
 * it from the first path segment, which for `dev.azure.com/{org}/{project}/_git/
 * {repo}` is the organization, and it returns the project separately in a field
 * no column keeps. Reading owner as the project produced
 * `dev.azure.com/{org}/{org}/_apis/...` and every Azure call would have 404'd.
 *
 * So the project comes back out of the repository URL, which is stored whole and
 * is the one place all three names survive together. `azureOrganization` is
 * preferred for the organization when set, because a PAT connection records it
 * explicitly, and the URL is the fallback.
 */
function azureParts(input: {
	repositoryUrl: string;
	repositoryOwner: string;
	repositoryName: string;
	azureOrganization?: string | null;
}): { org: string; project: string; repo: string } {
	const path = new URL(input.repositoryUrl).pathname
		.split("/")
		.filter(Boolean);
	const gitIndex = path.findIndex(
		(segment) => segment.toLowerCase() === "_git",
	);

	// `{org}/{project}/_git/{repo}` puts _git third; a `{project}/_git/{repo}`
	// URL on a `*.visualstudio.com` host puts it second and carries the
	// organization in the hostname instead.
	const projectFromUrl = gitIndex > 0 ? path[gitIndex - 1] : undefined;
	const orgFromHost = new URL(input.repositoryUrl).hostname.match(
		/^([^.]+)\.visualstudio\.com$/,
	)?.[1];

	return {
		org: input.azureOrganization ?? orgFromHost ?? input.repositoryOwner,
		// Falling back to the repository name would build a URL that resolves to
		// the wrong place silently; the owner at least fails loudly as a project
		// that does not exist.
		project: projectFromUrl ?? input.repositoryOwner,
		repo: input.repositoryName,
	};
}

/** Azure takes a PAT as basic-auth password with an empty username. */
function azureAuth(token: string): string {
	return `Basic ${Buffer.from(`:${token}`).toString("base64")}`;
}

/** Pick the host. Unknown providers are refused by name upstream. */
export function providerFor(provider: string): PrReviewProvider | null {
	switch (provider) {
		case "GITHUB":
			return githubProvider;
		case "GITLAB":
			return gitlabProvider;
		case "AZURE_DEVOPS":
			return azureProvider;
		default:
			return null;
	}
}
