/**
 * Canonical repository identity for a project-target GitHub/GitLab OAuth
 * flow — shared by both providers' `start` procedures (before minting signed
 * state) and both providers' callbacks (defense in depth for states minted
 * before this validation existed, or minted by a client that only sent some
 * of the fields).
 *
 * `repositoryUrl`, `repositoryOwner`, and `repositoryName` are three
 * independent, unvalidated fields on the OAuth start input. Without this,
 * a caller could sign a URL that fails to parse (query string, fragment, a
 * non-default port) — or one that names a different repository than
 * `repositoryOwner`/`repositoryName` claims — straight into the state, the
 * provider authorization URL, and eventually the repo-access probe and the
 * stored row.
 *
 * GitLab's own project picker (`packages/api/modules/projects/procedures/gitlab/list-projects.ts`)
 * sends `repositoryName` as GitLab's `path_with_namespace` — which already
 * repeats the owner (for a project "group/subgroup/repo", the picker's
 * `owner` is "group/subgroup" and its `name` is "group/subgroup/repo"),
 * because that full path also doubles as the value the UI needs to dedupe
 * and label selections. `parseRepoUrl`'s owner/name split for the same
 * repository is "group/subgroup" / "repo" — the bare project slug. Both name
 * the same repository, so this treats `repositoryName === parsed.owner +
 * "/" + parsed.name` as a match too (`legacyFullPathMatch` below), and
 * always returns `parseRepoUrl`'s split — never the caller's raw fields — so
 * every downstream consumer (the repo-access probe, default-branch
 * resolution, the stored row's compound key, the audit log) gets the
 * correct owner/bare-name pair instead of the doubled path a naive
 * `${owner}/${name}` concatenation would build.
 */

import { ORPCError } from "@orpc/server";
import { parseRepoUrl } from "@repo/database";

export interface ResolvedRepositoryIdentity {
	/** Canonical, userinfo-free, query/fragment-free repository URL. */
	url: string;
	/** Bare owner (or GitLab group/subgroup path) — never repeats the repo name. */
	owner: string;
	/** Bare repository slug — never prefixed with the owner. */
	name: string;
}

export interface ResolveProjectRepositoryIdentityInput {
	provider: "GITHUB" | "GITLAB";
	repositoryUrl?: string | null;
	repositoryOwner?: string | null;
	repositoryName?: string | null;
	/** GitHub compares owner/name case-insensitively; GitLab paths are case-sensitive. */
	caseSensitive: boolean;
}

/**
 * Resolves and validates the repository identity for a project-target OAuth
 * flow. Returns `null` when neither `repositoryUrl` nor a full
 * `repositoryOwner` + `repositoryName` pair is present — there is nothing to
 * build a candidate URL from, so the caller should fall back to whatever
 * (unchanged) behaviour it has for missing fields.
 *
 * Throws `BAD_REQUEST` when a candidate exists but fails to parse (or parses
 * for the wrong provider with no owner/name to compare against), or when it
 * parses but names a different repository than `repositoryOwner`/
 * `repositoryName` claims.
 */
export function resolveProjectRepositoryIdentity(
	input: ResolveProjectRepositoryIdentityInput,
): ResolvedRepositoryIdentity | null {
	const { provider, repositoryOwner, repositoryName, caseSensitive } = input;
	const host = provider === "GITHUB" ? "github.com" : "gitlab.com";
	// When `repositoryUrl` is absent, build the fallback candidate from
	// `repositoryOwner`/`repositoryName` — but naively concatenating
	// `${owner}/${name}` doubles the legacy GitLab-picker shape, where `name`
	// already starts with `${owner}/` (see the module doc above): for owner
	// "group/subgroup" and name "group/subgroup/repo", that would build
	// ".../group/subgroup/group/subgroup/repo" instead of the real
	// ".../group/subgroup/repo". When `name` already carries the owner
	// prefix, it IS the full path on its own; otherwise it's the bare slug
	// that still needs the owner segment.
	const candidate =
		input.repositoryUrl ??
		(repositoryOwner && repositoryName
			? repositoryName.startsWith(`${repositoryOwner}/`)
				? `https://${host}/${repositoryName}`
				: `https://${host}/${repositoryOwner}/${repositoryName}`
			: null);
	if (!candidate) {
		return null;
	}

	const parsed = parseRepoUrl(candidate);
	if (!parsed) {
		throw new ORPCError("BAD_REQUEST", {
			message: "Cannot parse repository URL",
		});
	}

	if (!repositoryOwner || !repositoryName) {
		// URL-only: nothing supplied to compare identity against. Still
		// require it to parse for THIS provider — a gitlab.com URL handed to
		// the GitHub flow (or vice versa) is not a valid candidate here.
		if (parsed.provider !== provider) {
			throw new ORPCError("BAD_REQUEST", {
				message: "Cannot parse repository URL",
			});
		}
		return { url: parsed.url, owner: parsed.owner, name: parsed.name };
	}

	const eq = (a: string, b: string) =>
		caseSensitive ? a === b : a.toLowerCase() === b.toLowerCase();
	const exactMatch =
		parsed.provider === provider &&
		eq(parsed.owner, repositoryOwner) &&
		eq(parsed.name, repositoryName);
	const legacyFullPathMatch =
		parsed.provider === provider &&
		eq(parsed.owner, repositoryOwner) &&
		eq(`${parsed.owner}/${parsed.name}`, repositoryName);

	if (!exactMatch && !legacyFullPathMatch) {
		throw new ORPCError("BAD_REQUEST", {
			message: "Repository URL does not match the selected repository",
		});
	}

	return { url: parsed.url, owner: parsed.owner, name: parsed.name };
}
