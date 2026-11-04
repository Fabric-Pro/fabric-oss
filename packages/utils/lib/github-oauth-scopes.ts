/**
 * The one set of GitHub OAuth scopes Fabric asks for, at every GitHub
 * connect. Asked for once and in full, so a grant obtained in one place
 * works everywhere and nobody has to re-consent when a feature needs more.
 * A GitHub App ignores scopes: its permissions are set on the App instead
 * (specs/2026-11-04-github-access-for-coding-instructions §4.1).
 */
export const GITHUB_OAUTH_SCOPES: readonly string[] = [
	// Private repositories: read, push, branches, pull requests, Actions runs
	// and statuses, creating repositories, collaborators.
	"repo",
	// Pushing changes under `.github/workflows`.
	"workflow",
	// Organization teams (read access to coding instructions) and listing
	// an organization's repositories.
	"admin:org",
	// GitHub Projects (v2) boards as the PM tool.
	"project",
	// The account's login and email.
	"read:user",
	"user:email",
];

/**
 * The repository permissions a fine-grained GitHub token needs for the same
 * work. GitHub does not report a fine-grained token's permissions, so they
 * cannot be checked before use: the person confirms them when saving one.
 */
export const GITHUB_FINE_GRAINED_PERMISSIONS: readonly {
	name: string;
	access: "read" | "write";
}[] = [
	{ name: "Contents", access: "write" },
	{ name: "Pull requests", access: "write" },
	{ name: "Actions", access: "read" },
	{ name: "Workflows", access: "write" },
	{ name: "Administration", access: "write" },
	{ name: "Members", access: "write" },
	{ name: "Metadata", access: "read" },
];
