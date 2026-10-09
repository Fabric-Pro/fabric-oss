/**
 * Fabric MCP Gateway - Streamable HTTP Transport
 *
 * Unified MCP endpoint that exposes ALL Fabric capabilities and connected
 * MCP server tools through a single URL. Works with any MCP client:
 * Claude Desktop, Cursor, VS Code, Windsurf, or custom implementations.
 *
 * It is served at two URLs by two thin route files that call the handlers
 * here: `/api/mcp-gateway`, which is organization-wide, and
 * `/api/mcp-gateway/projects/<id>`, which is one project's. A project URL
 * hands the handlers a `GatewayBinding`, and everything below that takes one
 * keeps the session on that project: which credentials are admitted, which
 * organization it runs in, which tools it lists and calls, and which sessions
 * it may reuse.
 *
 * Authentication:
 *   - OAuth access token: `Authorization: Bearer fat_xxx`, obtained by signing
 *     in from the agent (discovery starts at the `WWW-Authenticate` challenge on
 *     a 401). Bound to the organization chosen at consent, or to the one
 *     project the agent signed in for, which it reaches at that project's URL
 *     and nowhere else.
 *   - API Key: `Authorization: Bearer fab_xxx` (CI and headless clients)
 *   - Session cookie: Better Auth session (for browser-based clients)
 *   - Organization context: `X-Organization-Id` header — optional, and honoured
 *     only when the authenticated caller is a member of the organization it
 *     names. A personal key that names none resolves to the caller's own
 *     organization; see `authenticateRequest`.
 *
 * MCP Protocol:
 *   - POST: JSON-RPC requests (initialize, tools/list, tools/call, etc.)
 *   - DELETE: Terminate session
 *   - GET: Server info (non-standard, for health checks)
 *
 * Tool Namespacing:
 *   - Platform tools: `fabric_*` (e.g., fabric_list_projects, fabric_get_document)
 *   - Connected server tools: `{prefix}__{tool}` (e.g., linear__list_issues)
 *
 * @see https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { verifyUserApiKey } from "@repo/api/modules/users/procedures/api-keys";
import { auth } from "@repo/auth";
import { gatewayAuthenticateHeader } from "@repo/auth/lib/oauth-scopes";
import {
	isOrganizationLive,
	resolveOAuthProjectGrantTarget,
	verifyOAuthAccessToken,
} from "@repo/database";
import { getBaseUrl } from "@repo/utils";
import {
	buildProjectResource,
	isProjectId,
} from "@repo/utils/oauth-project-resource";
import { CLI_TARBALL_PATH } from "@saas/cli-distribution/lib/cli-discovery";
import {
	createGatewaySession,
	deleteGatewaySession,
	executeConnectedServerTool,
	executePlatformTool,
	type GatewaySession,
	getAggregatedTools,
	getGatewaySession,
	type JsonRpcRequest,
	updateSessionOrganization,
} from "@saas/mcp/lib/gateway";
import {
	classifyConnectedToolAccess,
	enforceAuthority,
	generateRequestFingerprint,
	resolveProviderKeyFromToolPrefix,
} from "@saas/mcp/lib/gateway/authority-service";
import { boundProjectId } from "@saas/mcp/lib/gateway/project-binding";
import { scopeSatisfied } from "@saas/mcp/lib/gateway/tool-scope";
import type { GatewayCredential } from "@saas/mcp/lib/gateway/types";
import {
	type McpKeyIdentity,
	recordCliReach,
	toOAuthClientIdentity,
	toOrganizationKeyIdentity,
	toUserKeyIdentity,
} from "@saas/mcp/lib/record-cli-reach";
import { recordOrganizationRefusal } from "@saas/mcp/lib/record-organization-refusal";
import { type NextRequest, NextResponse } from "next/server";

/**
 * The project a request's URL names, for a request to
 * `/api/mcp-gateway/projects/<id>`. Absent at the organization-wide URL.
 */
export interface GatewayBinding {
	projectId: string;
}

/**
 * The binding for the id in a project URL, or null for a segment that cannot be
 * a project id and so names nothing. A well-formed id that matches no project is
 * not null: whether it exists is answered, as for any other project, only to a
 * caller who may read it.
 */
export function resolveGatewayBinding(segment: string): GatewayBinding | null {
	return isProjectId(segment) ? { projectId: segment } : null;
}

const GATEWAY_NAME = "fabric-mcp-gateway";
const GATEWAY_VERSION = "1.0.0";
const PROTOCOL_VERSION = "2025-03-26";

/**
 * The transport a caller names an organization on.
 *
 * The same header the hosted protocol server reads (`apps/web/app/mcp/route.ts`),
 * and the one this file's own documentation block has advertised since the
 * gateway shipped even though nothing here read it. Naming it explicitly means
 * a client written against those docs starts working, and nobody has to learn
 * a second convention for the same question.
 */
const ORGANIZATION_HEADER = "x-organization-id";

// ─── Authentication ─────────────────────────────────────────────────────────

interface AuthResult {
	userId: string;
	organizationId: string | null;
	/** The one project the session reaches; null for an organization-wide one. */
	projectId: string | null;
	userName: string;
	email: string;
	role: "user" | "admin";
	/** What proved this identity. See `GatewayCredential`. */
	credential: GatewayCredential;
	/**
	 * Scopes the presenting key was granted. A browser session gets `["*"]`:
	 * no key chose scopes, and the interactive checks that already govern the
	 * UI are not loosened by anything here.
	 */
	scopes: string[];
	/**
	 * Which key row proved this identity — kind plus persisted id.
	 *
	 * Populated by the two key branches and left ABSENT by the session branch,
	 * which is what stops a browser session being recorded as a CLI connection
	 * (Fizzy #2457, R2).
	 *
	 * That is a CONVENTION the session branch keeps, not something the compiler
	 * checks. `AuthResult` is a flat interface and `credential` is a plain
	 * string union, so `{ credential: "session", keyIdentity:
	 * toUserKeyIdentity(id) }` type-checks today and would record in-app
	 * browsing as a CLI connection. What actually holds the line is the pair of
	 * connection-record suites — `__tests__/api/mcp-connection-record` for this
	 * host and `__tests__/api/mcp-hosted-connection-record` for the protocol
	 * server — which assert that a session request writes nothing. The risk is
	 * not theoretical: building an identity is now a one-line call to a shared
	 * helper that anything can reach.
	 *
	 * KNOWN FOLLOW-UP, deliberately deferred: make `AuthResult` a discriminated
	 * union on `credential`, so the session variant cannot carry a key identity
	 * at all and the convention above becomes a compiler error instead of a
	 * test failure. It threads through this file and the hosted protocol route,
	 * which is why it is a follow-up of its own rather than a passenger on
	 * the round-2 review fixes.
	 *
	 * `credential` alone could not carry the identity either way: every
	 * organization key would collapse into one record and revocation would stop
	 * meaning anything.
	 */
	keyIdentity?: McpKeyIdentity;
}

/**
 * What authenticating one request concluded. Three answers, not two.
 *
 * `unauthenticated` means no usable credentials were presented, and the caller
 * gets the 401 they always got. `refused` means the credentials were fine and
 * the tenancy was not — so it is a separate outcome with its own status, because
 * presenting the same key again unchanged cannot turn it into a success.
 *
 * The two absences the shared resolver reports stay apart the whole way to the
 * response. "Belongs to several organizations and named none" is answerable by
 * the caller: they name one on the organization header. "Belongs to none" is
 * not answerable by anyone here. Collapsed into a single refusal, half of those
 * callers would go looking for a header value that does not exist.
 */
type AuthOutcome =
	| { status: "authenticated"; authResult: AuthResult }
	| { status: "unauthenticated" }
	| {
			/**
			 * A genuine OAuth token, issued for another resource than the URL it
			 * was presented at: an organization-wide token at a project's URL,
			 * another project's, or a token for the REST API. Answered 401 with the
			 * challenge that sends a client back through sign-in for this URL.
			 */
			status: "wrong_resource";
			message: string;
	  }
	| {
			status: "refused";
			reason:
				| "not_a_member"
				| "ambiguous_organization"
				| "no_membership"
				| "project_not_accessible";
			message: string;
	  };

const UNAUTHENTICATED: AuthOutcome = { status: "unauthenticated" };

function authenticatedAs(authResult: AuthResult): AuthOutcome {
	return { status: "authenticated", authResult };
}

/**
 * A credential presented at a project's URL that cannot act on the project:
 * there is none, the person cannot read it, or an organization key belongs to
 * another organization. One answer for all of them, so the URL says nothing of
 * which projects exist.
 */
function refusedProjectNotAccessible(): AuthOutcome {
	return {
		status: "refused",
		reason: "project_not_accessible",
		message: "Project not found or access denied",
	};
}

/**
 * Bind a session that a key or a browser authenticated to the project whose URL
 * it was presented at. The project decides the organization: a personal key or
 * a session names none here, and an organization key must already be the one
 * hosting the project. Project access is the one question `resolveGatewayProject*`
 * asks on every tool call, asked once more at the door so a connection to a
 * project the person cannot read is refused as one.
 */
async function bindToProject(
	authResult: AuthResult,
	binding: GatewayBinding,
): Promise<AuthOutcome> {
	const target = await resolveOAuthProjectGrantTarget(
		authResult.userId,
		binding.projectId,
	);
	if (
		!target ||
		(authResult.credential === "organization-key" &&
			authResult.organizationId !== target.organizationId)
	) {
		return refusedProjectNotAccessible();
	}
	return authenticatedAs({
		...authResult,
		organizationId: target.organizationId,
		projectId: target.projectId,
	});
}

/** The caller named an organization they hold no membership in. */
function refusedNotAMember(organizationId: string): AuthOutcome {
	return {
		status: "refused",
		reason: "not_a_member",
		message: `Access denied: you are not a member of organization ${organizationId}`,
	};
}

/**
 * The caller belongs to several organizations and nothing authorised names one
 * of them. Answerable: the message lists the organizations they may name and
 * the header to name one on.
 */
function refusedAmbiguousOrganization(organizationIds: string[]): AuthOutcome {
	return {
		status: "refused",
		reason: "ambiguous_organization",
		message:
			"This key's owner belongs to several organizations and none is selected. " +
			`Name one on the ${ORGANIZATION_HEADER} request header: ${organizationIds.join(", ")}.`,
	};
}

/**
 * The caller belongs to no organization. Not answerable by any retry, so the
 * message says what would have to change instead of inviting one.
 */
function refusedNoMembership(): AuthOutcome {
	return {
		status: "refused",
		reason: "no_membership",
		message:
			"This key's owner belongs to no organization, so there is no context to run in. " +
			`Join or create one first — the ${ORGANIZATION_HEADER} header cannot supply one.`,
	};
}

/**
 * Authenticate the request via API key or session cookie, and decide which
 * organization it runs in.
 *
 * The two questions are answered together because the answer to the second one
 * can refuse the request outright, and a refusal has to be distinguishable from
 * "no credentials" all the way out to the response.
 *
 * At a project's URL (`binding`) the organization is the project's own, and
 * every credential ends in the same two questions: may this person read the
 * project, and, for an organization key, is it the organization hosting it. An
 * OAuth token answers them from what it was issued for and must have been
 * issued for exactly this project.
 */
async function authenticateRequest(
	request: NextRequest,
	binding: GatewayBinding | null,
): Promise<AuthOutcome> {
	const authHeader = request.headers.get("authorization");

	// 1a. Personal API key (Bearer fab_xxx) — the key names a user and no
	// tenant, so this path decides the organization instead of returning none.
	// Either the caller names one of their own on the organization header, or
	// the shared resolver answers from their memberships; every other outcome
	// is a refusal the caller can read (R3, R6).
	if (authHeader?.startsWith("Bearer fab_")) {
		const apiKey = authHeader.substring(7);
		const result = await verifyUserApiKey(apiKey);

		if (!result.valid || !result.userId) {
			return UNAUTHENTICATED;
		}

		const { db, isOrganizationMember, resolveUserOrganization } =
			await import("@repo/database");
		const user = await db.user.findUnique({
			where: { id: result.userId },
			select: { name: true, email: true, role: true },
		});

		if (!user) {
			return UNAUTHENTICATED;
		}

		const keyIdentity = toUserKeyIdentity(result.keyId);

		const identity = {
			userId: result.userId,
			userName: user.name || "Unknown",
			email: user.email,
			role: (user.role as "user" | "admin") || "user",
			credential: "personal-key" as const,
			scopes: result.scopes ?? [],
			projectId: null,
			keyIdentity,
		};

		// At a project's URL the project names the organization, and the
		// organization header is not read.
		if (binding) {
			return bindToProject(
				{ ...identity, organizationId: null },
				binding,
			);
		}

		// The caller-supplied organization is verified HERE, against the user
		// this request just authenticated. The hosted server runs the same
		// check on its own selector, and neither route can vouch for a request
		// the other handled — so the check travels with the selector rather
		// than being assumed to have happened elsewhere.
		const requestedOrganizationId =
			request.headers.get(ORGANIZATION_HEADER) ?? null;

		if (requestedOrganizationId) {
			if (
				!(await isOrganizationMember(
					identity.userId,
					requestedOrganizationId,
				))
			) {
				// Audited on both entry points, through one helper. The
				// refusal is the only trace the attempt leaves — the request
				// never reaches a tenant-scoped query — so recording it on one
				// server and not the other would make the ledger depend on
				// which door the caller knocked at.
				recordOrganizationRefusal(
					request.headers,
					{
						userId: identity.userId,
						email: identity.email,
						name: user.name ?? null,
					},
					requestedOrganizationId,
					"mcp-gateway",
				);
				return refusedNotAMember(requestedOrganizationId);
			}

			return authenticatedAs({
				...identity,
				organizationId: requestedOrganizationId,
			});
		}

		const resolution = await resolveUserOrganization(identity.userId);

		switch (resolution.kind) {
			case "resolved":
				return authenticatedAs({
					...identity,
					organizationId: resolution.organizationId,
				});
			case "ambiguous":
				// Somewhere to go, but the caller has not said where. They can
				// answer this one, and the message tells them how.
				return refusedAmbiguousOrganization(resolution.organizationIds);
			default:
				// Nowhere to go. A different absence, and a different message.
				return refusedNoMembership();
		}
	}

	// 1b. Organization API key (Bearer org_xxx) — organizationId comes from the
	// key record itself, so there is nothing caller-supplied to resolve, and
	// the organization header is deliberately not consulted: a key that
	// carries its own tenant cannot be pointed at another one by a request
	// header.
	//
	// There is still something to verify, though, and this branch used to say
	// there was not. The tenant is settled by the key; the *person* is not. A
	// key proves who its creator is, never that they still belong here, so
	// membership is re-read below on every request.
	if (authHeader?.startsWith("Bearer org_")) {
		const apiKey = authHeader.substring(7);
		const parts = apiKey.split("_");
		if (parts.length < 3 || parts[0] !== "org") {
			return UNAUTHENTICATED;
		}

		const keyPrefix = `org_${parts[1]}`;
		const {
			getOrganizationApiKeyByPrefix,
			updateOrganizationApiKeyUsage,
			isOrganizationMember,
			db,
		} = await import("@repo/database");

		const storedKey = await getOrganizationApiKeyByPrefix(keyPrefix);
		if (!storedKey || !storedKey.isActive) {
			return UNAUTHENTICATED;
		}
		if (storedKey.expiresAt && storedKey.expiresAt < new Date()) {
			return UNAUTHENTICATED;
		}

		const keyHash = createHash("sha256").update(apiKey).digest();
		const storedHash = Buffer.from(storedKey.keyHash, "hex");
		if (
			keyHash.length !== storedHash.length ||
			!timingSafeEqual(keyHash, storedHash)
		) {
			return UNAUTHENTICATED;
		}

		updateOrganizationApiKeyUsage(storedKey.id).catch(() => {});

		const user = await db.user.findUnique({
			where: { id: storedKey.createdByUserId },
			select: { name: true, email: true, role: true },
		});

		if (!user) {
			return UNAUTHENTICATED;
		}

		// Offboarding has to reach the API, and until now it did not: the key
		// outlived its creator's membership, so someone removed from the
		// organization kept every capability this key carries until a human
		// found the row and deleted it. Permissions resolve live — from
		// membership, on each request — and a key is only ever the claim about
		// *who* is asking.
		//
		// 401 rather than a readable refusal, deliberately: the same answer an
		// inactive or expired key gets, so a caller holding a still-valid
		// secret cannot tell "this key is dead" from "this person is out".
		if (
			!(await isOrganizationMember(
				storedKey.createdByUserId,
				storedKey.organizationId,
			))
		) {
			return UNAUTHENTICATED;
		}

		const organizationKeyResult: AuthResult = {
			userId: storedKey.createdByUserId,
			organizationId: storedKey.organizationId,
			projectId: null,
			userName: user.name || "Unknown",
			email: user.email,
			role: (user.role as "user" | "admin") || "user",
			credential: "organization-key",
			scopes: storedKey.scopes,
			keyIdentity: toOrganizationKeyIdentity(storedKey.id),
		};
		return binding
			? bindToProject(organizationKeyResult, binding)
			: authenticatedAs(organizationKeyResult);
	}

	// 1c. OAuth access token — a coding agent that signed in instead of
	// pasting a key. The token names the user and the organization chosen at
	// consent, and neither the organization header nor the session's active
	// organization can move it. Everything that makes a token dead (expired,
	// revoked, client disabled, owner gone or banned, no longer a member) is
	// settled inside the verifier and answered with the same 401 as any other
	// bad credential.
	//
	// What it was issued for is checked against the URL it was presented at, and
	// only exact agreement admits it: a project's token works at that project's
	// URL, an organization's at the organization-wide one, and a token for the
	// REST API at neither. A mismatch is a 401 with the challenge for THIS URL,
	// which is what sends a client back through sign-in asking for the right
	// resource (MCP authorization: a server must refuse a token not issued for
	// it).
	if (authHeader?.startsWith("Bearer ")) {
		const token = await verifyOAuthAccessToken(authHeader.substring(7), {
			appUrl: getBaseUrl(),
			audience: "mcp",
		});
		if (!token.valid) {
			return UNAUTHENTICATED;
		}
		if (token.audience === "api") {
			return {
				status: "wrong_resource",
				message:
					"This access token was issued for the REST API, not the MCP gateway.",
			};
		}
		if (binding && token.projectId !== binding.projectId) {
			return {
				status: "wrong_resource",
				message:
					"This access token was not issued for this project. Sign in again from this project's URL.",
			};
		}
		if (!binding && token.projectId !== null) {
			return {
				status: "wrong_resource",
				message: `This access token is limited to one project. Connect to ${buildProjectResource(getBaseUrl(), "mcp", token.projectId)} instead.`,
			};
		}

		return authenticatedAs({
			userId: token.userId,
			organizationId: token.organizationId,
			projectId: token.projectId,
			userName: token.userName || "Unknown",
			email: token.email,
			role: (token.role as "user" | "admin") || "user",
			credential: "oauth",
			scopes: token.scopes,
			keyIdentity: toOAuthClientIdentity(token.clientRowId),
		});
	}

	// 2. Better Auth session.
	//
	// This branch used to be excluded from the no-null-organization rule, on
	// the grounds that a null meant personal context and personal context was
	// still a real place for a browser to be. It is not one any more, and the
	// exclusion's own note said retargeting belonged with the removal — this is
	// that removal. FR4 admits no code path that resolves to no organization,
	// and this was the last one.
	//
	// The organization header is still not read here: the session's value was
	// validated when the user switched into it, and a browser client that wants
	// another tenant switches again.
	const session = await auth.api.getSession({ headers: request.headers });
	if (!session?.user) {
		return UNAUTHENTICATED;
	}

	// At a project's URL the project names the organization, so the session's
	// active one, which may be any, is not read.
	if (binding) {
		return bindToProject(
			{
				userId: session.user.id,
				organizationId: null,
				projectId: null,
				userName: session.user.name || "Unknown",
				email: session.user.email,
				role: (session.user.role as "user" | "admin") || "user",
				credential: "session",
				scopes: ["*"],
			},
			binding,
		);
	}

	// The one branch where membership genuinely has to be re-read. The other
	// three settle it as they authenticate: a named organization is checked,
	// a resolved one comes from live membership rows, and an organization key
	// carries its tenant from the key record, where deactivating the key — not
	// its creator's membership — is what revokes it. `activeOrganizationId` is
	// none of those: it is a stored field that outlives the membership being
	// revoked, so it is confirmed here, where failing it can refuse. It used to
	// be checked during session reuse, which was too late to do anything but
	// re-issue the session in the same organization.
	const browserOrganizationId = session.session.activeOrganizationId ?? null;
	const { isOrganizationMember, resolveUserOrganization } = await import(
		"@repo/database"
	);
	if (browserOrganizationId) {
		if (
			!(await isOrganizationMember(
				session.user.id,
				browserOrganizationId,
			))
		) {
			return refusedNotAMember(browserOrganizationId);
		}
	}

	// Nothing named. Sessions are seeded with an organization at creation now,
	// so what reaches here is the residue: a session minted before that
	// shipped, or a caller whose membership was ambiguous enough that the
	// seeding declined to guess. Same shared resolver as the key branch — the
	// two entry points must not drift apart on this — and an absence refuses
	// rather than falling through to no tenant.
	if (!browserOrganizationId) {
		const resolution = await resolveUserOrganization(session.user.id);
		switch (resolution.kind) {
			case "ambiguous":
				return refusedAmbiguousOrganization(resolution.organizationIds);
			case "no_membership":
				return refusedNoMembership();
			case "resolved":
				return authenticatedAs({
					userId: session.user.id,
					organizationId: resolution.organizationId,
					projectId: null,
					userName: session.user.name || "Unknown",
					email: session.user.email,
					role: (session.user.role as "user" | "admin") || "user",
					credential: "session",
					scopes: ["*"],
				});
		}
	}

	return authenticatedAs({
		userId: session.user.id,
		organizationId: browserOrganizationId,
		projectId: null,
		userName: session.user.name || "Unknown",
		email: session.user.email,
		role: (session.user.role as "user" | "admin") || "user",
		credential: "session",
		scopes: ["*"],
	});
}

// ─── Origin Validation ──────────────────────────────────────────────────────

function validateOrigin(request: NextRequest): boolean {
	const origin = request.headers.get("origin");
	if (!origin) {
		return true; // No origin = same-origin or non-browser
	}

	if (process.env.NODE_ENV === "development") {
		if (origin.includes("localhost") || origin.includes("127.0.0.1")) {
			return true;
		}
	}

	const host = request.headers.get("host");
	try {
		const originUrl = new URL(origin);
		return originUrl.hostname === host?.split(":")[0];
	} catch {
		return false;
	}
}

// ─── Session Management ─────────────────────────────────────────────────────

/**
 * Release a gateway session, completing the runtime authority granted to it.
 *
 * Authority grants are bound to the session id, so a session that goes away has
 * to take its grants with it — otherwise they stay ACTIVE until they expire and
 * read as live authority in the interface while nothing can use them. The
 * DELETE handler always did this; a session released because it no longer
 * agrees with the caller's tenancy has to do it too, and that path is taken by
 * every session that predates organization resolution.
 *
 * Best-effort by design: failing to tidy the grants must not stop the session
 * being released.
 */
async function releaseGatewaySession(sessionId: string): Promise<void> {
	try {
		const { db, completeAuthoritySession } = await import("@repo/database");
		// Bound to THIS session, by the same id the grant was issued against
		// (`runId: session.sessionId` where authority is requested). Selecting
		// on user and organization instead would complete every grant that
		// person holds in that tenant — so one client releasing its session
		// would revoke a second client's still-valid authority. The DELETE
		// handler carried that shape before this helper existed; it fired
		// rarely enough to go unnoticed, and reusing it on the far more
		// frequent release path is what made it worth fixing.
		const activeSessions = await db.authoritySession.findMany({
			where: {
				runType: "MCP_GATEWAY",
				runId: sessionId,
				status: "ACTIVE",
			},
			select: { id: true },
		});
		// Awaited, not fire-and-forget: the session row is about to go, and a
		// completion that loses the race leaves a grant with nothing to bind to.
		await Promise.all(
			activeSessions.map((active) =>
				completeAuthoritySession(active.id).catch(() => {}),
			),
		);
	} catch {
		// Best-effort cleanup.
	}
	deleteGatewaySession(sessionId);
}

function sameCredentialAuthority(
	session: GatewaySession,
	authResult: AuthResult,
): boolean {
	if (session.credential !== authResult.credential) {
		return false;
	}
	const granted = new Set(session.scopes);
	return (
		granted.size === new Set(authResult.scopes).size &&
		authResult.scopes.every((scope) => granted.has(scope))
	);
}

/**
 * Return the session this request runs in.
 *
 * A stored session is reused only while it still names the organization this
 * request resolved to, and the project its URL names. Sessions live
 * twenty-four hours, so reusing one on user identity alone let the tenancy
 * decision taken when it was created outlive every later re-evaluation of it,
 * and a per-request resolution a day-old session can ignore is not a resolution
 * at all (R6c). A session created before this route resolved organizations
 * carries a null organization, never matches a resolved one, and is released on
 * its owner's next request. A session opened at a project's URL never serves
 * another project's, or the organization-wide one, and the other way round: its
 * tool list and the project every call is held to are part of it.
 *
 * Membership is deliberately NOT re-read here, and that is a correction rather
 * than an omission. A re-read at this point could not refuse: the only thing
 * after it is session creation with the same organization the check just
 * questioned, so a caller whose membership had been revoked was served anyway
 * under a new session id. It bought churn and no authorization. Membership is
 * settled during authentication instead, on every branch, where failing it
 * actually refuses.
 */
async function getOrCreateSession(
	mcpSessionId: string | null,
	authResult: AuthResult,
): Promise<{ session: GatewaySession; sessionId: string; isNew: boolean }> {
	// Try existing session from the centralized session store
	if (mcpSessionId) {
		const existing = getGatewaySession(mcpSessionId);
		if (existing && existing.userId === authResult.userId) {
			if (
				existing.organizationId === authResult.organizationId &&
				boundProjectId(existing) === authResult.projectId
			) {
				// The session also carries what its opener was allowed to do,
				// and a request that quotes its id presents its own credential.
				// A narrower key or sign-in must not inherit a broader one's
				// scopes, so a session is reused only by the same kind of
				// credential holding the same scopes. A different one is
				// served in a session of its own and the original is left to
				// its client.
				if (sameCredentialAuthority(existing, authResult)) {
					return {
						session: existing,
						sessionId: mcpSessionId,
						isNew: false,
					};
				}
			} else {
				// This caller's own session no longer names the organization
				// they resolve to, so it is released rather than left for a
				// later request to pick up. Only ever their own: a session id
				// quoted by a different user is left alone on this path.
				await releaseGatewaySession(mcpSessionId);
			}
		}
	}

	// Create new session
	const session = await createGatewaySession({
		userId: authResult.userId,
		organizationId: authResult.organizationId,
		projectId: authResult.projectId,
		userName: authResult.userName,
		email: authResult.email,
		role: authResult.role,
		credential: authResult.credential,
		scopes: authResult.scopes,
	});

	return { session, sessionId: session.sessionId, isNew: true };
}

// ─── JSON-RPC Helpers ───────────────────────────────────────────────────────

function jsonRpcSuccess(
	id: string | number | null,
	result: unknown,
	mcpSessionId: string,
): NextResponse {
	return NextResponse.json(
		{ jsonrpc: "2.0", id, result },
		{
			headers: {
				"Content-Type": "application/json",
				"Mcp-Session-Id": mcpSessionId,
			},
		},
	);
}

function jsonRpcError(
	id: string | number | null,
	code: number,
	message: string,
	mcpSessionId?: string,
): NextResponse {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (mcpSessionId) {
		headers["Mcp-Session-Id"] = mcpSessionId;
	}

	return NextResponse.json(
		{ jsonrpc: "2.0", id, error: { code, message } },
		{ headers },
	);
}

// ─── POST Handler ───────────────────────────────────────────────────────────

/**
 * Whether this gateway serves the named JSON-RPC method.
 *
 * Read together with the routing switch in `POST` — this is its complement, and
 * it exists so the connection record (Fizzy #2457, R2) is written on exactly
 * the calls this server understands, and not on a `Method not found`.
 */
function isServedMethod(method: string): boolean {
	switch (method) {
		case "initialize":
		case "notifications/initialized":
		case "tools/list":
		case "tools/call":
		case "ping":
			return true;
		default:
			return false;
	}
}

/**
 * Authenticate a gateway request, answering with the refusal itself when it
 * cannot proceed. Every method of the endpoint goes through here, so a session
 * is never read, ended or described for a caller who has not proven who they
 * are.
 */
async function authenticateGatewayRequest(
	request: NextRequest,
	binding: GatewayBinding | null,
): Promise<AuthResult | NextResponse> {
	// Authenticate. A refusal is answered before any session is looked up, so a
	// caller whose organization selection was denied cannot be served from the
	// session they opened before it.
	const authOutcome = await authenticateRequest(request, binding);
	if (authOutcome.status === "wrong_resource") {
		return NextResponse.json(
			{ error: authOutcome.message },
			{
				status: 401,
				headers: {
					"WWW-Authenticate": gatewayAuthenticateHeader(
						getBaseUrl(),
						{
							projectId: binding?.projectId,
							invalidToken: true,
						},
					),
				},
			},
		);
	}
	if (authOutcome.status === "refused") {
		// Never 401: the credentials were accepted, the tenancy was not, and
		// presenting the same key again unchanged will not help. Which of the
		// other two applies is the "can the caller fix this request?" split, and
		// it must match the hosted server's answer for the same reason — two
		// entry points disagreeing about the same refusal is the drift the
		// shared resolver exists to prevent.
		//
		//   ambiguous_organization -> 400: the request is underspecified. The
		//     caller names an organization on the header and it succeeds, which
		//     is the same shape as this route's other missing-header answers.
		//   not_a_member / no_membership -> 403: nothing about the request can
		//     be rewritten to make it allowed.
		//   project_not_accessible -> 403: at a project's URL, the project is
		//     missing, deleted or not the caller's to read, and which of the
		//     three is not said.
		//
		// `reason` is the machine-readable half, so a client can tell "name one
		// of yours" from "you have none to name" without matching on prose.
		return NextResponse.json(
			{ error: authOutcome.message, reason: authOutcome.reason },
			{
				status:
					authOutcome.reason === "ambiguous_organization" ? 400 : 403,
			},
		);
	}
	if (authOutcome.status === "unauthenticated") {
		// The challenge is what lets an MCP client offer "sign in" instead of
		// asking for a key: it names where the resource's metadata lives.
		return NextResponse.json(
			{
				error: "Unauthorized. Sign in from your agent, or provide a personal API key (Bearer fab_xxx), org API key (Bearer org_xxx), or session cookie.",
			},
			{
				status: 401,
				headers: {
					"WWW-Authenticate": gatewayAuthenticateHeader(
						getBaseUrl(),
						{
							projectId: binding?.projectId,
						},
					),
				},
			},
		);
	}
	const authResult = authOutcome.authResult;

	// A DEACTIVATED ORGANIZATION REFUSES EVERY REQUEST, AT EVERY DOOR.
	//
	// Deleting an organization deactivates it for its retention window before
	// anything is destroyed (Fizzy #2462), and that is enforced by refusing at
	// tenant resolution rather than by filtering the ~168 tables that hang off
	// it. `tenantContextMiddleware` does that for the application — but a tool
	// caller never passes through it, because this route resolves its own tenant
	// from an API key or a session. So the same gate has to exist here, or the
	// corridor is closed to people and open to their agents.
	//
	// Placed after the outcome rather than inside `authenticateRequest` because
	// every branch of that function ends here with a resolved organization:
	// personal key, organization key and session cookie alike. One check, one
	// place, no path that can be added later without crossing it.
	//
	// 403 and a machine-readable `reason`, matching this route's other tenancy
	// refusals: nothing about the request can be rewritten to make it allowed,
	// and a client should be able to tell this from "you are not a member"
	// without matching on prose.
	if (
		authResult.organizationId &&
		!(await isOrganizationLive(authResult.organizationId))
	) {
		return NextResponse.json(
			{
				error: `Organization ${authResult.organizationId} has been deleted. An owner can restore it from the workspace switcher until it is permanently removed.`,
				reason: "deleted_organization",
			},
			{ status: 403 },
		);
	}
	return authResult;
}

export async function handleGatewayPost(
	request: NextRequest,
	binding: GatewayBinding | null,
): Promise<NextResponse> {
	// Validate Origin
	if (!validateOrigin(request)) {
		return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	}

	// Validate Accept header
	const accept = request.headers.get("accept") || "";
	if (
		!accept.includes("application/json") &&
		!accept.includes("text/event-stream") &&
		!accept.includes("*/*")
	) {
		return NextResponse.json(
			{
				error: "Accept header must include application/json or text/event-stream",
			},
			{ status: 406 },
		);
	}

	const authResult = await authenticateGatewayRequest(request, binding);
	if (authResult instanceof NextResponse) {
		return authResult;
	}

	// Parse JSON-RPC request
	let rpcRequest: JsonRpcRequest;
	try {
		const body = await request.json();
		rpcRequest = body as JsonRpcRequest;
	} catch {
		return jsonRpcError(null, -32700, "Parse error");
	}

	if (rpcRequest.jsonrpc !== "2.0") {
		return jsonRpcError(
			rpcRequest.id ?? null,
			-32600,
			"Invalid JSON-RPC version",
		);
	}

	// Handle notifications (no id)
	if (rpcRequest.id === undefined || rpcRequest.id === null) {
		const mcpSessionId = request.headers.get("mcp-session-id") || "";
		return new NextResponse(null, {
			status: 202,
			headers: { "Mcp-Session-Id": mcpSessionId },
		});
	}

	// Get or create MCP session
	const incomingSessionId = request.headers.get("mcp-session-id");
	const { session, sessionId } = await getOrCreateSession(
		incomingSessionId,
		authResult,
	);

	// A method this gateway does not serve is refused before anything is
	// recorded: an unsupported call is not a CLI connection, however valid the
	// credential that carried it. The complement of the routing switch below,
	// which keeps its own `default:` as the closed answer.
	if (!isServedMethod(rpcRequest.method)) {
		return jsonRpcError(
			rpcRequest.id,
			-32601,
			`Method not found: ${rpcRequest.method}`,
			sessionId,
		);
	}

	// The credential matched, its owner was loaded, membership was re-read, and
	// the envelope is a well-formed call to a method this server serves. That is
	// a CLI reaching this organization (Fizzy #2457, R2), and the record is
	// written here rather than after the tool runs: deferring it to a successful
	// tool result would push it into the executor for no gain in truth. A
	// browser session carries no key identity and writes nothing.
	recordCliReach(authResult);

	// Route by method
	switch (rpcRequest.method) {
		case "initialize":
			return handleInitialize(
				rpcRequest.id,
				sessionId,
				clientNameOf(rpcRequest.params),
				session,
			);

		case "notifications/initialized":
			return new NextResponse(null, {
				status: 202,
				headers: { "Mcp-Session-Id": sessionId },
			});

		case "tools/list":
			return handleToolsList(rpcRequest.id, session, sessionId);

		case "tools/call":
			return handleToolsCall(
				rpcRequest.id,
				rpcRequest.params,
				session,
				sessionId,
			);

		case "ping":
			return jsonRpcSuccess(rpcRequest.id, {}, sessionId);

		// Unreachable — `isServedMethod` above refuses an unknown method before
		// the record is written — and kept as the closed answer, so this switch
		// gaining a case that the predicate does not list fails safe.
		default:
			return jsonRpcError(
				rpcRequest.id,
				-32601,
				`Method not found: ${rpcRequest.method}`,
				sessionId,
			);
	}
}

// ─── DELETE Handler ─────────────────────────────────────────────────────────

export async function handleGatewayDelete(
	request: NextRequest,
	binding: GatewayBinding | null,
): Promise<NextResponse> {
	const authResult = await authenticateGatewayRequest(request, binding);
	if (authResult instanceof NextResponse) {
		return authResult;
	}
	const mcpSessionId = request.headers.get("mcp-session-id");
	const existing = mcpSessionId ? getGatewaySession(mcpSessionId) : null;
	// Only the session's own user ends it, and only at the URL it was opened
	// at. Anything else is answered as if the session were already gone, so the
	// response does not say whether someone else's session id exists.
	if (
		mcpSessionId &&
		existing &&
		existing.userId === authResult.userId &&
		boundProjectId(existing) === (binding?.projectId ?? null)
	) {
		await releaseGatewaySession(mcpSessionId);
	}
	return new NextResponse(null, { status: 204 });
}

// ─── GET Handler (Health Check / Server Info) ───────────────────────────────

/**
 * Whether an `Accept` header asks for a server-sent event stream.
 *
 * A real parse rather than a substring test, because the three ways a
 * substring test goes wrong all matter here: media types are
 * case-insensitive, so `Text/Event-Stream` must count; `text/event-stream;q=0`
 * is a caller saying it will NOT take a stream and must not count; and an
 * unrelated subtype that happens to contain the string must not count either.
 * Only the exact media type, with a positive quality, selects the stream.
 * Wildcards (star-slash-star, `text/*`) deliberately do not: a browser sends a
 * wildcard with `q=0.8` on every navigation and is not asking for SSE.
 */
function acceptsEventStream(acceptHeader: string | null): boolean {
	if (!acceptHeader) {
		return false;
	}
	for (const range of acceptHeader.split(",")) {
		const [mediaType, ...params] = range.trim().split(";");
		if (mediaType.trim().toLowerCase() !== "text/event-stream") {
			continue;
		}
		// Name and value are parsed separately, tolerating whitespace around the
		// `=`, and the value must be a number in full: `Number("0junk")` is NaN
		// where `parseFloat` would have read it as 0. An absent, empty or
		// unparseable q counts as 1, per the documented rule above.
		let quality = 1;
		for (const param of params) {
			const eq = param.indexOf("=");
			if (eq === -1) {
				continue;
			}
			if (param.slice(0, eq).trim().toLowerCase() !== "q") {
				continue;
			}
			const value = param.slice(eq + 1).trim();
			const parsed = value === "" ? Number.NaN : Number(value);
			quality = Number.isNaN(parsed) ? 1 : parsed;
			break;
		}
		if (quality > 0) {
			return true;
		}
	}
	return false;
}

export async function handleGatewayGet(
	request: NextRequest,
	binding: GatewayBinding | null,
): Promise<NextResponse> {
	// A Streamable HTTP client opens `GET` with `Accept: text/event-stream` to
	// listen for server-initiated messages. This gateway has no such stream:
	// every response is a discrete JSON-RPC reply to a POST. The spec says a
	// server that offers no stream MUST answer that GET with 405, and official
	// SDK clients treat 405 as "no standalone stream here" and carry on.
	//
	// Answering it with the info page below instead looked harmless and was
	// not. A 200 with a JSON body reads to the client as a stream that closed
	// the instant it opened, so it reconnects, and keeps reconnecting, about
	// once a second for the life of the session. With a coding-agent client
	// configured against this endpoint on every developer machine, that loop
	// was the single largest source of requests to the whole deployment — a
	// couple of hundred thousand function invocations a day, none of which
	// ever authenticated or reached the database. The sibling `/mcp` route
	// refuses the same GET for the same reason.
	//
	// Plain GETs without the SSE accept header keep the info page as their
	// body, so a browser or a health check still sees it.
	if (acceptsEventStream(request.headers.get("accept"))) {
		return new NextResponse(null, {
			status: 405,
			headers: { Allow: "POST, DELETE" },
		});
	}

	const info = {
		name: GATEWAY_NAME,
		version: GATEWAY_VERSION,
		protocol: PROTOCOL_VERSION,
		description:
			"Fabric MCP Gateway — unified MCP endpoint aggregating platform tools and connected MCP servers. " +
			"Authenticate with API key (Authorization: Bearer fab_xxx) and send MCP JSON-RPC via POST.",
		endpoints: {
			POST: "JSON-RPC requests (initialize, tools/list, tools/call)",
			DELETE: "Terminate MCP session",
			GET: "This server info page (401 without credentials, 405 for Accept: text/event-stream — no standalone stream is offered)",
		},
		documentation: "https://docs.fabric.dev/mcp-gateway",
	};

	// A GET that carries no credentials is answered 401 with the challenge an
	// unauthenticated POST gets. An OAuth client discovers the server's sign-in
	// by probing its URL with a plain GET before anything else: a 200 reads as
	// "this URL is the resource's metadata document", so the info page above was
	// parsed as metadata and the sign-in failed for lack of a `resource` field,
	// while a 401 sends it to the `resource_metadata` the challenge names. The
	// body stays the info page, so a person who opens the URL still sees it.
	if (!request.headers.get("authorization")?.trim()) {
		return NextResponse.json(info, {
			status: 401,
			headers: {
				"WWW-Authenticate": gatewayAuthenticateHeader(getBaseUrl(), {
					projectId: binding?.projectId,
				}),
			},
		});
	}
	return NextResponse.json(info);
}

// ─── Method Handlers ────────────────────────────────────────────────────────

/**
 * The coding tools the setup offer is made to, by the name each announces in
 * `initialize`'s `clientInfo.name`, with the `--tool` value `init` takes for
 * it. Both names were read off the real clients' own initialize requests
 * (Claude Code 2.1.287 sends `claude-code`; the Codex CLI 0.156.1 sends
 * `codex-mcp-client`), not guessed.
 *
 * Every other client gets no offer. `init` writes a hook for Claude Code or
 * Codex and for nothing else, so an agent in VS Code or Cursor that ran it
 * would leave a hook no editor of theirs reads, and a client whose name is not
 * known here has not been seen announcing itself, so it is not offered one.
 */
const SETUP_OFFER_TOOLS: ReadonlyMap<string, "claude-code" | "codex"> = new Map(
	[
		["claude-code", "claude-code"],
		["codex-mcp-client", "codex"],
	],
);

/** `clientInfo.name` from an `initialize` request's params, when it is a string. */
function clientNameOf(
	params: Record<string, unknown> | undefined,
): string | undefined {
	const info = params?.clientInfo;
	return typeof info === "object" &&
		info !== null &&
		"name" in info &&
		typeof info.name === "string"
		? info.name
		: undefined;
}

/**
 * The handshake line that offers a checkout with no session hook one-line
 * setup (Fizzy #2878), or nothing.
 *
 * It names a command that only exists when this deployment serves its CLI, and
 * the tarball's name carries the build, so it is taken from the manifest
 * (`FABRIC_CLI_TARBALL`, set by `next.config.ts`) and never rebuilt from a
 * version. An unset or malformed value omits the line rather than offering a
 * command that does not resolve. The line names `--tool` for the client it is
 * written for, and `--base-url` when the CLI was not built for this
 * deployment's own address (`FABRIC_CLI_ORIGIN`).
 *
 * The agent OFFERS: running `init` writes the session hook and may fast-forward
 * the checkout, which is the developer's decision, and the agent never does
 * either by hand.
 *
 * A connection to one project names it, as `--project`, so `init` is not left
 * to find the project from the checkout's remote.
 */
function codingInstructionsSetupOffer(
	clientName: string | undefined,
	projectId: string | null,
): string {
	const tool =
		clientName === undefined
			? undefined
			: SETUP_OFFER_TOOLS.get(clientName);
	const tarball = process.env.FABRIC_CLI_TARBALL;
	if (tool === undefined || !tarball || !CLI_TARBALL_PATH.test(tarball)) {
		return "";
	}
	let deployment: string;
	try {
		deployment = new URL(getBaseUrl()).origin;
	} catch {
		return "";
	}
	const baseUrl =
		process.env.FABRIC_CLI_ORIGIN === deployment
			? ""
			: ` --base-url ${deployment}`;
	const project = projectId === null ? "" : ` --project ${projectId}`;
	return (
		"For uploaded instructions, if the developer wants a local installation with a session hook, offer to run " +
		`\`npx -y ${deployment}${tarball} instructions init --tool ${tool}${baseUrl}${project}\` in the checkout's top folder (or the folder inside it where the project's instructions live) and relay the one line it prints. ` +
		"Run it only if the developer agrees, and never run git or write hook files yourself.\n"
	);
}

const ORGANIZATION_INTRODUCTION =
	"Fabric MCP Gateway — your unified interface to Fabric platform tools and all connected MCP servers.\n\n" +
	"## Tool naming\n" +
	"- Platform tools: `fabric_*` (e.g., fabric_list_projects, fabric_get_document)\n" +
	"- Connected server tools: `{server}__{tool}` (e.g., linear__list_issues)\n\n" +
	"## Getting started\n" +
	"1. Call `fabric_get_identity` to see your current context\n" +
	"2. Call `fabric_list_connected_servers` to see available integrations\n\n";

/**
 * What a connection to one project is told about itself. Only the project's id
 * goes in. The name is whatever a collaborator last typed and these words are
 * guidance to the agent of someone else, so the name is left to be read as data,
 * from `fabric_get_project`, and never as part of the instructions.
 */
function projectIntroduction(projectId: string): string {
	return (
		`Fabric MCP Gateway — this connection is for the project ${projectId}, and reaches that project and nothing else in Fabric. Call \`fabric_get_project\` for its name and description.\n\n` +
		"## Tool naming\n" +
		"- Platform tools: `fabric_*` (e.g., fabric_get_project, fabric_get_document). Every one acts on this project: `projectId` is optional and defaults to it, and naming any other project is refused.\n" +
		"- Organization-wide tools and connected server tools are not available on this connection.\n\n"
	);
}

function codingInstructionsSection(
	clientName: string | undefined,
	projectId: string | null,
): string {
	return (
		"## Coding instructions\n" +
		"Projects provide coding instructions (skills, agents, rules, CLAUDE.md/AGENTS.md, settings, scripts, knowledge docs) through an attached repository or an uploaded version. " +
		"Project responses from fabric_get_project and fabric_list_projects carry a `codingInstructions` field. " +
		"When `codingInstructions.source` is `repository`, call fabric_list_project_instructions and fabric_get_project_instruction to read the attached repository directly. Carry the returned generation and commitSha through subsequent reads and pages so they all use one Git commit. fabric_get_project_instruction_bundle returns native checkout guidance, without a snapshot or archive. If the repository is unavailable, report that; never use a historical Fabric snapshot as a fallback.\n" +
		"For uploaded instructions, `codingInstructions.published:true` means an approved version is available. Use fabric_get_project_instruction_bundle to install it or the list/file tools to read selected files. Pass the last installed digest as sinceDigest to avoid an unchanged download. The optional fabric_instruction_checks report compares lockDigest and declared environment variable NAMES, never values.\n" +
		"Follow the instructions while working on the project. Read-only reports grant no authority to install software, change credentials, pull, reset or overwrite files.\n" +
		codingInstructionsSetupOffer(clientName, projectId) +
		"For repository instructions, edit and propose changes through native Git and the configured provider's pull requests, subject to the developer's authorization. Fabric shows the provider's history and open pull requests. For uploaded instructions, fabric_propose_project_instruction_change and fabric_add_instruction_lesson open proposals for a person to approve in Fabric; describe them as awaiting review.\n\n"
	);
}

const BOOTSTRAP_SECTION =
	"## Bootstrap a project\n" +
	"When the developer is working on a project that has little context (few or no results from `fabric_list_project_contexts`), offer to bootstrap it from their working tree.\n" +
	"1. Set the project's description with `fabric_update_project`\n" +
	"2. Push the README, architecture notes, design rules and team conventions with `fabric_upsert_project_context`, one call per file, using the file's repo-relative path as `sourcePath` so a later push of the same file updates it rather than adding a duplicate\n" +
	"3. Before replacing a file that is already there, read its `contentHash` with fabric_get_project_context or fabric_list_project_contexts and pass it as `expectedContentHash`; a `conflict` means someone else changed it, so read it again and merge rather than overwrite\n" +
	"Keep coding-instruction files (CLAUDE.md, AGENTS.md, .claude/, skills, agents, hooks, rules, scripts) out of it. Propose uploaded instruction changes with `fabric_propose_project_instruction_change`; repository instruction changes belong in native Git and provider pull requests. " +
	"Never push secrets, `.env` files or generated output, and tell the developer what you pushed.\n\n";

const AUTHORITY_SECTION =
	"## Runtime authority (required for connected server tools)\n" +
	"Connected server tools require runtime authority before use. Platform tools (fabric_*) are always available.\n" +
	"1. Call `fabric_request_authority` with the providers and access levels you need\n" +
	"2. The user must approve in the Fabric UI (approval is human-only)\n" +
	"3. Call `fabric_check_authority` to see when approval is granted\n" +
	"4. Once approved, connected server tools become callable for the session duration\n" +
	"5. Authority expires automatically or can be revoked with `fabric_revoke_authority`\n\n" +
	"Tools in the tools/list response include `_meta.requiresAuthority` and `_meta.authorityStatus` " +
	"to indicate which tools need authority and whether it's currently granted.";

/**
 * The handshake's `instructions`: the organization-wide gateway's text as it
 * always was, or a project connection's, which says which project it is for and
 * leaves out what a connection to one project does not have.
 */
function gatewayInstructions(
	clientName: string | undefined,
	session: GatewaySession,
): string {
	const projectId = boundProjectId(session);
	if (projectId === null) {
		return (
			ORGANIZATION_INTRODUCTION +
			codingInstructionsSection(clientName, null) +
			BOOTSTRAP_SECTION +
			AUTHORITY_SECTION
		);
	}
	return (
		projectIntroduction(projectId) +
		codingInstructionsSection(clientName, projectId) +
		BOOTSTRAP_SECTION
	);
}

async function handleInitialize(
	id: string | number,
	sessionId: string,
	clientName: string | undefined,
	session: GatewaySession,
): Promise<NextResponse> {
	return jsonRpcSuccess(
		id,
		{
			protocolVersion: PROTOCOL_VERSION,
			serverInfo: {
				name: GATEWAY_NAME,
				version: GATEWAY_VERSION,
			},
			capabilities: {
				tools: { listChanged: true },
			},
			instructions: gatewayInstructions(clientName, session),
		},
		sessionId,
	);
}

async function handleToolsList(
	id: string | number,
	session: GatewaySession,
	sessionId: string,
): Promise<NextResponse> {
	try {
		const { tools, servers } = await getAggregatedTools(session);

		// Check which providers currently have active authority grants
		const authorizedProviders = new Set<string>();
		try {
			const { getActiveAuthoritySessionForRun } = await import(
				"@repo/database"
			);
			const activeAuth = await getActiveAuthoritySessionForRun(
				"MCP_GATEWAY",
				sessionId,
				session.userId,
				session.organizationId || undefined,
			);
			if (activeAuth) {
				for (const grant of activeAuth.grants) {
					if (grant.status === "APPROVED") {
						authorizedProviders.add(grant.providerKey);
					}
				}
			}
		} catch {
			// Best-effort — don't block tools/list if authority check fails
		}

		// Return in MCP format with authority metadata for connected tools
		const mcpTools = tools.map((t) => {
			const base = {
				name: t.name,
				description: t.description,
				inputSchema: t.inputSchema,
				...(t.annotations ? { annotations: t.annotations } : {}),
			};

			// Add authority metadata for connected server tools
			if (t._gateway_source && t._gateway_source !== "platform") {
				const prefix = t.name.split("__")[0];
				const serverInfo = servers.find((s) => s.toolPrefix === prefix);
				const providerKey = serverInfo
					? (resolveProviderKeyFromToolPrefix(prefix, servers)
							?.providerKey ?? `custom:${prefix}`)
					: `custom:${prefix}`;
				const isAuthorized = authorizedProviders.has(providerKey);

				return {
					...base,
					_meta: {
						requiresAuthority: true,
						authorityStatus: isAuthorized ? "granted" : "missing",
						providerKey,
					},
				};
			}

			return base;
		});

		return jsonRpcSuccess(id, { tools: mcpTools }, sessionId);
	} catch (error) {
		console.error("[MCP Gateway] tools/list error:", error);
		return jsonRpcError(id, -32603, "Failed to list tools", sessionId);
	}
}

async function handleToolsCall(
	id: string | number,
	params: Record<string, unknown> | undefined,
	session: GatewaySession,
	sessionId: string,
): Promise<NextResponse> {
	const toolName = params?.name as string;
	const toolArgs = (params?.arguments || {}) as Record<string, unknown>;

	if (!toolName) {
		return jsonRpcError(id, -32602, "Missing tool name", sessionId);
	}

	try {
		let result: {
			content: Array<{ type: string; text: string }>;
			isError?: boolean;
		};

		if (toolName.startsWith("fabric_")) {
			// Platform tool
			result = await executePlatformTool(toolName, toolArgs, session);

			// Handle org switch — persist to session store
			if (toolName === "fabric_switch_organization" && !result.isError) {
				updateSessionOrganization(sessionId, session.organizationId);
			}
		} else if (boundProjectId(session) !== null) {
			// A connection to one project has the project's platform tools and
			// nothing else: a connected server is the person's and the
			// organization's, with no project to be held to.
			result = {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({
							error: `${toolName} is not available on a connection to one project.`,
							hint: "Platform tools start with 'fabric_'.",
						}),
					},
				],
				isError: true,
			};
		} else if (toolName.includes("__")) {
			// Connected server tool (namespaced) — enforce authority gate
			const { tools, servers } = await getAggregatedTools(session);

			// Resolve provider key from tool prefix
			const separatorIndex = toolName.indexOf("__");
			const prefix = toolName.slice(0, separatorIndex);
			const providerInfo = resolveProviderKeyFromToolPrefix(
				prefix,
				servers,
			);
			const providerKey = providerInfo?.providerKey ?? `custom:${prefix}`;

			// Find tool annotations from aggregated tools
			const toolDef = tools.find((t) => t.name === toolName);
			const annotations = toolDef?.annotations as
				| {
						readOnlyHint?: boolean;
						destructiveHint?: boolean;
				  }
				| undefined;

			// The credential's own scopes come first: a connected tool is read
			// or write by the same classification the authority gate uses, and
			// the key or sign-in must hold the matching scope before a runtime
			// grant is even considered. An OAuth agent cannot hold `mcp:write`.
			const requiredScope =
				classifyConnectedToolAccess(
					toolName,
					annotations,
					session.credential,
				) === "READ"
					? ({ scope: "mcp:read", kind: "read" } as const)
					: ({ scope: "mcp:write", kind: "write" } as const);
			if (
				!scopeSatisfied(
					session.scopes,
					requiredScope,
					session.credential,
				)
			) {
				return jsonRpcSuccess(
					id,
					{
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									error: `This ${session.credential === "oauth" ? "signed-in agent" : "API key"} does not have the "${requiredScope.scope}" scope required by ${toolName}.`,
								}),
							},
						],
						isError: true,
					},
					sessionId,
				);
			}

			// Generate request fingerprint for one-shot grant matching
			const fingerprint = await generateRequestFingerprint(
				toolName,
				toolArgs,
			);

			// Look up the authority session bound to this specific gateway session.
			// If no session exists for this exact runId, the check will correctly deny —
			// we pass boundRunId to ensure strict per-session binding.
			const authorityResult = await enforceAuthority({
				toolName,
				providerKey,
				session,
				annotations,
				requestFingerprint: fingerprint,
				boundRunType: "MCP_GATEWAY",
				boundRunId: sessionId, // Strict: only grants from THIS gateway session
			});

			if (!authorityResult.authorized) {
				result = {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								error: "Authority required",
								reason: authorityResult.reason,
								action: authorityResult.action,
								pendingSessionId:
									authorityResult.pendingSessionId,
								hint:
									authorityResult.action ===
									"request_authority"
										? `Use fabric_request_authority to request access for provider "${providerKey}".`
										: authorityResult.action ===
												"approve_pending"
											? `A pending authority request (session ${authorityResult.pendingSessionId}) needs approval in the Fabric UI.`
											: `Current authority level is insufficient. Request WRITE access for "${providerKey}".`,
								providerKey,
							}),
						},
					],
					isError: true,
				};
			} else {
				// Authority granted — execute the tool
				result = await executeConnectedServerTool(
					toolName,
					toolArgs,
					session,
					servers,
				);

				// If the grant was a one-shot REQUEST, consume it
				if (
					authorityResult.grant?.kind === "REQUEST" &&
					authorityResult.grant?.id
				) {
					const { consumeRequestGrant } = await import(
						"@repo/database"
					);
					consumeRequestGrant(authorityResult.grant.id).catch(
						() => {},
					);
				}
			}
		} else {
			result = {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({
							error: `Unknown tool: ${toolName}`,
							hint: "Platform tools start with 'fabric_'. Connected server tools use 'servername__toolname' format.",
						}),
					},
				],
				isError: true,
			};
		}

		return jsonRpcSuccess(id, result, sessionId);
	} catch (error) {
		console.error("[MCP Gateway] tools/call error:", { toolName }, error);

		return jsonRpcSuccess(
			id,
			{
				content: [
					{
						type: "text",
						text: JSON.stringify({
							error: "Tool execution failed because of an internal error.",
						}),
					},
				],
				isError: true,
			},
			sessionId,
		);
	}
}
