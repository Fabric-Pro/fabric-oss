import { parseAdoRepositoryUrl } from "./repository-branch";
import type { ListRepositoryTreeInput } from "./repository-tree";

/**
 * The size of every file of one commit, from the provider's own tree API, so a
 * sync that stopped a checkout can say how large the files it meant to read
 * really are without fetching their blobs (a blobless clone's `ls-tree -l`
 * would fetch every one).
 *
 *  - GitHub: `GET /repos/{owner}/{repo}/git/trees/{commit}?recursive=1`
 *    answers each `blob` entry with its `size`; `truncated: true` says the
 *    listing is incomplete.
 *  - Azure DevOps: `Trees - Get` with `recursive=true` answers each entry
 *    with `relativePath` (from the root tree, full path when recursive),
 *    `gitObjectType` and `size` ("Size of content"). It takes the root TREE's
 *    object id, which the caller reads from its clone.
 *
 * GitLab (and any provider not listed) is `unsupported`. The helper never
 * throws; a failure is `ok: false`, and a caller that cannot have sizes
 * falls back to a lower bound it states as one.
 *
 * SECURITY: the token is request-scoped, never logged, never returned.
 */

const BLOB_SIZES_TIMEOUT_MS = 20_000;

const ADO_API_VERSION = "7.1";

/** A listing larger than this is not read: the caller falls back. */
const MAX_BLOB_SIZE_ENTRIES = 200_000;

export type ReadRepositoryBlobSizesInput = Omit<
	ListRepositoryTreeInput,
	"branch"
> & {
	/** The commit the clone checked out. */
	commitSha: string;
	/** That commit's root tree id, which Azure DevOps addresses a tree by. */
	rootTreeId: string;
};

export type ReadRepositoryBlobSizesResult =
	| {
			ok: true;
			/** Repository-relative path to the blob's size in bytes. */
			sizes: ReadonlyMap<string, number>;
			/** False when the provider says the listing stops short. */
			complete: boolean;
	  }
	| { ok: false };

const FAILED: ReadRepositoryBlobSizesResult = { ok: false };

function plainSize(value: unknown): number | null {
	return typeof value === "number" && Number.isInteger(value) && value >= 0
		? value
		: null;
}

async function readGitHubBlobSizes(
	input: ReadRepositoryBlobSizesInput,
): Promise<ReadRepositoryBlobSizesResult> {
	const url = `https://api.github.com/repos/${encodeURIComponent(
		input.owner,
	)}/${encodeURIComponent(input.repo)}/git/trees/${encodeURIComponent(
		input.commitSha,
	)}?recursive=1`;
	const response = await fetch(url, {
		headers: {
			Authorization: `Bearer ${input.token}`,
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
		},
		signal: AbortSignal.timeout(BLOB_SIZES_TIMEOUT_MS),
	});
	if (!response.ok) {
		return FAILED;
	}
	const data = (await response.json()) as {
		tree?: unknown;
		truncated?: unknown;
	};
	if (
		!Array.isArray(data?.tree) ||
		data.tree.length > MAX_BLOB_SIZE_ENTRIES
	) {
		return FAILED;
	}
	const sizes = new Map<string, number>();
	for (const item of data.tree as Array<{
		path?: unknown;
		type?: unknown;
		size?: unknown;
	}>) {
		const size = plainSize(item?.size);
		if (
			item?.type === "blob" &&
			typeof item.path === "string" &&
			size !== null
		) {
			sizes.set(item.path, size);
		}
	}
	return { ok: true, sizes, complete: data.truncated !== true };
}

async function readAzureDevOpsBlobSizes(
	input: ReadRepositoryBlobSizesInput,
): Promise<ReadRepositoryBlobSizesResult> {
	const parsed = parseAdoRepositoryUrl(input.repositoryUrl);
	const organization = parsed?.organization ?? input.azureOrganization;
	if (!organization) {
		return FAILED;
	}
	const host = parsed?.host ?? "https://dev.azure.com";
	const projectSegment = parsed
		? `/${encodeURIComponent(parsed.project)}`
		: "";
	let repoName: string;
	try {
		repoName = decodeURIComponent(input.repo);
	} catch {
		repoName = input.repo;
	}
	const params = new URLSearchParams({
		recursive: "true",
		"api-version": ADO_API_VERSION,
	});
	const url = `${host}/${encodeURIComponent(
		organization,
	)}${projectSegment}/_apis/git/repositories/${encodeURIComponent(
		repoName,
	)}/trees/${encodeURIComponent(input.rootTreeId)}?${params.toString()}`;
	const response = await fetch(url, {
		headers: {
			Authorization: `Basic ${Buffer.from(`:${input.token}`).toString("base64")}`,
			Accept: "application/json",
		},
		signal: AbortSignal.timeout(BLOB_SIZES_TIMEOUT_MS),
	});
	// An invalid or expired PAT is a 203 with an HTML sign-in page.
	if (response.status === 203 || !response.ok) {
		return FAILED;
	}
	const data = (await response.json()) as { treeEntries?: unknown };
	if (
		!Array.isArray(data?.treeEntries) ||
		data.treeEntries.length > MAX_BLOB_SIZE_ENTRIES
	) {
		return FAILED;
	}
	const sizes = new Map<string, number>();
	for (const item of data.treeEntries as Array<{
		relativePath?: unknown;
		gitObjectType?: unknown;
		size?: unknown;
	}>) {
		const size = plainSize(item?.size);
		if (
			item?.gitObjectType === "blob" &&
			typeof item.relativePath === "string" &&
			size !== null
		) {
			sizes.set(item.relativePath, size);
		}
	}
	return { ok: true, sizes, complete: true };
}

export async function readRepositoryBlobSizes(
	input: ReadRepositoryBlobSizesInput,
): Promise<ReadRepositoryBlobSizesResult> {
	try {
		switch (input.provider) {
			case "GITHUB":
				return await readGitHubBlobSizes(input);
			case "AZURE_DEVOPS":
				return await readAzureDevOpsBlobSizes(input);
			case "GITLAB":
				return FAILED;
			default: {
				const unreachable: never = input.provider;
				return unreachable;
			}
		}
	} catch {
		return FAILED;
	}
}
