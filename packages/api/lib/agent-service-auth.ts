import { createHash, timingSafeEqual } from "node:crypto";
import {
	signToken,
	type VerifyResult,
	verifyToken,
} from "@repo/auth/lib/signed-token";

export function isAgentServiceRequestAuthorized(
	provided: string | null,
): boolean {
	const expected = process.env.AGENT_SERVICE_SECRET;
	return Boolean(
		provided &&
			expected &&
			timingSafeEqual(
				createHash("sha256").update(provided).digest(),
				createHash("sha256").update(expected).digest(),
			),
	);
}

/**
 * The acting grant: proof, minted by the web route that accepted a person's chat
 * turn, that this turn is acting for this user in this organization.
 *
 * `AGENT_SERVICE_SECRET` is shared by the Temporal worker, the agent containers
 * and several internal routes, and the user and organization ids it is sent
 * with are not secret, so on its own it lets any holder act as anyone. The
 * grant is what only the web app can issue: an HMAC over the user, the
 * organization, the conversation and an expiry, signed with the web app's
 * `BETTER_AUTH_SECRET` through the same `signToken` the invitation and
 * email-change tokens use (the Azure agent containers and the partykit app are
 * not given that secret). A `purpose` inside the signed payload keeps it from
 * being read as, or confused with, any other token that secret signs.
 *
 * The worker carries it unread through the workflow input and sends it back as
 * `X-Fabric-Acting-Grant`; the gateway refuses a service call without a valid
 * one. One hour is the longest a chat turn's workflow runs.
 */
const ACTING_GRANT_PURPOSE = "fabric-agent-acting-grant";
const ACTING_GRANT_TTL_SECONDS = 60 * 60;

interface ActingGrantPayload {
	purpose: typeof ACTING_GRANT_PURPOSE;
	userId: string;
	organizationId: string;
	conversationId: string | null;
	/**
	 * Gateway scopes beyond the base set the runtime always holds, and the one
	 * project they are limited to. Both or neither: a grant minted for a chat
	 * carries neither and keeps the base set, and the gateway ignores scopes
	 * that name no project.
	 */
	scopes?: string[];
	projectId?: string;
}

export function mintActingGrant(subject: {
	userId: string;
	organizationId: string;
	conversationId?: string | null;
	scopes?: readonly string[];
	projectId?: string;
}): string {
	return signToken<ActingGrantPayload>(
		{
			purpose: ACTING_GRANT_PURPOSE,
			userId: subject.userId,
			organizationId: subject.organizationId,
			conversationId: subject.conversationId ?? null,
			...(subject.scopes && subject.projectId
				? { scopes: [...subject.scopes], projectId: subject.projectId }
				: {}),
		},
		{ ttlSec: ACTING_GRANT_TTL_SECONDS },
	);
}

/**
 * What a Parlume meeting turn is granted beyond the base set: the project,
 * document, feature, instruction and workspace-read scopes of the Fabric portal
 * tools. The gateway keeps only what its own ceiling
 * (`SERVICE_GRANT_MAX_SCOPES`) allows, and only for the project named.
 */
export const PARLUME_GRANT_SCOPES: readonly string[] = [
	"orgs:read",
	"projects:read",
	"projects:write",
	"features:read",
	"features:write",
	"instructions:read",
	"instructions:write",
	"workspaces:read",
	"chats:read",
	"mcp:read",
	"workflows:read",
	"workflows:write",
	"workflows:run",
	"frames:read",
	"frames:write",
];

/**
 * A read-only meeting's grant: the portal scopes without their writes, so a
 * leaked grant from such a meeting cannot change the project either. The
 * workflow and frame writes stay, because the gateway's base set holds them
 * for every service session anyway.
 */
export const PARLUME_READ_ONLY_GRANT_SCOPES: readonly string[] =
	PARLUME_GRANT_SCOPES.filter((scope) => !scope.endsWith(":write"));

/**
 * The grant for one Parlume meeting turn: the inviter, the organization and the
 * meeting's project, with the portal scopes (reads only for a read-only
 * meeting). Minted for each turn, like the chat grant, so a meeting longer than
 * the grant's hour keeps working, and undefined when there is no secret to
 * sign with.
 */
export function mintParlumeActingGrantForTurn(subject: {
	userId: string;
	organizationId: string;
	projectId: string;
	readOnly: boolean;
}): string | undefined {
	try {
		return mintActingGrant({
			userId: subject.userId,
			organizationId: subject.organizationId,
			scopes: subject.readOnly
				? PARLUME_READ_ONLY_GRANT_SCOPES
				: PARLUME_GRANT_SCOPES,
			projectId: subject.projectId,
		});
	} catch (error) {
		console.error(
			"[Agent] Could not mint an acting grant; this meeting turn has no Fabric tools",
			error instanceof Error ? error.message : error,
		);
		return undefined;
	}
}

/**
 * The grant for a chat turn a route is about to start, or undefined when there
 * is nothing to act in (no organization) or no secret to sign with. A turn
 * without one starts all the same: it simply has no Fabric workflow or frame
 * tools, and says so when asked for them, rather than the whole chat failing.
 */
export function mintActingGrantForTurn(subject: {
	userId: string;
	organizationId: string | null | undefined;
	conversationId?: string | null;
}): string | undefined {
	if (!subject.organizationId) {
		return undefined;
	}
	try {
		return mintActingGrant({
			userId: subject.userId,
			organizationId: subject.organizationId,
			conversationId: subject.conversationId,
		});
	} catch (error) {
		console.error(
			"[Agent] Could not mint an acting grant; this turn has no Fabric tools",
			error instanceof Error ? error.message : error,
		);
		return undefined;
	}
}

export type ActingGrantFailure = "missing" | "invalid" | "expired" | "mismatch";

export type ActingGrantCheck =
	| { ok: true; scopes?: string[]; projectId?: string }
	| { ok: false; reason: ActingGrantFailure };

function isActingGrantPayload(value: unknown): value is ActingGrantPayload {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const payload = value as Record<string, unknown>;
	return (
		payload.purpose === ACTING_GRANT_PURPOSE &&
		typeof payload.userId === "string" &&
		typeof payload.organizationId === "string" &&
		(payload.conversationId === null ||
			typeof payload.conversationId === "string") &&
		hasValidProjectScopes(payload)
	);
}

/** Scopes and a project come together, as strings, or not at all. */
function hasValidProjectScopes(payload: Record<string, unknown>): boolean {
	const { scopes, projectId } = payload;
	if (scopes === undefined && projectId === undefined) {
		return true;
	}
	return (
		Array.isArray(scopes) &&
		scopes.every((scope) => typeof scope === "string") &&
		typeof projectId === "string" &&
		projectId.length > 0
	);
}

/**
 * Whether `grant` was minted for exactly this user and organization, and for
 * this conversation when it names one and the call does too. A grant that is
 * absent, forged, tampered with, expired, or minted for someone else is a
 * refusal with the reason.
 */
export function checkActingGrant(
	grant: string | null | undefined,
	acting: {
		userId: string;
		organizationId: string;
		conversationId?: string;
	},
): ActingGrantCheck {
	if (!grant) {
		return { ok: false, reason: "missing" };
	}
	let verified: VerifyResult<unknown>;
	try {
		verified = verifyToken<unknown>(grant);
	} catch {
		// The signing secret is not configured: nothing can be verified, so
		// nothing is accepted.
		return { ok: false, reason: "invalid" };
	}
	if (!verified.ok) {
		return {
			ok: false,
			reason: verified.reason === "expired" ? "expired" : "invalid",
		};
	}
	if (!isActingGrantPayload(verified.payload)) {
		return { ok: false, reason: "invalid" };
	}
	const { userId, organizationId, conversationId } = verified.payload;
	if (userId !== acting.userId || organizationId !== acting.organizationId) {
		return { ok: false, reason: "mismatch" };
	}
	if (
		conversationId !== null &&
		acting.conversationId !== undefined &&
		conversationId !== acting.conversationId
	) {
		return { ok: false, reason: "mismatch" };
	}
	const { scopes, projectId } = verified.payload;
	return scopes && projectId ? { ok: true, scopes, projectId } : { ok: true };
}
