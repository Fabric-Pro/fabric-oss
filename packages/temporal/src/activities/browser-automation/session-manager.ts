/**
 * Browser Session Manager
 *
 * Manages Playwright browser sessions with multi-tenant isolation.
 * Each session records the userId + organizationId it was created for, and
 * every lookup that reaches a live browser (`getSession`, `closeSession`,
 * `getStorageState`) verifies that owner against the calling activity's
 * identity — see `resolveOwnedSession` below for why the comparison is
 * per-user rather than per-organization.
 */

import { randomUUID } from "node:crypto";
import type { Browser, BrowserContext, Page } from "playwright";
import type { BrowserSessionOptions } from "./types";

// =============================================================================
// Session Store
// =============================================================================

interface BrowserSession {
	id: string;
	userId: string;
	organizationId?: string;
	browser: Browser;
	context: BrowserContext;
	page: Page;
	createdAt: Date;
	lastActivityAt: Date;
	options: BrowserSessionOptions;
}

// In-memory session store (for single worker process)
// For multi-worker deployment, consider Redis-based session store
const sessions = new Map<string, BrowserSession>();

// Session timeout cleanup interval
const SESSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
let cleanupInterval: NodeJS.Timeout | null = null;

// =============================================================================
// Session Manager Functions
// =============================================================================

/** The tenant a session id is minted for. */
function sessionScope(userId: string, organizationId?: string): string {
	return organizationId ? `org:${organizationId}` : `user:${userId}`;
}

/**
 * Normalize an organization for comparison, the way `sessionScope` does.
 *
 * `undefined`, `null` and `""` all mean "no organization" on the way in, so a
 * caller that passes `""` where the session recorded `undefined` (or the other
 * way round) must not be rejected — that would be a falsy-vs-undefined bug, not
 * a tenant mismatch.
 */
function normalizeOrganizationId(
	organizationId?: string | null,
): string | undefined {
	return organizationId || undefined;
}

/**
 * Resolve a session and verify the caller owns it.
 *
 * The ownership test compares `userId` **and** the organization separately,
 * never the collapsed `sessionScope()` string: that helper deliberately folds
 * to `org:<id>` whenever an organization is present, so comparing scopes would
 * let any colleague in the same organization drive another person's live
 * browser. A browser session holds live authenticated third-party cookies (see
 * the `authenticate` activity), which is per-user state — so the check is
 * per-user even inside an organization.
 *
 * A mismatch returns `undefined`, exactly as a missing session does. A distinct
 * error would be an existence oracle: it would tell a caller that some other
 * tenant's session id is real. The mismatch is logged instead, so it surfaces
 * as a security event in the worker logs.
 */
function resolveOwnedSession(
	sessionId: string,
	userId: string,
	organizationId: string | undefined,
	operation: string,
): BrowserSession | undefined {
	const session = sessions.get(sessionId);
	if (!session) {
		return undefined;
	}

	const ownsSession =
		session.userId === userId &&
		normalizeOrganizationId(session.organizationId) ===
			normalizeOrganizationId(organizationId);

	if (!ownsSession) {
		console.error(
			`[BrowserSession] Ownership check failed on ${operation} for session ${sessionId}: requested by user ${userId}`,
		);
		return undefined;
	}

	return session;
}

/**
 * Generate unique session ID scoped to tenant.
 *
 * The id is the only thing standing between one tenant's live browser session
 * and another caller that names it, so its random part must be unguessable:
 * `Math.random()` is neither uniformly distributed nor unpredictable (V8's
 * xorshift state can be recovered from a handful of outputs), and the rest of
 * the id — the scope and a millisecond timestamp — carries little entropy of
 * its own. `randomUUID()` is CSPRNG-backed; the hyphens are stripped so the
 * shape of the id (four `_`-separated parts, lowercase alphanumeric tail) is
 * unchanged.
 *
 * Guards js/insecure-randomness.
 */
export function generateSessionId(
	userId: string,
	organizationId?: string,
): string {
	const scope = sessionScope(userId, organizationId);
	const timestamp = Date.now();
	const random = randomUUID().replace(/-/g, "");
	return `browser_${scope}_${timestamp}_${random}`;
}

/**
 * Create a new browser session
 */
export async function createSession(
	sessionId: string,
	userId: string,
	organizationId: string | undefined,
	options: BrowserSessionOptions = {},
): Promise<BrowserSession> {
	// The session id is registered as-is, and every later lookup is by id alone,
	// so an id minted for one tenant must never be registered against another's
	// browser: refuse anything that does not carry this owner's scope.
	if (
		!sessionId.startsWith(
			`browser_${sessionScope(userId, organizationId)}_`,
		)
	) {
		throw new Error(
			"Browser session id does not match the requesting tenant.",
		);
	}

	// Dynamically import Playwright to avoid bundling issues
	const { chromium } = await import("playwright");

	const browser = await chromium.launch({
		headless: options.headless ?? true,
	});

	const viewport = options.viewport
		? {
				width: options.viewport.width ?? 1920,
				height: options.viewport.height ?? 1080,
			}
		: { width: 1920, height: 1080 };

	const contextOptions: Parameters<Browser["newContext"]>[0] = {
		viewport,
		userAgent: options.userAgent,
	};

	const context = await browser.newContext(contextOptions);

	// Block unwanted resources if specified
	if (options.blockResources?.length) {
		await context.route("**/*", (route) => {
			const resourceType = route.request().resourceType();
			if (options.blockResources?.includes(resourceType as any)) {
				return route.abort();
			}
			return route.continue();
		});
	}

	const page = await context.newPage();

	// Set default timeout
	page.setDefaultTimeout(options.timeout || 30000);

	const session: BrowserSession = {
		id: sessionId,
		userId,
		organizationId,
		browser,
		context,
		page,
		createdAt: new Date(),
		lastActivityAt: new Date(),
		options,
	};

	sessions.set(sessionId, session);

	// Start cleanup interval if not running
	startCleanupInterval();

	console.log(
		`[BrowserSession] Created session ${sessionId} for user ${userId}`,
	);

	return session;
}

/**
 * Get an existing session, for the caller that owns it.
 *
 * The activity inputs that reach this function (navigate, action, extract,
 * screenshot, authenticate) each carry the calling user's identity, and the
 * session is only returned when that identity matches the one it was created
 * for. The unguessable CSPRNG id above is still the first line of defence, but
 * it is no longer the only one: naming a session id is not enough to drive it.
 *
 * The match is per-**user**, not per-organization, even for a session created
 * inside an organization: the session's browser context holds live
 * authenticated third-party cookies belonging to one person. A colleague in
 * the same organization gets `undefined` here, the same value a caller naming
 * a session that does not exist gets.
 */
export function getSession(
	sessionId: string,
	userId: string,
	organizationId?: string,
): BrowserSession | undefined {
	const session = resolveOwnedSession(
		sessionId,
		userId,
		organizationId,
		"getSession",
	);
	if (session) {
		session.lastActivityAt = new Date();
	}
	return session;
}

/**
 * Close and cleanup a session, for the caller that owns it.
 *
 * Closing is a mutation, so a missing owner check here would be a cross-tenant
 * denial of service — anyone naming a session id could kill another person's
 * running automation. A non-owner is treated exactly like a caller naming a
 * session that does not exist: nothing is closed.
 */
export async function closeSession(
	sessionId: string,
	userId: string,
	organizationId?: string,
): Promise<void> {
	const session = resolveOwnedSession(
		sessionId,
		userId,
		organizationId,
		"closeSession",
	);
	if (!session) {
		console.warn(
			`[BrowserSession] Session ${sessionId} not found for cleanup`,
		);
		return;
	}

	await closeSessionUnchecked(sessionId, session);
}

/**
 * Close a session without an owner check.
 *
 * Internal lifecycle only — worker shutdown and the expiry sweep, neither of
 * which acts on behalf of a caller.
 *
 * Its two callers, `cleanupExpiredSessions` and `closeAllSessions`, must stay
 * unreachable from an activity: `./index.ts` deliberately does not re-export
 * them, because that barrel is registered wholesale as the worker's activity
 * map and an exported `closeAllSessions` would be a schedulable cross-tenant
 * kill switch. Import them from this module directly, never through the barrel.
 */
async function closeSessionUnchecked(
	sessionId: string,
	session: BrowserSession,
): Promise<void> {
	try {
		await session.page.close();
		await session.context.close();
		await session.browser.close();
	} catch (error) {
		console.error(
			`[BrowserSession] Error closing session ${sessionId}:`,
			error,
		);
	} finally {
		sessions.delete(sessionId);
		console.log(`[BrowserSession] Closed session ${sessionId}`);
	}
}

/**
 * Get session storage state (cookies, localStorage), for the caller that owns
 * the session.
 *
 * This is the worst thing in the module to hand to the wrong caller — it is the
 * session's authenticated cookies and localStorage in plain form — so a
 * non-owner gets `null`, the same value a missing session yields.
 */
export async function getStorageState(
	sessionId: string,
	userId: string,
	organizationId?: string,
): Promise<Awaited<ReturnType<BrowserContext["storageState"]>> | null> {
	const session = getSession(sessionId, userId, organizationId);
	if (!session) {
		return null;
	}

	return session.context.storageState();
}

/**
 * Cleanup expired sessions
 */
async function cleanupExpiredSessions(): Promise<void> {
	const now = Date.now();

	for (const [sessionId, session] of sessions.entries()) {
		const sessionAge = now - session.lastActivityAt.getTime();
		const maxAge = session.options.timeout || SESSION_TIMEOUT_MS;

		if (sessionAge > maxAge) {
			console.log(
				`[BrowserSession] Cleaning up expired session ${sessionId}`,
			);
			await closeSessionUnchecked(sessionId, session);
		}
	}

	// Stop cleanup interval if no sessions
	if (sessions.size === 0 && cleanupInterval) {
		clearInterval(cleanupInterval);
		cleanupInterval = null;
	}
}

function startCleanupInterval(): void {
	if (!cleanupInterval) {
		cleanupInterval = setInterval(cleanupExpiredSessions, 60000); // Check every minute
	}
}

/**
 * Get session count (for monitoring)
 */
export function getSessionCount(): number {
	return sessions.size;
}

/**
 * Close all sessions (for graceful shutdown)
 */
export async function closeAllSessions(): Promise<void> {
	console.log(`[BrowserSession] Closing all ${sessions.size} sessions`);
	for (const [sessionId, session] of sessions.entries()) {
		await closeSessionUnchecked(sessionId, session);
	}
}
