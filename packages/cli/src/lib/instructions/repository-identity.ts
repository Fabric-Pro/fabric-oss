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
 * Userinfo is never returned. It is where a credential lives in a URL.
 */
import type { PublishedInstructionRepository } from "@fabricorg/sdk";

export interface ParsedRemote {
	/** Lowercased. */
	host: string;
	/** Every segment, `.git` stripped: `group/subgroup/repo` on GitLab. */
	path: string;
}

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

/** `[user@]host` → host, or null when what remains is not a bare hostname. */
function withoutUser(authority: string): string | null {
	const at = authority.lastIndexOf("@");
	const host = at === -1 ? authority : authority.slice(at + 1);
	// A `:` left in the authority is a port (or a password with no user),
	// and a port is never matched.
	return host.includes(":") ? null : parseHost(host);
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
		const host = withoutUser(rest.slice(0, slash));
		const repoPath = parsePath(rest.slice(slash + 1));
		return host && repoPath ? { host, path: repoPath } : null;
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
	return host && repoPath ? { host, path: repoPath } : null;
}

export type RepositoryMatch = "match" | "mismatch" | "unsupported-provider";

/**
 * Whether a parsed remote is the project's repository. The host always
 * compares case-insensitively; the path does only on GitHub, whose owner and
 * repository names are case-insensitive. GitLab paths compare exactly. Azure
 * DevOps URLs carry an organization, project and `_git` segment the
 * configuration does not spell the same way, so they are not compared at all.
 */
export function matches(
	parsed: ParsedRemote,
	repository: Pick<
		PublishedInstructionRepository,
		"provider" | "host" | "path"
	>,
): RepositoryMatch {
	if (repository.provider !== "GITHUB" && repository.provider !== "GITLAB") {
		return "unsupported-provider";
	}
	if (parsed.host !== repository.host.toLowerCase()) {
		return "mismatch";
	}
	const expected = repository.path.replace(/^\/+|\/+$/g, "");
	if (repository.provider === "GITHUB") {
		return parsed.path.toLowerCase() === expected.toLowerCase()
			? "match"
			: "mismatch";
	}
	return parsed.path === expected ? "match" : "mismatch";
}
