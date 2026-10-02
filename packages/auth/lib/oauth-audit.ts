/**
 * Audit row for the moment a person approves an agent.
 *
 * Emitted from the global `hooks.after` rather than from the plugin, because
 * the plugin has no event for it. Revocation is audited where it happens, in
 * the API procedure behind the Connected agents page.
 */

import { recordAudit } from "@repo/database";

export interface OAuthConsentHookContext {
	path: string;
	body?: unknown;
	context: {
		session?: {
			user?: { id?: string; email?: string | null; name?: string | null };
			session?: { activeOrganizationId?: string | null };
		} | null;
		returned?: unknown;
	};
}

function acceptedBody(body: unknown): { oauth_query?: string } | null {
	if (
		!body ||
		typeof body !== "object" ||
		!("accept" in body) ||
		body.accept !== true
	) {
		return null;
	}
	return {
		oauth_query:
			"oauth_query" in body && typeof body.oauth_query === "string"
				? body.oauth_query
				: undefined,
	};
}

/**
 * Record `account.oauth.consent_granted` for a successful, accepted consent.
 * A denial writes nothing, and neither does a failed request: `returned` is the
 * error itself when the endpoint threw.
 */
export function emitOAuthConsentAudit(
	ctx: OAuthConsentHookContext,
	organizationId: string | null,
): void {
	if (ctx.path !== "/oauth2/consent") {
		return;
	}
	const accepted = acceptedBody(ctx.body);
	if (!accepted || ctx.context.returned instanceof Error) {
		return;
	}

	const user = ctx.context.session?.user;
	if (!user?.id) {
		return;
	}

	const clientId = accepted.oauth_query
		? new URLSearchParams(accepted.oauth_query).get("client_id")
		: null;
	const scope = accepted.oauth_query
		? new URLSearchParams(accepted.oauth_query).get("scope")
		: null;

	recordAudit({
		action: "account.oauth.consent_granted",
		category: "account",
		actor: {
			type: "user",
			userId: user.id,
			emailSnapshot: user.email ?? null,
			nameSnapshot: user.name ?? null,
		},
		organizationId,
		resource: { type: "oauth_client", id: clientId, name: null },
		metadata: { scopes: scope ? scope.split(" ") : [] },
	});
}
