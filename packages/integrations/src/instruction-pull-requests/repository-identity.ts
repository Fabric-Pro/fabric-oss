/**
 * The canonical provider identity of a repository integration's stored URL
 * (Fizzy #2563 spec §5.2 `repository`). Admission freezes it into a
 * proposal's pull-request context; the credential loader and every
 * prepare, push and create gate re-derive it from the live integration and
 * require it to equal the frozen one, so an integration whose URL was
 * pointed at another repository under the same id and generation is refused
 * before any git or provider effect.
 */
import { parseRepoUrl } from "@repo/database";
import type { RepositoryIdentity } from "./types";

/**
 * The integration's URL as `origin + pathname` with any userinfo stripped, or
 * null when it is not HTTPS or carries a query or a fragment. The one
 * reading of a stored URL: the repository sync and the proposal activities
 * clone this (`@repo/temporal` re-exports it) and the identity below is
 * parsed from it, so what git reaches and what is compared cannot drift.
 *
 * Userinfo is stripped, not refused: Azure DevOps' own "Clone" button hands
 * out `https://<org>@<ado host>/<org>/<project>/_git/<repo>` (the host is
 * dev.azure.com; it is not spelled out beside the `@` so the publication
 * scan does not read the pair as an email address), and members
 * connect with exactly that URL. The credential git uses always comes from
 * the askpass helper, never from the URL. A query or fragment
 * (`…/repo.git?access_token=…`, `…/_git/repo#token`) is not part of a
 * repository URL and may carry a secret, so it is refused and the run fails
 * closed (INTEGRATION_UNAVAILABLE). The result has no component other than
 * origin and path, so nothing else can reach git's argv, `.git/config` on
 * disk, or git's own stderr; the sync's `assertNoUrlCredentials` re-checks
 * that at the sink.
 */
export function credentialFreeUrl(repositoryUrl: string): string | null {
	let url: URL;
	try {
		url = new URL(repositoryUrl);
	} catch {
		return null;
	}
	if (url.protocol !== "https:" || url.search !== "" || url.hash !== "") {
		return null;
	}
	// `origin` never includes userinfo, so this also strips it.
	return `${url.origin}${url.pathname}`;
}

/** A URL path segment as the provider names it: `Example%20Project` is `Example Project`. */
function decodeSegment(segment: string): string {
	try {
		return decodeURIComponent(segment);
	} catch {
		return segment;
	}
}

/**
 * The identity parsed from `credentialFreeUrl`'s output. Null when the URL
 * does not parse, names another provider than the integration, or is an
 * Azure DevOps URL without a project.
 */
export function repositoryIdentity(
	provider: string,
	storedUrl: string,
): RepositoryIdentity | null {
	const url = credentialFreeUrl(storedUrl);
	const parsed = url ? parseRepoUrl(url) : null;
	if (!parsed || parsed.provider !== provider) {
		return null;
	}
	switch (parsed.provider) {
		case "GITHUB":
			return {
				provider: "GITHUB",
				owner: parsed.owner,
				repo: parsed.name,
			};
		case "GITLAB":
			return {
				provider: "GITLAB",
				projectPath: `${parsed.owner}/${parsed.name}`,
			};
		case "AZURE_DEVOPS":
			if (!parsed.project) {
				return null;
			}
			return {
				provider: "AZURE_DEVOPS",
				apiOrigin: new URL(parsed.url).origin,
				organization: decodeSegment(parsed.owner),
				project: decodeSegment(parsed.project),
				repository: decodeSegment(parsed.name),
			};
		default:
			return null;
	}
}

/** GitHub owner and repository names are ASCII and resolve case-insensitively. */
const sameGitHubName = (a: string, b: string) =>
	a.toLowerCase() === b.toLowerCase();

/**
 * The canonical text of an identity: two identities have the same key
 * exactly when `sameRepository` says they name one repository. Member
 * proposal branches key their permanent ref reservations on it (Fizzy #2738
 * spec Decision 3), so its equality must never be looser or stricter than
 * `sameRepository`'s. Azure DevOps segments are percent-encoded so a `/`
 * inside a name cannot make two identities share a key.
 */
export function repositoryKey(identity: RepositoryIdentity): string {
	switch (identity.provider) {
		case "GITHUB":
			return `github:${identity.owner.toLowerCase()}/${identity.repo.toLowerCase()}`;
		case "GITLAB":
			return `gitlab:${identity.projectPath}`;
		case "AZURE_DEVOPS":
			return `azure_devops:${identity.apiOrigin}/${[
				identity.organization,
				identity.project,
				identity.repository,
			]
				.map(encodeURIComponent)
				.join("/")}`;
		default:
			return unknownProvider(identity);
	}
}

function unknownProvider(identity: never): never {
	throw new Error(
		`Unknown repository provider: ${String((identity as { provider?: unknown }).provider)}`,
	);
}

/**
 * Equality of every field the adapters address. GitHub resolves an owner or
 * repository path case-insensitively (the OAuth identity check compares it
 * so too), so a URL whose case alone changed names the same repository;
 * GitLab paths and every Azure DevOps field compare exactly.
 */
export function sameRepository(
	a: RepositoryIdentity,
	b: RepositoryIdentity,
): boolean {
	switch (a.provider) {
		case "GITHUB":
			return (
				b.provider === "GITHUB" &&
				sameGitHubName(a.owner, b.owner) &&
				sameGitHubName(a.repo, b.repo)
			);
		case "GITLAB":
			return b.provider === "GITLAB" && a.projectPath === b.projectPath;
		case "AZURE_DEVOPS":
			return (
				b.provider === "AZURE_DEVOPS" &&
				a.apiOrigin === b.apiOrigin &&
				a.organization === b.organization &&
				a.project === b.project &&
				a.repository === b.repository
			);
		default:
			return false;
	}
}
