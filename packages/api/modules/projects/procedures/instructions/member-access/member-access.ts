import { ORPCError } from "@orpc/client";
import {
	getInstructionRepositorySync,
	getInstructionsAccessGrant,
	getProjectMembers,
	type InstructionsAccessGrant,
	isFeatureEnabled,
	listInstructionsAccessGrants,
	listMemberGitHubCredentials,
	listMemberGitHubLogins,
	setInstructionsAccessGrantStatus,
	upsertInstructionsAccessGrant,
} from "@repo/database";
import { slugForPlugin } from "@repo/instructions";
import { resolveFreshRepoToken } from "@repo/integrations";
import { backfillCredentialAccounts } from "@repo/integrations/credential-manager";
import {
	addRepositoryCollaborator,
	addTeamMember,
	ensureInstructionsTeam,
	findRepositoryInvitation,
	GitHubAccessError,
	getCollaboratorPermission,
	getRepositoryOwner,
	getTeamMembership,
	instructionsTeamSlug,
	isRepositoryCollaborator,
	type RepositoryOwnerType,
	removeRepositoryCollaborator,
	removeTeamMember,
} from "@repo/integrations/github/instructions-access";
import { logger } from "@repo/logs";
import {
	type RecordAuditFromRequestInput,
	recordAuditFromRequest,
} from "../../../../../lib/audit";

/**
 * Project members' read access to the project's coding-instructions GitHub
 * repository, granted on request (spec 2026-11-04 §4.4, §4.5).
 *
 * - The grant runs with the repository's own token (`resolveFreshRepoToken`:
 *   the bound credential-manager credential, else the legacy tokens).
 * - A member's GitHub login is the `externalAccountLogin` of their own GitHub
 *   credential in the project's organization; it is never guessed from an
 *   email.
 * - Only grants Fabric made are recorded, and only those are revoked: access a
 *   member already had stays.
 *
 * The organization is always the project's own, resolved by the caller.
 */

type AuditContext = Parameters<typeof recordAuditFromRequest>[0];

/** Members one "Grant to all" may reach. */
export const MAX_GRANTS_PER_REQUEST = 100;

/** Invitations re-read from GitHub per list. */
const MAX_INVITATION_REFRESHES = 20;

/** Members whose existing repository permission is read from GitHub per list. */
const MAX_PERMISSION_CHECKS = 20;

const FAILED_INVITATION_MESSAGE =
	"The invitation was declined, expired or withdrawn on GitHub. Grant access again to send a new one.";

export interface InstructionsRepositoryTarget {
	organizationId: string;
	projectId: string;
	projectName: string;
	integrationId: string;
	delegateUserId: string;
	owner: string;
	name: string;
	/** `owner/name`. */
	fullName: string;
}

function isGitHubDotCom(url: string): boolean {
	try {
		const host = new URL(url).hostname.toLowerCase();
		return host === "github.com" || host === "www.github.com";
	} catch {
		return false;
	}
}

/**
 * The project's instructions repository when it is a GitHub repository and
 * the credential manager is on; null otherwise (the section is hidden).
 */
export async function loadInstructionsRepositoryTarget(input: {
	projectId: string;
	projectName: string;
	organizationId: string;
}): Promise<InstructionsRepositoryTarget | null> {
	if (
		!(await isFeatureEnabled(
			"CREDENTIAL_MANAGER",
			input.organizationId,
		).catch(() => false))
	) {
		return null;
	}
	const sync = await getInstructionRepositorySync(
		input.projectId,
		input.organizationId,
	);
	const integration = sync?.repositoryIntegration;
	if (
		!sync ||
		!integration ||
		integration.provider !== "GITHUB" ||
		!isGitHubDotCom(integration.repositoryUrl)
	) {
		return null;
	}
	return {
		organizationId: input.organizationId,
		projectId: input.projectId,
		projectName: input.projectName,
		integrationId: integration.id,
		delegateUserId: sync.user.id,
		owner: integration.repositoryOwner,
		name: integration.repositoryName,
		fullName: `${integration.repositoryOwner}/${integration.repositoryName}`,
	};
}

async function resolveToken(
	target: InstructionsRepositoryTarget,
): Promise<string | null> {
	const resolved = await resolveFreshRepoToken({
		integrationId: target.integrationId,
		projectId: target.projectId,
		userId: target.delegateUserId,
		organizationId: target.organizationId,
	}).catch(() => null);
	return resolved?.token ?? null;
}

async function requireToken(
	target: InstructionsRepositoryTarget,
): Promise<string> {
	const token = await resolveToken(target);
	if (!token) {
		throw new ORPCError("PRECONDITION_FAILED", {
			message:
				"Fabric cannot reach the instructions repository. Reconnect it in the project's repository settings, then try again.",
		});
	}
	return token;
}

function failureMessage(error: unknown): string {
	return error instanceof GitHubAccessError
		? error.message
		: "GitHub could not be reached. Try again.";
}

function failureReason(error: unknown): string {
	return error instanceof GitHubAccessError ? error.kind : "unknown";
}

function teamSlugFor(target: InstructionsRepositoryTarget): string {
	return instructionsTeamSlug(
		slugForPlugin(target.projectName) ??
			target.projectId.slice(-8).toLowerCase(),
	);
}

/** Kept in the team's description: proves Fabric made it for this project. */
function teamMarker(target: InstructionsRepositoryTarget): string {
	return `fabric-project:${target.projectId}`;
}

function audit(
	context: AuditContext,
	target: InstructionsRepositoryTarget,
	action:
		| "project.instructions_access.granted"
		| "project.instructions_access.revoked"
		| "project.instructions_access.failed",
	input: {
		grantId: string;
		githubLogin: string;
		/** The repository the grant is on; the target's when omitted. */
		repository?: string;
		failed?: boolean;
	},
) {
	const repository = input.repository ?? target.fullName;
	const entry: RecordAuditFromRequestInput = {
		action,
		category: "project",
		organizationId: target.organizationId,
		projectId: target.projectId,
		...(input.failed ? { outcome: "failure", severity: "warning" } : {}),
		resource: {
			type: "project_instructions_access_grant",
			id: input.grantId,
			name: repository,
		},
		// The GitHub login and the repository only: never a token.
		metadata: {
			githubLogin: input.githubLogin,
			repository,
		},
	};
	recordAuditFromRequest(context, entry);
}

type MemberGrantStatus = InstructionsAccessGrant["status"];

/**
 * Where a member stands on GitHub, apart from any grant Fabric made:
 * - `OWNER`: their login owns the repository (a personal repository).
 * - `HAS_ACCESS`: GitHub already gives them access (collaborator, team or
 *   organization base permission); nothing for Fabric to grant.
 * - `NO_ACCESS`: known login, no access found; Fabric can grant it.
 * - `ACCOUNT_UNKNOWN`: a GitHub credential that GitHub has not named an
 *   account for yet (unreachable, or the token is rejected).
 * - `NOT_CONNECTED`: no GitHub credential at all in this organization.
 */
type MemberGitHubAccess =
	| "OWNER"
	| "HAS_ACCESS"
	| "NO_ACCESS"
	| "ACCOUNT_UNKNOWN"
	| "NOT_CONNECTED";

interface MemberAccessView {
	userId: string;
	name: string | null;
	image: string | null;
	isCaller: boolean;
	githubLogin: string | null;
	access: MemberGitHubAccess;
	grant: {
		status: MemberGrantStatus;
		mode: InstructionsAccessGrant["mode"];
		githubLogin: string;
		repository: string;
		lastError: string | null;
		updatedAt: Date;
	} | null;
}

export type MemberAccessList =
	| { available: false }
	| {
			available: true;
			repository: string;
			ownerType: "organization" | "personal" | null;
			/** Set when GitHub could not be asked who owns the repository. */
			repositoryProblem: string | null;
			canGrant: boolean;
			members: MemberAccessView[];
	  };

function ownerTypeView(
	type: RepositoryOwnerType | null,
): "organization" | "personal" | null {
	if (type === "Organization") {
		return "organization";
	}
	if (type === "User") {
		return "personal";
	}
	return null;
}

/**
 * Re-reads one invitation Fabric sent. Answers the new status, or null when
 * it is unchanged or GitHub could not say.
 */
async function refreshInvitation(
	token: string,
	target: InstructionsRepositoryTarget,
	grant: InstructionsAccessGrant,
): Promise<MemberGrantStatus | null> {
	const repository = { owner: target.owner, name: target.name };
	try {
		if (grant.mode === "TEAM") {
			if (!grant.teamSlug) {
				return null;
			}
			const state = await getTeamMembership(token, {
				org: target.owner,
				teamSlug: grant.teamSlug,
				username: grant.githubLogin,
			});
			if (state === "active") {
				return "ACTIVE";
			}
			return state === null ? "FAILED" : null;
		}
		if (
			await isRepositoryCollaborator(token, {
				repository,
				username: grant.githubLogin,
			})
		) {
			return "ACTIVE";
		}
		const invitation = await findRepositoryInvitation(token, {
			repository,
			username: grant.githubLogin,
		});
		return invitation === null ? "FAILED" : null;
	} catch {
		return null;
	}
}

export async function listMemberAccess(input: {
	target: InstructionsRepositoryTarget | null;
	callerId: string;
	canGrant: boolean;
}): Promise<MemberAccessList> {
	const { target } = input;
	if (!target) {
		return { available: false };
	}
	const members = await getProjectMembers(target.projectId);
	const userIds = members.map((m) => m.userId);
	const [credentials, grants, token] = await Promise.all([
		listMemberGitHubCredentials({
			organizationId: target.organizationId,
			userIds,
		}),
		listInstructionsAccessGrants({
			projectId: target.projectId,
			organizationId: target.organizationId,
		}),
		resolveToken(target),
	]);

	// A member whose GitHub credentials name no account yet: read it now,
	// once per member, with their own stored token. Bounded by the members
	// listed and never fatal.
	const connected = new Set(credentials.map((c) => c.userId));
	const withLogin = new Set(
		credentials.filter((c) => c.externalAccountLogin).map((c) => c.userId),
	);
	const toBackfill = new Map<string, string>();
	for (const credential of credentials) {
		if (
			!credential.externalAccountLogin &&
			!withLogin.has(credential.userId) &&
			!toBackfill.has(credential.userId)
		) {
			toBackfill.set(credential.userId, credential.id);
		}
	}
	if (toBackfill.size > 0) {
		await backfillCredentialAccounts({
			organizationId: target.organizationId,
			credentialIds: [...toBackfill.values()],
		}).catch(() => null);
	}
	const logins = await listMemberGitHubLogins({
		organizationId: target.organizationId,
		userIds,
	});

	let ownerType: RepositoryOwnerType | null = null;
	let ownerLogin: string | null = null;
	let repositoryProblem: string | null = null;
	if (token) {
		try {
			const owner = await getRepositoryOwner(token, {
				owner: target.owner,
				name: target.name,
			});
			ownerType = owner.type;
			ownerLogin = owner.login;
		} catch (error) {
			repositoryProblem = failureMessage(error);
		}
	} else {
		repositoryProblem =
			"Fabric cannot reach the instructions repository. Reconnect it in the project's repository settings.";
	}

	const grantsByUser = new Map(grants.map((g) => [g.userId, g]));
	if (token && !repositoryProblem) {
		const invited = grants
			.filter(
				(g) =>
					g.status === "INVITED" && g.repository === target.fullName,
			)
			.slice(0, MAX_INVITATION_REFRESHES);
		await Promise.all(
			invited.map(async (grant) => {
				const next = await refreshInvitation(token, target, grant);
				if (!next) {
					return;
				}
				const updated = await setInstructionsAccessGrantStatus({
					id: grant.id,
					organizationId: target.organizationId,
					status: next,
					lastError:
						next === "FAILED" ? FAILED_INVITATION_MESSAGE : null,
				});
				if (updated) {
					grantsByUser.set(updated.userId, updated);
				}
			}),
		);
	}

	const isOwner = (login: string | undefined) =>
		!!login &&
		ownerType === "User" &&
		!!ownerLogin &&
		login.toLowerCase() === ownerLogin.toLowerCase();
	const isLive = (grant: InstructionsAccessGrant | undefined) =>
		grant?.status === "ACTIVE" || grant?.status === "INVITED";

	// Access a member already has on GitHub, for members Fabric has not
	// granted. A refusal (the repository token cannot read permissions)
	// leaves the member grantable, as before.
	const hasAccess = new Set<string>();
	if (token && !repositoryProblem) {
		const toCheck = members
			.filter((member) => {
				const login = logins.get(member.userId);
				return (
					login &&
					!isOwner(login) &&
					!isLive(grantsByUser.get(member.userId))
				);
			})
			.slice(0, MAX_PERMISSION_CHECKS);
		await Promise.all(
			toCheck.map(async (member) => {
				const login = logins.get(member.userId);
				if (!login) {
					return;
				}
				try {
					const permission = await getCollaboratorPermission(token, {
						repository: { owner: target.owner, name: target.name },
						username: login,
					});
					if (permission && permission !== "none") {
						hasAccess.add(member.userId);
					}
				} catch {
					// Unknown: the member stays grantable.
				}
			}),
		);
	}

	const accessOf = (userId: string): MemberGitHubAccess => {
		const login = logins.get(userId);
		if (login) {
			if (isOwner(login)) {
				return "OWNER";
			}
			return hasAccess.has(userId) ? "HAS_ACCESS" : "NO_ACCESS";
		}
		return connected.has(userId) ? "ACCOUNT_UNKNOWN" : "NOT_CONNECTED";
	};

	return {
		available: true,
		repository: target.fullName,
		ownerType: ownerTypeView(ownerType),
		repositoryProblem,
		canGrant: input.canGrant,
		members: members.map((member) => {
			const grant = grantsByUser.get(member.userId) ?? null;
			return {
				userId: member.userId,
				name: member.user.name,
				image: member.user.image,
				isCaller: member.userId === input.callerId,
				githubLogin: logins.get(member.userId) ?? null,
				access: accessOf(member.userId),
				grant: grant
					? {
							status: grant.status,
							mode: grant.mode,
							githubLogin: grant.githubLogin,
							repository: grant.repository,
							lastError: grant.lastError,
							updatedAt: grant.updatedAt,
						}
					: null,
			};
		}),
	};
}

type GrantOutcome =
	| "GRANTED"
	| "INVITED"
	| "UNCHANGED"
	| "ALREADY_HAD_ACCESS"
	| "NO_GITHUB_LOGIN"
	| "NOT_A_MEMBER"
	| "FAILED";

export interface GrantResult {
	userId: string;
	outcome: GrantOutcome;
	message: string | null;
}

/**
 * Grants read access to the chosen members (or all of them). Members who are
 * not in the project, or have no GitHub login, are reported and skipped.
 */
export async function grantMemberAccess(input: {
	target: InstructionsRepositoryTarget;
	context: AuditContext;
	callerId: string;
	userIds: readonly string[] | "all";
	confirmPersonalWriteAccess: boolean;
}): Promise<{ results: GrantResult[] }> {
	const { target, context } = input;
	const token = await requireToken(target);
	const repository = { owner: target.owner, name: target.name };

	let owner: RepositoryOwnerType;
	let ownerLogin: string;
	try {
		({ type: owner, login: ownerLogin } = await getRepositoryOwner(
			token,
			repository,
		));
	} catch (error) {
		throw new ORPCError("BAD_GATEWAY", { message: failureMessage(error) });
	}
	if (owner === "User" && !input.confirmPersonalWriteAccess) {
		throw new ORPCError("PRECONDITION_FAILED", {
			message:
				"This repository belongs to a personal account. GitHub gives collaborators on personal repositories write access, not read-only. Confirm to continue, or move the repository to an organization.",
			data: { reason: "PERSONAL_REPOSITORY_WRITE_ACCESS" },
		});
	}

	const members = await getProjectMembers(target.projectId);
	const memberIds = new Set(members.map((m) => m.userId));
	const requested =
		input.userIds === "all" ? [...memberIds] : [...new Set(input.userIds)];
	if (requested.length > MAX_GRANTS_PER_REQUEST) {
		throw new ORPCError("BAD_REQUEST", {
			message: `At most ${MAX_GRANTS_PER_REQUEST} members can be granted access at once.`,
		});
	}
	const results: GrantResult[] = [];
	const eligible = requested.filter((userId) => {
		if (!memberIds.has(userId)) {
			results.push({ userId, outcome: "NOT_A_MEMBER", message: null });
			return false;
		}
		return true;
	});
	const [logins, grants] = await Promise.all([
		listMemberGitHubLogins({
			organizationId: target.organizationId,
			userIds: eligible,
		}),
		listInstructionsAccessGrants({
			projectId: target.projectId,
			organizationId: target.organizationId,
		}),
	]);
	const grantsByUser = new Map(grants.map((g) => [g.userId, g]));
	const mode = owner === "Organization" ? "TEAM" : "COLLABORATOR";

	// The team is made (or checked) once, before anyone joins it.
	let teamSlug: string | null = null;
	let teamError: unknown = null;
	const needsTeam =
		mode === "TEAM" &&
		eligible.some((userId) => {
			const login = logins.get(userId);
			const grant = grantsByUser.get(userId);
			return login && !isCurrent(grant, login, target);
		});
	if (needsTeam) {
		try {
			teamSlug = await ensureInstructionsTeam(token, {
				org: target.owner,
				teamSlug: teamSlugFor(target),
				marker: teamMarker(target),
				description: `Read access to the coding instructions of a Fabric project, managed by Fabric (${teamMarker(target)}).`,
				repository,
			});
		} catch (error) {
			teamError = error;
		}
	}

	for (const userId of eligible) {
		const login = logins.get(userId);
		if (!login) {
			results.push({ userId, outcome: "NO_GITHUB_LOGIN", message: null });
			continue;
		}
		// The owner of a personal repository already has it.
		if (
			owner === "User" &&
			login.toLowerCase() === ownerLogin.toLowerCase()
		) {
			results.push({
				userId,
				outcome: "ALREADY_HAD_ACCESS",
				message: null,
			});
			continue;
		}
		const existing = grantsByUser.get(userId);
		if (isCurrent(existing, login, target)) {
			results.push({ userId, outcome: "UNCHANGED", message: null });
			continue;
		}
		try {
			if (teamError) {
				throw teamError;
			}
			let status: "ACTIVE" | "INVITED";
			if (mode === "TEAM" && teamSlug) {
				const member = { org: target.owner, teamSlug, username: login };
				if ((await getTeamMembership(token, member)) !== null) {
					results.push({
						userId,
						outcome: "ALREADY_HAD_ACCESS",
						message: null,
					});
					continue;
				}
				status =
					(await addTeamMember(token, member)) === "pending"
						? "INVITED"
						: "ACTIVE";
			} else {
				const collaborator = { repository, username: login };
				if (await isRepositoryCollaborator(token, collaborator)) {
					results.push({
						userId,
						outcome: "ALREADY_HAD_ACCESS",
						message: null,
					});
					continue;
				}
				if (
					(await addRepositoryCollaborator(token, collaborator)) ===
					"already-collaborator"
				) {
					results.push({
						userId,
						outcome: "ALREADY_HAD_ACCESS",
						message: null,
					});
					continue;
				}
				status = "INVITED";
			}
			const grant = await upsertInstructionsAccessGrant({
				organizationId: target.organizationId,
				projectId: target.projectId,
				userId,
				githubLogin: login,
				repository: target.fullName,
				teamSlug: mode === "TEAM" ? teamSlug : null,
				mode,
				status,
				lastError: null,
				createdByUserId: input.callerId,
			});
			audit(context, target, "project.instructions_access.granted", {
				grantId: grant.id,
				githubLogin: login,
			});
			results.push({
				userId,
				outcome: status === "ACTIVE" ? "GRANTED" : "INVITED",
				message: null,
			});
		} catch (error) {
			const message = failureMessage(error);
			logger.warn("Instructions repository access grant failed", {
				projectId: target.projectId,
				reason: failureReason(error),
			});
			const grant = await upsertInstructionsAccessGrant({
				organizationId: target.organizationId,
				projectId: target.projectId,
				userId,
				githubLogin: login,
				repository: target.fullName,
				teamSlug: mode === "TEAM" ? teamSlugFor(target) : null,
				mode,
				status: "FAILED",
				lastError: message,
				createdByUserId: input.callerId,
			});
			audit(context, target, "project.instructions_access.failed", {
				grantId: grant.id,
				githubLogin: login,
				failed: true,
			});
			results.push({ userId, outcome: "FAILED", message });
		}
	}
	return { results };
}

/** A live Fabric grant for this login on this repository. */
function isCurrent(
	grant: InstructionsAccessGrant | undefined,
	login: string,
	target: InstructionsRepositoryTarget,
): boolean {
	return (
		!!grant &&
		(grant.status === "ACTIVE" || grant.status === "INVITED") &&
		grant.githubLogin.toLowerCase() === login.toLowerCase() &&
		grant.repository === target.fullName
	);
}

/**
 * Reverses one grant Fabric made. A member with no live Fabric grant is
 * refused: access Fabric did not grant is not Fabric's to remove.
 */
export async function revokeMemberAccess(input: {
	target: InstructionsRepositoryTarget;
	context: AuditContext;
	userId: string;
}): Promise<{ status: "REVOKED" }> {
	const { target, context } = input;
	const grant = await getInstructionsAccessGrant({
		projectId: target.projectId,
		organizationId: target.organizationId,
		userId: input.userId,
	});
	if (!grant || (grant.status !== "ACTIVE" && grant.status !== "INVITED")) {
		throw new ORPCError("NOT_FOUND", {
			message:
				"Fabric has not granted this member access to the instructions repository, so there is nothing for it to revoke.",
		});
	}
	const token = await requireToken(target);
	const [owner, name] = grant.repository.split("/") as [string, string];
	try {
		if (grant.mode === "TEAM") {
			if (grant.teamSlug) {
				await removeTeamMember(token, {
					org: owner,
					teamSlug: grant.teamSlug,
					username: grant.githubLogin,
				});
			}
		} else {
			await removeRepositoryCollaborator(token, {
				repository: { owner, name },
				username: grant.githubLogin,
			});
		}
	} catch (error) {
		logger.warn("Instructions repository access revoke failed", {
			projectId: target.projectId,
			reason: failureReason(error),
		});
		audit(context, target, "project.instructions_access.failed", {
			grantId: grant.id,
			githubLogin: grant.githubLogin,
			repository: grant.repository,
			failed: true,
		});
		throw new ORPCError("BAD_GATEWAY", { message: failureMessage(error) });
	}
	await setInstructionsAccessGrantStatus({
		id: grant.id,
		organizationId: target.organizationId,
		status: "REVOKED",
		lastError: null,
	});
	audit(context, target, "project.instructions_access.revoked", {
		grantId: grant.id,
		githubLogin: grant.githubLogin,
		repository: grant.repository,
	});
	return { status: "REVOKED" };
}
