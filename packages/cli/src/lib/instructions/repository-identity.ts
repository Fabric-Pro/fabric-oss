/**
 * Which repository a git remote URL names, compared with the repository a
 * project syncs its coding instructions from (Fizzy #2708). Pure: no I/O.
 *
 * Deliberately narrow. Only three spellings are understood, and only without
 * a port, because the project's configuration is a bare host and path and a
 * URL this cannot reduce to exactly that must never be taken for a match:
 *
 *   https://host/path[.git]          optional userinfo, dropped
 *   ssh://[user@]host/path[.git]
 *   [user@]host:path[.git]           scp-like
 *
 * Everything else — a port, `file://`, `git://`, a local or UNC path, a
 * Windows drive letter — is `null`. So is a URL whose `insteadOf` rewrite
 * points at a local mirror: the caller parses the EFFECTIVE fetch URL, and a
 * checkout that fetches from somewhere else is not a checkout of this
 * repository as far as the published commit is concerned.
 *
 * One exception to the port rule: Azure DevOps SSH remotes are routinely
 * written `ssh://git@ssh.dev.azure.com:22/v3/...`, and `22` is the default.
 *
 * Azure DevOps has six spellings of one repository (see `azureIdentity`);
 * they are reduced to an organization, a project and a repository, which is
 * what `matches` compares and what `canonicalRemoteCandidates` rebuilds into
 * the two HTTPS forms a server may have stored.
 *
 * Userinfo is never returned. It is where a credential lives in a URL.
 */
import type { PublishedInstructionRepository } from "@fabricorg/sdk";

/** What the Azure DevOps spellings of a repository have in common. */
interface AzureDevOpsIdentity {
	organization: string;
	/** `null` for the short `dev.azure.com/{org}/_git/{repo}` spelling. */
	project: string | null;
	repository: string;
}

export interface ParsedRemote {
	/** Lowercased. */
	host: string;
	/** Every segment, `.git` stripped: `group/subgroup/repo` on GitLab. */
	path: string;
	/** Present when the host is one of Azure DevOps's and the path is a repository. */
	azure?: AzureDevOpsIdentity;
}

const AZURE_SSH_HOSTS = new Set([
	"ssh.dev.azure.com",
	"vs-ssh.visualstudio.com",
]);
const AZURE_HTTPS_HOST = "dev.azure.com";
const AZURE_LEGACY_SUFFIX = ".visualstudio.com";
const AZURE_GIT_SEGMENT = "_git";
const AZURE_LEGACY_COLLECTION = "defaultcollection";

const HOST =
	/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/;

function parsePath(raw: string): string | null {
	let value = raw;
	while (value.endsWith("/")) {
		value = value.slice(0, -1);
	}
	if (value.endsWith(".git")) {
		value = value.slice(0, -".git".length);
	}
	if (value === "" || value.startsWith("/")) {
		return null;
	}
	const segments = value.split("/");
	for (const segment of segments) {
		if (
			segment === "" ||
			segment === "." ||
			segment === ".." ||
			/[\s\\?#]/.test(segment) ||
			// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
			/[\u0000-\u001f\u007f]/.test(segment)
		) {
			return null;
		}
	}
	return segments.join("/");
}

function parseHost(raw: string): string | null {
	return HOST.test(raw) ? raw.toLowerCase() : null;
}

/**
 * `[user@]host` → host, or null when what remains is not a bare hostname.
 * `sshScheme` allows the default port on the two Azure DevOps SSH hosts.
 */
function withoutUser(authority: string, sshScheme = false): string | null {
	const at = authority.lastIndexOf("@");
	let host = at === -1 ? authority : authority.slice(at + 1);
	if (sshScheme && host.endsWith(":22")) {
		const bare = host.slice(0, -":22".length);
		if (AZURE_SSH_HOSTS.has(bare.toLowerCase())) {
			host = bare;
		}
	}
	// A `:` left in the authority is a port (or a password with no user),
	// and a port is never matched.
	return host.includes(":") ? null : parseHost(host);
}

function safeDecode(segment: string): string {
	try {
		return decodeURIComponent(segment);
	} catch {
		return segment;
	}
}

/**
 * The organization, project and repository an Azure DevOps remote names, from
 * whichever of its spellings the path came in:
 *
 *   dev.azure.com/{org}/{project}/_git/{repo}          (also `dev.azure.com/{org}/_git/{repo}`)
 *   {org}.visualstudio.com/[DefaultCollection/]{project}/_git/{repo}
 *   ssh.dev.azure.com:v3/{org}/{project}/{repo}
 *   vs-ssh.visualstudio.com:v3/{org}/{project}/{repo}
 *
 * Names are percent-decoded, because the HTTPS spellings encode a space in a
 * project name and the scp-like ones do not always. `null` for any other
 * host, and for a path that is not a repository's.
 */
function azureIdentity(
	host: string,
	repoPath: string,
): AzureDevOpsIdentity | null {
	const segments = repoPath.split("/").map(safeDecode);
	const isGit = (segment: string | undefined): boolean =>
		segment?.toLowerCase() === AZURE_GIT_SEGMENT;

	if (host === AZURE_HTTPS_HOST) {
		if (segments.length === 4 && isGit(segments[2])) {
			return {
				organization: segments[0] as string,
				project: segments[1] as string,
				repository: segments[3] as string,
			};
		}
		if (segments.length === 3 && isGit(segments[1])) {
			return {
				organization: segments[0] as string,
				project: null,
				repository: segments[2] as string,
			};
		}
		return null;
	}

	if (AZURE_SSH_HOSTS.has(host)) {
		if (segments.length === 4 && segments[0]?.toLowerCase() === "v3") {
			return {
				organization: segments[1] as string,
				project: segments[2] as string,
				repository: segments[3] as string,
			};
		}
		return null;
	}

	if (host.endsWith(AZURE_LEGACY_SUFFIX)) {
		const organization = host.slice(0, -AZURE_LEGACY_SUFFIX.length);
		if (organization === "" || organization.includes(".")) {
			return null;
		}
		const rest =
			segments[0]?.toLowerCase() === AZURE_LEGACY_COLLECTION
				? segments.slice(1)
				: segments;
		if (rest.length === 3 && isGit(rest[1])) {
			return {
				organization,
				project: rest[0] as string,
				repository: rest[2] as string,
			};
		}
		if (rest.length === 2 && isGit(rest[0])) {
			return {
				organization,
				project: null,
				repository: rest[1] as string,
			};
		}
	}
	return null;
}

function withIdentity(host: string, repoPath: string): ParsedRemote {
	const azure = azureIdentity(host, repoPath);
	return azure ? { host, path: repoPath, azure } : { host, path: repoPath };
}

export function parseRemoteUrl(url: string): ParsedRemote | null {
	const value = url.trim();
	if (value === "" || value.startsWith("\\\\") || value.startsWith("//")) {
		return null;
	}

	const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(value);
	if (scheme) {
		const name = (scheme[1] as string).toLowerCase();
		if (name !== "https" && name !== "ssh") {
			return null;
		}
		const rest = value.slice(scheme[0].length);
		const slash = rest.indexOf("/");
		if (slash <= 0) {
			return null;
		}
		const host = withoutUser(rest.slice(0, slash), name === "ssh");
		const repoPath = parsePath(rest.slice(slash + 1));
		return host && repoPath ? withIdentity(host, repoPath) : null;
	}

	// scp-like: `[user@]host:path`. Only when no `/` comes before the first
	// `:` (otherwise it is a local path), and never a single letter before it
	// (a Windows drive, `C:\…` or `C:/…`).
	const colon = value.indexOf(":");
	if (colon <= 0) {
		return null;
	}
	const authority = value.slice(0, colon);
	if (authority.includes("/") || authority.includes("\\")) {
		return null;
	}
	const hostPart = authority.slice(authority.lastIndexOf("@") + 1);
	if (/^[A-Za-z]$/.test(hostPart)) {
		return null;
	}
	const host = withoutUser(authority);
	// `host:2222/x` is scp syntax for the PATH `2222/x`: scp-like URLs have
	// no port, and git reads them exactly this way.
	const repoPath = parsePath(value.slice(colon + 1));
	return host && repoPath ? withIdentity(host, repoPath) : null;
}

export type RepositoryMatch = "match" | "mismatch" | "unsupported-provider";

type RepositoryIdentity = Pick<
	PublishedInstructionRepository,
	"provider" | "host" | "path"
>;

function trimmedPath(repository: RepositoryIdentity): string {
	return repository.path.replace(/^\/+|\/+$/g, "");
}

/**
 * The Azure DevOps identity a project's configuration names: its `path` is the
 * repository's URL path (`{org}/{project}/_git/{repo}`), and the older
 * `{org}/{project}/{repo}` is read the same way.
 */
function configuredAzureIdentity(
	repository: RepositoryIdentity,
): AzureDevOpsIdentity | null {
	const segments = trimmedPath(repository).split("/").map(safeDecode);
	const withoutGit = segments.filter(
		(segment) => segment.toLowerCase() !== AZURE_GIT_SEGMENT,
	);
	if (
		withoutGit.length !== 3 ||
		withoutGit.some((segment) => segment === "")
	) {
		return null;
	}
	return {
		organization: withoutGit[0] as string,
		project: withoutGit[1] as string,
		repository: withoutGit[2] as string,
	};
}

/**
 * Whether the project's configuration says enough to compare a remote with:
 * always, except an Azure DevOps path that names no project, which cannot be
 * told from another project's repository of the same name.
 */
export function hasComparableIdentity(repository: RepositoryIdentity): boolean {
	return (
		repository.provider !== "AZURE_DEVOPS" ||
		configuredAzureIdentity(repository) !== null
	);
}

function sameName(left: string, right: string): boolean {
	return left.toLowerCase() === right.toLowerCase();
}

/**
 * Whether a parsed remote is the project's repository. The host always
 * compares case-insensitively; the path does only on GitHub, whose owner and
 * repository names are case-insensitive. GitLab paths compare exactly. Azure
 * DevOps compares the organization, project and repository, case-insensitively
 * and whichever of its spellings either side came in; the host is not
 * compared, because one repository has several.
 */
export function matches(
	parsed: ParsedRemote,
	repository: RepositoryIdentity,
): RepositoryMatch {
	if (repository.provider === "AZURE_DEVOPS") {
		const expected = configuredAzureIdentity(repository);
		const actual = parsed.azure;
		if (!expected || !actual || actual.project === null) {
			return "mismatch";
		}
		return sameName(actual.organization, expected.organization) &&
			sameName(actual.project, expected.project as string) &&
			sameName(actual.repository, expected.repository)
			? "match"
			: "mismatch";
	}
	if (repository.provider !== "GITHUB" && repository.provider !== "GITLAB") {
		return "unsupported-provider";
	}
	if (parsed.host !== repository.host.toLowerCase()) {
		return "mismatch";
	}
	const expected = trimmedPath(repository);
	if (repository.provider === "GITHUB") {
		return parsed.path.toLowerCase() === expected.toLowerCase()
			? "match"
			: "mismatch";
	}
	return parsed.path === expected ? "match" : "mismatch";
}

/**
 * The credential-free HTTPS spellings of a remote, as a server may have stored
 * the repository: what `resolveCheckout` is asked about.
 *
 * Only repositories a Fabric deployment can connect are named — github.com
 * (`owner/repo`), gitlab.com (any number of subgroup segments) and Azure
 * DevOps. An Azure DevOps repository has two stored spellings
 * (`dev.azure.com/{org}/{project}/_git/{repo}` and
 * `{org}.visualstudio.com/{project}/_git/{repo}`), and both are returned.
 * Case is kept as the remote spelled it; the deployment compares with the
 * stored form ignoring letter case, so a `{org}.visualstudio.com` remote, whose
 * host lowercases the organization, still finds a repository stored as
 * `dev.azure.com/{Org}/...`.
 *
 * `[]` for anything else, including every host a deployment cannot connect.
 */
export function canonicalRemoteCandidates(url: string): string[] {
	const parsed = parseRemoteUrl(url);
	if (!parsed) {
		return [];
	}
	if (parsed.azure) {
		const { organization, project, repository } = parsed.azure;
		const tail = [
			...(project === null ? [] : [encodeURIComponent(project)]),
			AZURE_GIT_SEGMENT,
			encodeURIComponent(repository),
		].join("/");
		return [
			`https://${AZURE_HTTPS_HOST}/${encodeURIComponent(organization)}/${tail}`,
			`https://${organization.toLowerCase()}${AZURE_LEGACY_SUFFIX}/${tail}`,
		];
	}
	const segments = parsed.path.split("/");
	if (parsed.host === "github.com" && segments.length === 2) {
		return [`https://github.com/${parsed.path}`];
	}
	if (parsed.host === "gitlab.com" && segments.length >= 2) {
		return [`https://gitlab.com/${parsed.path}`];
	}
	return [];
}
