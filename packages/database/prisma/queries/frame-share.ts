import { db } from "../client";
import {
	createMultipleSharingGrants,
	type FrameShareScope,
	listSharingGrants,
	type SharingGrant,
	updateFrameShareScope,
} from "./frame-sharing";

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
 * A caller with no organization has no policy to hold it to.
 */
function allowsPublicLinks(
	organizationId: string | undefined,
	policy: { canShareFramesPublicly: boolean } | null,
): boolean {
	return !organizationId || Boolean(policy?.canShareFramesPublicly);
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
				where: { id: organizationId },
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
export async function shareFrame(input: {
	frameId: string;
	userId: string;
	organizationId?: string;
	scope?: ShareableFrameScope;
	emails?: readonly string[];
}): Promise<ShareFrameOutcome> {
	const { frameId, userId, organizationId, scope } = input;
	const emails = normalizedEmails(input.emails);

	const frame = await db.agentWorkspaceFile.findFirst({
		where: {
			id: frameId,
			userId,
			organizationId: organizationId ?? null,
			fileType: { in: ["FRAME", "SLIDESHOW"] },
		},
		select: { shareScope: true },
	});
	if (!frame) {
		return refusal("frame_not_found", "Frame not found.");
	}

	const resulting = scope ?? frame.shareScope;
	if (
		emails.length > 0 &&
		(resulting === "PRIVATE" || resulting === "PUBLIC")
	) {
		return refusal(
			"emails_need_an_inviting_scope",
			`Emails cannot be invited while the frame is ${resulting.toLowerCase()}. Share it with invited emails first.`,
		);
	}

	const policy = organizationId
		? await db.organization.findUnique({
				where: { id: organizationId },
				select: {
					canShareFramesPublicly: true,
					allowedFrameShareDomains: true,
				},
			})
		: null;

	if (scope === "PUBLIC" && !allowsPublicLinks(organizationId, policy)) {
		return refusal(
			"public_sharing_disabled",
			PUBLIC_SHARING_DISABLED_MESSAGE,
		);
	}

	const domains = allowedDomains(policy?.allowedFrameShareDomains ?? []);
	if (emails.length > 0 && domains.size > 0) {
		const outside = emails.filter((email) => !domains.has(domainOf(email)));
		if (outside.length > 0) {
			return refusal(
				"email_domain_not_allowed",
				`This organization allows invitations only to the domains ${[...domains].join(", ")}.`,
				outside,
			);
		}
	}

	let shareToken: string | undefined;
	if (scope !== undefined) {
		const changed = await updateFrameShareScope({
			frameId,
			userId,
			organizationId,
			shareScope: scope,
		});
		if (!changed.success) {
			return refusal("frame_not_found", "Frame not found.");
		}
		shareToken = scope === "PUBLIC" ? changed.shareToken : undefined;
	}

	let invited: string[] = [];
	let grants: SharingGrant[] = [];
	if (emails.length > 0) {
		const already = new Set(
			(await listSharingGrants(frameId)).map((grant) => grant.email),
		);
		invited = emails.filter((email) => !already.has(email));
		if (invited.length > 0) {
			grants = await createMultipleSharingGrants(
				frameId,
				invited,
				userId,
			);
		}
	}

	return {
		ok: true,
		scope: resulting,
		...(shareToken ? { shareToken } : {}),
		invited,
		grants,
	};
}
