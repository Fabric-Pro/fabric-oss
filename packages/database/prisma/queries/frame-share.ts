import { randomUUID } from "node:crypto";
import { throwIfDispatchStopped } from "@repo/utils/dispatch-guard";
import { db, type Prisma } from "../client";
import { recordAuditTx } from "./audit-log";
import { assertFrameRevision, nextFrameRevision } from "./frame-revision";
import type { FrameShareScope, SharingGrant } from "./frame-sharing";

/**
 * Who can open a frame, changed in one place.
 *
 * The app's share and invite procedures and the Fabric Agent's
 * `fabric_share_frame` all call `shareFrame`, so the organization's own policy
 * for sharing frames is applied the same way to all of them and cannot be
 * left out of one:
 *
 * - a public link needs the organization to allow public links
 *   (`canShareFramesPublicly`);
 * - an email can be invited only from a domain the organization allows
 *   (`allowedFrameShareDomains`; an empty list allows any);
 * - the frame must be the caller's own.
 *
 * Whether the caller may update frames at all (their role) and what a run of
 * the Fabric Agent may reach (its project) are the caller's to decide before
 * calling.
 */

/** The scopes a caller can set; a project frame's scope is the project's. */
export type ShareableFrameScope = Exclude<FrameShareScope, "PROJECT">;

export type ShareFrameRefusal =
	| "frame_not_found"
	| "invalid_email"
	| "invalid_revoke_mode"
	| "public_sharing_disabled"
	| "emails_need_an_inviting_scope"
	| "email_domain_not_allowed";

export type ShareFrameOutcome =
	| {
			ok: true;
			scope: FrameShareScope;
			/** The public link's token; present for a public frame only. */
			shareToken?: string;
			/** The addresses invited by this call: the ones not invited already. */
			invited: string[];
			grants: SharingGrant[];
			updatedAt: Date;
	  }
	| {
			ok: false;
			reason: ShareFrameRefusal;
			message: string;
			/** For `email_domain_not_allowed`: the addresses the policy refuses. */
			emails?: string[];
	  };

export const PUBLIC_SHARING_DISABLED_MESSAGE =
	"Public sharing is disabled for this organization.";

/**
 * Whether a public link may be made in this organization: the one rule, read by
 * `shareFrame` and by whatever creates a frame that is public from the start.
 * A missing organization has no authorized public-sharing policy and fails closed.
 */
function allowsPublicLinks(
	organizationId: string | undefined,
	policy: { canShareFramesPublicly: boolean } | null,
): boolean {
	return Boolean(organizationId && policy?.canShareFramesPublicly);
}

/**
 * Why a public link may not be made in this organization, or null when it may.
 * For a create that asks for a public frame from the start; `shareFrame`
 * applies the same rule with the policy it has already read.
 */
export async function publicSharingRefusal(
	organizationId: string | undefined,
): Promise<string | null> {
	const policy = organizationId
		? await db.organization.findUnique({
				where: { id: organizationId, deletedAt: null },
				select: { canShareFramesPublicly: true },
			})
		: null;
	return allowsPublicLinks(organizationId, policy)
		? null
		: PUBLIC_SHARING_DISABLED_MESSAGE;
}

/** A write that would make a frame public refused by the organization's policy. */
export class PublicSharingDisabledError extends Error {
	constructor() {
		super(PUBLIC_SHARING_DISABLED_MESSAGE);
		this.name = "PublicSharingDisabledError";
	}
}

/**
 * Throws `PublicSharingDisabledError` where the organization does not allow
 * public links. Called by every command that can set a frame public (create,
 * update, publish) immediately before its write, so a caller cannot forget it.
 */
export async function assertPublicSharingAllowed(
	organizationId: string | undefined,
): Promise<void> {
	if (await publicSharingRefusal(organizationId)) {
		throw new PublicSharingDisabledError();
	}
}

function refusal(
	reason: ShareFrameRefusal,
	message: string,
	emails?: string[],
): ShareFrameOutcome {
	return { ok: false, reason, message, ...(emails ? { emails } : {}) };
}

function normalizedEmails(emails: readonly string[] | undefined): string[] {
	return [
		...new Set((emails ?? []).map((email) => email.trim().toLowerCase())),
	].filter(Boolean);
}

/** The domain of an address, lower-case, or "" for text that is not one. */
function domainOf(email: string): string {
	const at = email.lastIndexOf("@");
	return at > 0 ? email.slice(at + 1) : "";
}

/** The allowed domains as the organization wrote them: lower-case, with no leading "@". */
function allowedDomains(domains: readonly string[]): Set<string> {
	return new Set(
		domains
			.map((domain) => domain.trim().toLowerCase().replace(/^@/, ""))
			.filter(Boolean),
	);
}

/**
 * Sets who can open the caller's frame and invites the emails given.
 *
 * `scope` omitted keeps the frame's own: that is an invitation on its own. An
 * email can be invited on any scope but PRIVATE and PUBLIC. Emails already
 * invited are not invited twice.
 */
export interface ShareFrameInput {
	frameId: string;
	userId: string;
	organizationId?: string;
	scope?: ShareableFrameScope;
	emails?: readonly string[];
	expectedUpdatedAt?: Date;
}

/** Owner+tenant lookup repeated under the lock, shared by every sharing write. */
async function lockedFrame(
	tx: Prisma.TransactionClient,
	input: {
		frameId: string;
		userId: string;
		organizationId?: string;
		expectedUpdatedAt?: Date;
	},
) {
	if (!input.organizationId) {
		return null;
	}
	await tx.$queryRaw`SELECT "id" FROM "agent_workspace_file" WHERE "id" = ${input.frameId} AND "organizationId" = ${input.organizationId} AND "userId" = ${input.userId} FOR UPDATE`;
	const frame = await tx.agentWorkspaceFile.findFirst({
		where: {
			id: input.frameId,
			userId: input.userId,
			organizationId: input.organizationId,
			fileType: { in: ["FRAME", "SLIDESHOW"] },
		},
	});
	if (frame) {
		assertFrameRevision(input.expectedUpdatedAt, frame.updatedAt);
	}
	return frame;
}

/**
 * Set an audience and grant invitations atomically. The PRIVATE audience is an
 * explicit revoke-all: dormant grants must never reappear after a later share.
 * Callers still authorize their current capability before entering this command.
 */
export async function shareFrame(
	input: ShareFrameInput,
): Promise<ShareFrameOutcome> {
	const organizationId = input.organizationId;
	if (!organizationId) {
		return refusal("frame_not_found", "Frame not found.");
	}
	const emails = normalizedEmails(input.emails);
	if (
		emails.some((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) ||
		emails.length > 50
	) {
		return refusal(
			"invalid_email",
			"Provide up to 50 valid email addresses.",
		);
	}
	return db.$transaction(async (tx) => {
		const frame = await lockedFrame(tx, input);
		if (!frame) {
			return refusal("frame_not_found", "Frame not found.");
		}
		const resulting = input.scope ?? frame.shareScope;
		if (
			emails.length > 0 &&
			!["EMAILS_ONLY", "WORKSPACE_AND_EMAILS"].includes(resulting)
		) {
			return refusal(
				"emails_need_an_inviting_scope",
				`Emails cannot be invited while the frame is ${resulting.toLowerCase()}. Share it with invited emails first.`,
			);
		}
		const policy = await tx.organization.findUnique({
			where: { id: input.organizationId, deletedAt: null },
			select: {
				canShareFramesPublicly: true,
				allowedFrameShareDomains: true,
			},
		});
		if (
			input.scope === "PUBLIC" &&
			!allowsPublicLinks(input.organizationId, policy)
		) {
			return refusal(
				"public_sharing_disabled",
				PUBLIC_SHARING_DISABLED_MESSAGE,
			);
		}
		if (!policy) {
			return refusal("frame_not_found", "Frame not found.");
		}
		const domains = allowedDomains(policy.allowedFrameShareDomains ?? []);
		const outside = emails.filter(
			(email) => domains.size > 0 && !domains.has(domainOf(email)),
		);
		if (outside.length) {
			return refusal(
				"email_domain_not_allowed",
				`This organization allows invitations only to the domains ${[...domains].join(", ")}.`,
				outside,
			);
		}
		const current = emails.length
			? await tx.frameSharingGrant.findMany({
					where: { frameId: input.frameId },
					orderBy: { invitedAt: "desc" },
				})
			: [];
		const existing = new Set(current.map((grant) => grant.email));
		const invited = emails.filter((email) => !existing.has(email));
		if (invited.length) {
			throwIfDispatchStopped();
			await tx.frameSharingGrant.createMany({
				data: invited.map((email) => ({
					frameId: input.frameId,
					email,
					invitedBy: input.userId,
				})),
				skipDuplicates: true,
			});
		}
		let removed = 0;
		if (resulting === "PRIVATE" && input.scope !== undefined) {
			throwIfDispatchStopped();
			removed = (
				await tx.frameSharingGrant.deleteMany({
					where: { frameId: input.frameId },
				})
			).count;
		}
		const token =
			resulting === "PUBLIC" ? (frame.shareToken ?? randomUUID()) : null;
		throwIfDispatchStopped();
		const updated = await tx.agentWorkspaceFile.update({
			where: { id: frame.id, updatedAt: frame.updatedAt },
			data: {
				shareScope: resulting,
				isPublic: resulting === "PUBLIC",
				shareToken: token,
				updatedAt: nextFrameRevision(frame.updatedAt),
			},
		});
		await recordAuditTx(tx, {
			action: "frame.sharing.updated",
			organizationId,
			actor: { type: "user", userId: input.userId },
			resource: { type: "frame", id: frame.id },
			projectId: frame.projectId,
			metadata: {
				previousScope: frame.shareScope,
				scope: resulting,
				invitedCount: invited.length,
				revokedCount: removed,
				revision: updated.updatedAt.toISOString(),
			},
		});
		const grants = invited.length
			? await tx.frameSharingGrant.findMany({
					where: { frameId: input.frameId, email: { in: invited } },
					orderBy: { invitedAt: "desc" },
				})
			: [];
		return {
			ok: true,
			scope: resulting,
			...(token && input.scope === "PUBLIC" ? { shareToken: token } : {}),
			invited,
			grants,
			updatedAt: updated.updatedAt,
		};
	});
}

export interface RevokeFrameSharingInput {
	frameId: string;
	userId: string;
	organizationId?: string;
	mode: "public-link" | "invitation" | "all";
	email?: string;
	expectedUpdatedAt?: Date;
}
export type RevokeFrameSharingOutcome =
	| {
			ok: true;
			scope: FrameShareScope;
			revokedInvitations: number;
			updatedAt: Date;
	  }
	| { ok: false; reason: ShareFrameRefusal; message: string };

/** Remove exactly the chosen access path. Never silently remove unrelated invitations. */
export async function revokeFrameSharing(
	input: RevokeFrameSharingInput,
): Promise<RevokeFrameSharingOutcome> {
	const organizationId = input.organizationId;
	if (!organizationId) {
		return {
			ok: false,
			reason: "frame_not_found",
			message: "Frame not found.",
		};
	}
	if (!["public-link", "invitation", "all"].includes(input.mode)) {
		return {
			ok: false,
			reason: "invalid_revoke_mode",
			message: "Choose the access to remove.",
		};
	}
	const email = input.email?.trim().toLowerCase();
	if (
		input.mode === "invitation" &&
		(!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
	) {
		return {
			ok: false,
			reason: "invalid_email",
			message: "Choose a valid invitation to remove.",
		};
	}
	return db.$transaction(async (tx) => {
		const frame = await lockedFrame(tx, input);
		if (!frame) {
			return {
				ok: false,
				reason: "frame_not_found",
				message: "Frame not found.",
			};
		}
		let revokedInvitations = 0;
		if (input.mode === "all" || input.mode === "invitation") {
			throwIfDispatchStopped();
			revokedInvitations = (
				await tx.frameSharingGrant.deleteMany({
					where: {
						frameId: frame.id,
						...(input.mode === "invitation" ? { email } : {}),
					},
				})
			).count;
		}
		const scope =
			input.mode === "all"
				? "PRIVATE"
				: input.mode === "public-link" && frame.shareScope === "PUBLIC"
					? "EMAILS_ONLY"
					: frame.shareScope;
		throwIfDispatchStopped();
		const updated = await tx.agentWorkspaceFile.update({
			where: { id: frame.id, updatedAt: frame.updatedAt },
			data: {
				...(input.mode !== "invitation"
					? { shareScope: scope, isPublic: false, shareToken: null }
					: {}),
				updatedAt: nextFrameRevision(frame.updatedAt),
			},
		});
		await recordAuditTx(tx, {
			action: "frame.sharing.revoked",
			organizationId,
			actor: { type: "user", userId: input.userId },
			resource: { type: "frame", id: frame.id },
			projectId: frame.projectId,
			metadata: {
				mode: input.mode,
				scope,
				revokedCount: revokedInvitations,
				revision: updated.updatedAt.toISOString(),
			},
		});
		return {
			ok: true,
			scope,
			revokedInvitations,
			updatedAt: updated.updatedAt,
		};
	});
}
