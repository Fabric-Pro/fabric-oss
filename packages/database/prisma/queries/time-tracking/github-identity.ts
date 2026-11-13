/**
 * Which member of an organization a GitHub login names, for time evidence.
 *
 * A login counts only as the `externalAccountLogin` of a member's own,
 * non-revoked GitHub credential on github.com in that organization. GitHub
 * reported it when the token was connected or saved, so it is never typed in
 * or guessed from an email. Logins compare case-insensitively, as GitHub's do.
 *
 * Both reads fail closed: a member with no such credential has no login, and
 * a login that two members' credentials carry names neither of them.
 *
 * Pull requests on GitHub Enterprise, GitLab and Azure DevOps are never
 * attributed: their author labels are a different host's usernames (or, for
 * Azure DevOps, a display name), not identities a github.com credential
 * proves.
 */

import { db, type Prisma } from "../../client";

const GITHUB_DOT_COM_ORIGIN = "https://github.com";

/** The `provider` a GitHub pull request review is stored with. */
export const GITHUB_PULL_REQUEST_PROVIDER = "GITHUB";

/** How the web address of a pull request on github.com starts. */
export const GITHUB_PULL_REQUEST_URL_PREFIX = `${GITHUB_DOT_COM_ORIGIN}/`;

/** Whether a stored review is of a pull request on github.com. */
export function isGitHubDotComPullRequest(review: {
	provider: string;
	prUrl: string | null;
}): boolean {
	return (
		review.provider === GITHUB_PULL_REQUEST_PROVIDER &&
		(review.prUrl?.startsWith(GITHUB_PULL_REQUEST_URL_PREFIX) ?? false)
	);
}

function memberGitHubCredentials(
	organizationId: string,
): Prisma.CredentialWhereInput {
	return {
		organizationId,
		userId: { not: null },
		provider: "GITHUB",
		kind: { not: "APP_INSTALLATION" },
		status: { not: "REVOKED" },
		origin: GITHUB_DOT_COM_ORIGIN,
		externalAccountLogin: { not: null },
	};
}

function anyLogin(logins: readonly string[]): Prisma.CredentialWhereInput[] {
	return logins.map((login) => ({
		externalAccountLogin: { equals: login, mode: "insensitive" },
	}));
}

/**
 * The member's own GitHub logins in the organization, lowercased, without
 * any that another member's credential also carries.
 */
export async function listVerifiedMemberGitHubLogins(params: {
	organizationId: string;
	userId: string;
}): Promise<string[]> {
	const own = await db.credential.findMany({
		where: {
			...memberGitHubCredentials(params.organizationId),
			userId: params.userId,
		},
		select: { externalAccountLogin: true },
	});
	const logins = [
		...new Set(
			own.flatMap((row) =>
				row.externalAccountLogin
					? [row.externalAccountLogin.toLowerCase()]
					: [],
			),
		),
	];
	if (logins.length === 0) {
		return [];
	}

	const others = await db.credential.findMany({
		where: {
			...memberGitHubCredentials(params.organizationId),
			AND: [{ userId: { not: params.userId } }, { OR: anyLogin(logins) }],
		},
		select: { externalAccountLogin: true },
	});
	const shared = new Set(
		others.flatMap((row) =>
			row.externalAccountLogin
				? [row.externalAccountLogin.toLowerCase()]
				: [],
		),
	);
	return logins.filter((login) => !shared.has(login));
}

/**
 * The one member of the organization whose GitHub credential carries
 * `login`, or null when none does or more than one does.
 */
export async function findMemberByGitHubLogin(params: {
	organizationId: string;
	login: string;
}): Promise<string | null> {
	const login = params.login.trim();
	if (!login) {
		return null;
	}
	const rows = await db.credential.findMany({
		where: {
			...memberGitHubCredentials(params.organizationId),
			OR: anyLogin([login]),
		},
		select: { userId: true },
	});
	const userIds = new Set(
		rows.flatMap((row) => (row.userId ? [row.userId] : [])),
	);
	return userIds.size === 1 ? (userIds.values().next().value ?? null) : null;
}
