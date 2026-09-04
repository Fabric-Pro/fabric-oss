/**
 * Fabric MCP Gateway - Streamable HTTP Transport
 *
 * Unified MCP endpoint that exposes ALL Fabric capabilities and connected
 * MCP server tools through a single URL. Works with any MCP client:
 * Claude Desktop, Cursor, VS Code, Windsurf, or custom implementations.
 *
 * Authentication:
 *   - API Key: `Authorization: Bearer fab_xxx` (recommended for external clients)
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

import { createHash } from "node:crypto";
import { verifyUserApiKey } from "@repo/api/modules/users/procedures/api-keys";
import { auth } from "@repo/auth";
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
	enforceAuthority,
	generateRequestFingerprint,
	resolveProviderKeyFromToolPrefix,
} from "@saas/mcp/lib/gateway/authority-service";
import type { GatewayCredential } from "@saas/mcp/lib/gateway/types";
import { recordOrganizationRefusal } from "@saas/mcp/lib/record-organization-refusal";
import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

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
			status: "refused";
			reason: "not_a_member" | "ambiguous_organization" | "no_membership";
			message: string;
	  };

const UNAUTHENTICATED: AuthOutcome = { status: "unauthenticated" };

function authenticatedAs(authResult: AuthResult): AuthOutcome {
	return { status: "authenticated", authResult };
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
 */
async function authenticateRequest(request: NextRequest): Promise<AuthOutcome> {
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

		const identity = {
			userId: result.userId,
			userName: user.name || "Unknown",
			email: user.email,
			role: (user.role as "user" | "admin") || "user",
			credential: "personal-key" as const,
			scopes: result.scopes ?? [],
		};

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

		const keyHash = createHash("sha256").update(apiKey).digest("hex");
		if (keyHash !== storedKey.keyHash) {
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

		return authenticatedAs({
			userId: storedKey.createdByUserId,
			organizationId: storedKey.organizationId,
			userName: user.name || "Unknown",
			email: user.email,
			role: (user.role as "user" | "admin") || "user",
			credential: "organization-key",
			scopes: storedKey.scopes,
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

/**
 * Return the session this request runs in.
 *
 * A stored session is reused only while it still names the organization this
 * request resolved to. Sessions live twenty-four hours, so reusing one on user
 * identity alone let the tenancy decision taken when it was created outlive
 * every later re-evaluation of it, and a per-request resolution a day-old
 * session can ignore is not a resolution at all (R6c). A session created before
 * this route resolved organizations carries a null organization, never matches
 * a resolved one, and is released on its owner's next request.
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
			if (existing.organizationId === authResult.organizationId) {
				return {
					session: existing,
					sessionId: mcpSessionId,
					isNew: false,
				};
			}

			// This caller's own session no longer names the organization they
			// resolve to, so it is released rather than left for a later
			// request to pick up. Only ever their own: a session id quoted by
			// a different user is left alone on this path.
			await releaseGatewaySession(mcpSessionId);
		}
	}

	// Create new session
	const session = await createGatewaySession({
		userId: authResult.userId,
		organizationId: authResult.organizationId,
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

export async function POST(request: NextRequest): Promise<NextResponse> {
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

	// Authenticate. A refusal is answered before any session is looked up, so a
	// caller whose organization selection was denied cannot be served from the
	// session they opened before it.
	const authOutcome = await authenticateRequest(request);
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
		return NextResponse.json(
			{
				error: "Unauthorized. Provide a personal API key (Bearer fab_xxx), org API key (Bearer org_xxx), or session cookie.",
			},
			{ status: 401 },
		);
	}
	const authResult = authOutcome.authResult;

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

	// Route by method
	switch (rpcRequest.method) {
		case "initialize":
			return handleInitialize(rpcRequest.id, sessionId);

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

export async function DELETE(request: NextRequest): Promise<NextResponse> {
	const mcpSessionId = request.headers.get("mcp-session-id");
	if (mcpSessionId) {
		// Complete any active authority sessions tied to this gateway session
		// This ensures authority doesn't outlive the transport session
		try {
			const { db } = await import("@repo/database");
			const { completeAuthoritySession } = await import("@repo/database");
			const gatewaySession = getGatewaySession(mcpSessionId);
			if (gatewaySession) {
				const orgFilter = gatewaySession.organizationId
					? { organizationId: gatewaySession.organizationId }
					: { organizationId: null };
				const activeSessions = await db.authoritySession.findMany({
					where: {
						userId: gatewaySession.userId,
						...orgFilter,
						runType: "MCP_GATEWAY",
						status: "ACTIVE",
					},
					select: { id: true },
				});
				for (const s of activeSessions) {
					completeAuthoritySession(s.id).catch(() => {});
				}
			}
		} catch {
			// Best-effort cleanup
		}
		deleteGatewaySession(mcpSessionId);
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

export async function GET(request: NextRequest): Promise<NextResponse> {
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
	// Plain GETs without the SSE accept header keep the info page, so a
	// browser or a health check sees what it always did.
	if (acceptsEventStream(request.headers.get("accept"))) {
		return new NextResponse(null, {
			status: 405,
			headers: { Allow: "POST, DELETE" },
		});
	}

	return NextResponse.json({
		name: GATEWAY_NAME,
		version: GATEWAY_VERSION,
		protocol: PROTOCOL_VERSION,
		description:
			"Fabric MCP Gateway — unified MCP endpoint aggregating platform tools and connected MCP servers. " +
			"Authenticate with API key (Authorization: Bearer fab_xxx) and send MCP JSON-RPC via POST.",
		endpoints: {
			POST: "JSON-RPC requests (initialize, tools/list, tools/call)",
			DELETE: "Terminate MCP session",
			GET: "This server info page (405 for Accept: text/event-stream — no standalone stream is offered)",
		},
		documentation: "https://docs.fabric.dev/mcp-gateway",
	});
}

// ─── Method Handlers ────────────────────────────────────────────────────────

function handleInitialize(
	id: string | number,
	sessionId: string,
): NextResponse {
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
			instructions:
				"Fabric MCP Gateway — your unified interface to Fabric platform tools and all connected MCP servers.\n\n" +
				"## Tool naming\n" +
				"- Platform tools: `fabric_*` (e.g., fabric_list_projects, fabric_get_document)\n" +
				"- Connected server tools: `{server}__{tool}` (e.g., linear__list_issues)\n\n" +
				"## Getting started\n" +
				"1. Call `fabric_get_identity` to see your current context\n" +
				"2. Call `fabric_list_connected_servers` to see available integrations\n\n" +
				"## Runtime authority (required for connected server tools)\n" +
				"Connected server tools require runtime authority before use. Platform tools (fabric_*) are always available.\n" +
				"1. Call `fabric_request_authority` with the providers and access levels you need\n" +
				"2. The user must approve in the Fabric UI (approval is human-only)\n" +
				"3. Call `fabric_check_authority` to see when approval is granted\n" +
				"4. Once approved, connected server tools become callable for the session duration\n" +
				"5. Authority expires automatically or can be revoked with `fabric_revoke_authority`\n\n" +
				"Tools in the tools/list response include `_meta.requiresAuthority` and `_meta.authorityStatus` " +
				"to indicate which tools need authority and whether it's currently granted.",
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
		const message =
			error instanceof Error ? error.message : "Tool execution failed";
		console.error("[MCP Gateway] tools/call error:", { toolName }, error);

		return jsonRpcSuccess(
			id,
			{
				content: [
					{ type: "text", text: JSON.stringify({ error: message }) },
				],
				isError: true,
			},
			sessionId,
		);
	}
}
