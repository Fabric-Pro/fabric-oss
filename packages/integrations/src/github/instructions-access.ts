/**
 * GitHub calls that give a project member read access to the project's
 * coding-instructions repository, and take it back (spec 2026-11-04 §4.4).
 *
 * - Organization-owned repository: a team with `pull` on the repository; the
 *   member joins the team. The only way GitHub offers read-only access.
 * - Personal-account repository: the member becomes a collaborator. GitHub
 *   gives collaborators on a personal repository write access whatever
 *   `permission` says, and sends an invitation they must accept.
 *
 * Every call runs with the repository's own token, has a deadline, and turns
 * a refusal into a typed `GitHubAccessError` whose message is fixed Fabric
 * text plus GitHub's short reason. A token is never put in a message or log.
 *
 * Reads no database row: callers resolve the token and record the outcome.
 */

const GITHUB_API = "https://api.github.com";

/** Deadline for one GitHub call. */
export const GITHUB_ACCESS_TIMEOUT_MS = 10_000;

export type GitHubAccessErrorKind =
	| "auth"
	| "forbidden"
	| "not-found"
	| "validation"
	| "rate-limited"
	| "conflict"
	| "unavailable"
	| "http";

export class GitHubAccessError extends Error {
	constructor(
		public readonly kind: GitHubAccessErrorKind,
		message: string,
		public readonly status?: number,
	) {
		super(message);
		this.name = "GitHubAccessError";
	}
}

interface CallOptions {
	signal?: AbortSignal;
}

function classify(status: number, detail: string): GitHubAccessError {
	const reason = detail ? ` GitHub said: ${detail}` : "";
	if (status === 401) {
		return new GitHubAccessError(
			"auth",
			`GitHub rejected the repository's token (401). Reconnect the instructions repository.${reason}`,
			status,
		);
	}
	if (status === 429 || (status === 403 && /rate limit/i.test(detail))) {
		return new GitHubAccessError(
			"rate-limited",
			`GitHub's rate limit was reached. Try again later.${reason}`,
			status,
		);
	}
	if (status === 403) {
		return new GitHubAccessError(
			"forbidden",
			`The repository's GitHub connection may not manage access to it (403). It needs to be a repository admin, and an organization owner or team maintainer for teams.${reason}`,
			status,
		);
	}
	if (status === 404) {
		return new GitHubAccessError(
			"not-found",
			`GitHub could not find the repository, team or account (404), or the connection cannot see it.${reason}`,
			status,
		);
	}
	if (status === 422) {
		return new GitHubAccessError(
			"validation",
			`GitHub refused the request (422).${reason}`,
			status,
		);
	}
	return new GitHubAccessError(
		"http",
		`GitHub request failed (${status}).${reason}`,
		status,
	);
}

async function shortDetail(response: Response): Promise<string> {
	try {
		const body = (await response.json()) as { message?: unknown };
		return typeof body.message === "string"
			? body.message.slice(0, 200)
			: "";
	} catch {
		return "";
	}
}

function segment(value: string): string {
	return encodeURIComponent(value);
}

/**
 * One REST call. Answers the response for the statuses in `accept` (beyond
 * 2xx) so a caller can read a 404 as "no", and throws for anything else.
 */
async function call(
	token: string,
	method: string,
	path: string,
	options: CallOptions & { body?: unknown; accept?: readonly number[] } = {},
): Promise<Response> {
	const signal = options.signal
		? AbortSignal.any([
				options.signal,
				AbortSignal.timeout(GITHUB_ACCESS_TIMEOUT_MS),
			])
		: AbortSignal.timeout(GITHUB_ACCESS_TIMEOUT_MS);
	let response: Response;
	try {
		response = await fetch(`${GITHUB_API}${path}`, {
			method,
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
				"User-Agent": "Fabric",
				...(options.body === undefined
					? {}
					: { "Content-Type": "application/json" }),
			},
			body:
				options.body === undefined
					? undefined
					: JSON.stringify(options.body),
			signal,
		});
	} catch (error) {
		if (options.signal?.aborted) {
			throw options.signal.reason ?? error;
		}
		const timedOut =
			error instanceof Error &&
			(error.name === "TimeoutError" || error.name === "AbortError");
		throw new GitHubAccessError(
			"unavailable",
			timedOut
				? "GitHub did not answer in time. Try again."
				: "GitHub could not be reached. Try again.",
		);
	}
	if (response.ok || options.accept?.includes(response.status)) {
		return response;
	}
	throw classify(response.status, await shortDetail(response));
}

export type RepositoryOwnerType = "Organization" | "User";

export interface RepositoryOwner {
	type: RepositoryOwnerType;
	/** The owner's login as GitHub spells it. */
	login: string;
}

/** Who owns the repository: an organization or a personal account. */
export async function getRepositoryOwner(
	token: string,
	repository: { owner: string; name: string },
	options: CallOptions = {},
): Promise<RepositoryOwner> {
	const response = await call(
		token,
		"GET",
		`/repos/${segment(repository.owner)}/${segment(repository.name)}`,
		options,
	);
	const body = (await response.json()) as {
		owner?: { type?: unknown; login?: unknown };
	};
	const type = body.owner?.type;
	const login = body.owner?.login;
	if (
		(type !== "Organization" && type !== "User") ||
		typeof login !== "string"
	) {
		throw new GitHubAccessError(
			"http",
			"GitHub answered without the repository's owner.",
		);
	}
	return { type, login };
}

/** The team a project's instructions repository is shared through. */
export function instructionsTeamSlug(projectSlug: string): string {
	return `fabric-${projectSlug}-instructions`;
}

/**
 * Makes sure the team exists and has `pull` on the repository, and answers
 * its slug. A team Fabric did not create for this project (its description
 * lacks `marker`) is refused rather than reused: joining it could carry
 * access to other repositories.
 */
export async function ensureInstructionsTeam(
	token: string,
	input: {
		org: string;
		teamSlug: string;
		/** Text unique to the project, kept in the team's description. */
		marker: string;
		description: string;
		repository: { owner: string; name: string };
	},
	options: CallOptions = {},
): Promise<string> {
	const existing = await call(
		token,
		"GET",
		`/orgs/${segment(input.org)}/teams/${segment(input.teamSlug)}`,
		{ ...options, accept: [404] },
	);
	let slug = input.teamSlug;
	if (existing.status === 404) {
		const created = await call(
			token,
			"POST",
			`/orgs/${segment(input.org)}/teams`,
			{
				...options,
				body: {
					name: input.teamSlug,
					description: input.description,
					privacy: "closed",
				},
			},
		);
		const body = (await created.json()) as { slug?: unknown };
		if (typeof body.slug === "string") {
			slug = body.slug;
		}
	} else {
		const body = (await existing.json()) as { description?: unknown };
		const description =
			typeof body.description === "string" ? body.description : "";
		if (!description.includes(input.marker)) {
			throw new GitHubAccessError(
				"conflict",
				`The GitHub team ${input.teamSlug} already exists and was not created by Fabric for this project. Rename or remove it, then try again.`,
			);
		}
	}
	await call(
		token,
		"PUT",
		`/orgs/${segment(input.org)}/teams/${segment(slug)}/repos/${segment(input.repository.owner)}/${segment(input.repository.name)}`,
		{ ...options, body: { permission: "pull" } },
	);
	return slug;
}

export type TeamMembershipState = "active" | "pending";

function membershipState(value: unknown): TeamMembershipState {
	return value === "pending" ? "pending" : "active";
}

/** The member's state in the team; null when they are not in it. */
export async function getTeamMembership(
	token: string,
	input: { org: string; teamSlug: string; username: string },
	options: CallOptions = {},
): Promise<TeamMembershipState | null> {
	const response = await call(
		token,
		"GET",
		`/orgs/${segment(input.org)}/teams/${segment(input.teamSlug)}/memberships/${segment(input.username)}`,
		{ ...options, accept: [404] },
	);
	if (response.status === 404) {
		return null;
	}
	const body = (await response.json()) as { state?: unknown };
	return membershipState(body.state);
}

/**
 * Adds the member to the team. `pending` means GitHub invited them to the
 * organization and they have not accepted yet.
 */
export async function addTeamMember(
	token: string,
	input: { org: string; teamSlug: string; username: string },
	options: CallOptions = {},
): Promise<TeamMembershipState> {
	const response = await call(
		token,
		"PUT",
		`/orgs/${segment(input.org)}/teams/${segment(input.teamSlug)}/memberships/${segment(input.username)}`,
		{ ...options, body: { role: "member" } },
	);
	const body = (await response.json()) as { state?: unknown };
	return membershipState(body.state);
}

/** Removes the member from the team; one who is not in it is not an error. */
export async function removeTeamMember(
	token: string,
	input: { org: string; teamSlug: string; username: string },
	options: CallOptions = {},
): Promise<void> {
	await call(
		token,
		"DELETE",
		`/orgs/${segment(input.org)}/teams/${segment(input.teamSlug)}/memberships/${segment(input.username)}`,
		{ ...options, accept: [404] },
	);
}

function repositoryPath(repository: { owner: string; name: string }): string {
	return `/repos/${segment(repository.owner)}/${segment(repository.name)}`;
}

/** Whether the account is already a collaborator on the repository. */
export async function isRepositoryCollaborator(
	token: string,
	input: { repository: { owner: string; name: string }; username: string },
	options: CallOptions = {},
): Promise<boolean> {
	const response = await call(
		token,
		"GET",
		`${repositoryPath(input.repository)}/collaborators/${segment(input.username)}`,
		{ ...options, accept: [404] },
	);
	return response.status !== 404;
}

export type CollaboratorPermission = "admin" | "write" | "read" | "none";

/**
 * The account's effective permission on the repository
 * (`GET /repos/{o}/{r}/collaborators/{login}/permission`), however it has
 * it: owner, collaborator, team or organization base permission. Null when
 * GitHub does not know the account (404). Needs a token with push access.
 */
export async function getCollaboratorPermission(
	token: string,
	input: { repository: { owner: string; name: string }; username: string },
	options: CallOptions = {},
): Promise<CollaboratorPermission | null> {
	const response = await call(
		token,
		"GET",
		`${repositoryPath(input.repository)}/collaborators/${segment(input.username)}/permission`,
		{ ...options, accept: [404] },
	);
	if (response.status === 404) {
		return null;
	}
	const body = (await response.json()) as { permission?: unknown };
	const permission = body.permission;
	return permission === "admin" ||
		permission === "write" ||
		permission === "read" ||
		permission === "none"
		? permission
		: null;
}

/** Pages of open invitations read before giving up the search. */
const INVITATION_PAGES = 3;

/** The open invitation for the account on the repository, if any. */
export async function findRepositoryInvitation(
	token: string,
	input: { repository: { owner: string; name: string }; username: string },
	options: CallOptions = {},
): Promise<number | null> {
	const wanted = input.username.toLowerCase();
	for (let page = 1; page <= INVITATION_PAGES; page++) {
		const response = await call(
			token,
			"GET",
			`${repositoryPath(input.repository)}/invitations?per_page=100&page=${page}`,
			options,
		);
		const invitations = (await response.json()) as Array<{
			id?: unknown;
			invitee?: { login?: unknown } | null;
		}>;
		for (const invitation of invitations) {
			const login = invitation.invitee?.login;
			if (
				typeof login === "string" &&
				login.toLowerCase() === wanted &&
				typeof invitation.id === "number"
			) {
				return invitation.id;
			}
		}
		if (invitations.length < 100) {
			return null;
		}
	}
	return null;
}

export type CollaboratorGrant = "invited" | "already-collaborator";

/**
 * Invites the account as a collaborator with `pull`. GitHub answers 201 with
 * an invitation, or 204 when the account already was a collaborator (access
 * Fabric did not grant).
 */
export async function addRepositoryCollaborator(
	token: string,
	input: { repository: { owner: string; name: string }; username: string },
	options: CallOptions = {},
): Promise<CollaboratorGrant> {
	const response = await call(
		token,
		"PUT",
		`${repositoryPath(input.repository)}/collaborators/${segment(input.username)}`,
		{ ...options, body: { permission: "pull" } },
	);
	return response.status === 204 ? "already-collaborator" : "invited";
}

/**
 * Removes the collaborator, and withdraws an invitation they have not
 * accepted. Neither being there is not an error.
 */
export async function removeRepositoryCollaborator(
	token: string,
	input: { repository: { owner: string; name: string }; username: string },
	options: CallOptions = {},
): Promise<void> {
	const invitationId = await findRepositoryInvitation(token, input, options);
	if (invitationId !== null) {
		await call(
			token,
			"DELETE",
			`${repositoryPath(input.repository)}/invitations/${invitationId}`,
			{ ...options, accept: [404] },
		);
	}
	await call(
		token,
		"DELETE",
		`${repositoryPath(input.repository)}/collaborators/${segment(input.username)}`,
		{ ...options, accept: [404] },
	);
}
