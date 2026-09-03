/**
 * Browser Session Manager
 *
 * Manages Playwright browser sessions with multi-tenant isolation.
 * Each session is isolated by userId + organizationId for security.
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
 * Get an existing session.
 *
 * Isolation here rests entirely on the session id: the activity inputs that
 * reach this function (navigate, action, extract, screenshot, authenticate)
 * carry no caller identity to compare against `session.userId`, so the id has
 * to be treated as a bearer token — hence the CSPRNG id above. Adding a real
 * owner check means threading userId/organizationId through those input types
 * and their workflow call sites.
 */
export function getSession(sessionId: string): BrowserSession | undefined {
	const session = sessions.get(sessionId);
	if (session) {
		session.lastActivityAt = new Date();
	}
	return session;
}

/**
 * Close and cleanup a session
 */
export async function closeSession(sessionId: string): Promise<void> {
	const session = sessions.get(sessionId);
	if (!session) {
		console.warn(
			`[BrowserSession] Session ${sessionId} not found for cleanup`,
		);
		return;
	}

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
 * Get session storage state (cookies, localStorage)
 */
export async function getStorageState(
	sessionId: string,
): Promise<Awaited<ReturnType<BrowserContext["storageState"]>> | null> {
	const session = getSession(sessionId);
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
			await closeSession(sessionId);
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
	for (const sessionId of sessions.keys()) {
		await closeSession(sessionId);
	}
}
