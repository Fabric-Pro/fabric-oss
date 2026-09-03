/**
 * Repository host classification for the setup activities.
 *
 * The setup activities used to decide which forge a repository belongs to by
 * substring-testing the whole URL (`/github\.com/i.test(url)`). That also
 * matches a URL whose real host is somewhere else —
 * `https://example.com/github.com/owner/repo`, or
 * `https://github.com@example.com/owner/repo` — and the answer picks which
 * stored credentials the repository is handed to, so the host decision has to
 * be exact. js/regex/missing-regexp-anchor
 *
 * This answers only "whose host is this?" and imposes no path shape, which is
 * what separates it from `parseRepoUrl` in `@repo/database`: the callers here
 * accept deep links and non-canonical forms that `parseRepoUrl` rejects.
 */

/** The forges whose credentials a repository URL can be routed to. */
type RepoForge = "github" | "gitlab" | "azure-devops";

const FORGE_DOMAINS: ReadonlyArray<readonly [RepoForge, string]> = [
	["github", "github.com"],
	["github", "githubusercontent.com"],
	["gitlab", "gitlab.com"],
	["azure-devops", "dev.azure.com"],
	["azure-devops", "visualstudio.com"],
];

/**
 * Classify a repository URL by the forge hosting it, comparing the URL's parsed
 * hostname. Returns `null` for an unrecognised, empty or unparseable URL, which
 * callers treat the same way they treated "no provider matched".
 */
export function repoForgeFromUrl(url: string): RepoForge | null {
	const trimmed = url.trim();
	if (!trimmed) {
		return null;
	}

	// scp-style SSH (`git@github.com:owner/repo`) is not a URL; rewrite the
	// authority so the same hostname comparison covers it.
	const scpStyle = trimmed.match(/^git@([^:]+):/i);
	const candidate = scpStyle
		? `https://${scpStyle[1]}/`
		: /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)
			? trimmed
			: `https://${trimmed}`;

	let hostname: string;
	try {
		hostname = new URL(candidate).hostname.toLowerCase().replace(/\.$/, "");
	} catch {
		return null;
	}

	for (const [forge, domain] of FORGE_DOMAINS) {
		if (hostname === domain || hostname.endsWith(`.${domain}`)) {
			return forge;
		}
	}
	return null;
}
