/**
 * Document-assistant history E2E fixtures.
 *
 * Seeds + tears down `DocumentAssistantConversation` rows via the live oRPC
 * API (no direct DB access from the Playwright process for the main seed
 * path — matches the pattern in `apps/web/tests/e2e/settings/ai-usage-limits.spec.ts`).
 * The same auth cookie the test uses to drive the browser is reused for the
 * API calls via `playwright.request`.
 *
 * A separate `getDirectPrismaClient()` helper exists for cascade-assertion
 * specs (I.6, I.9) that need to verify post-condition DB state. It is
 * gated on `TEST_DATABASE_URL` so it never accidentally fires in CI.
 *
 * Env vars (split by use case):
 *
 *   Single-user seed (D.5/D.6, I.2, I.5, I.6, I.7):
 *     TEST_PERSONAL_PROJECT_ID    — project the test user owns
 *     TEST_PERSONAL_DOCUMENT_ID   — document inside that project
 *     (or)
 *     TEST_ORG_SLUG               — org slug
 *     TEST_ORG_PROJECT_ID         — org project id
 *     TEST_ORG_DOCUMENT_ID        — org document id
 *     TEST_ORG_ID                 — org id (uuid)
 *
 *   Two-user seed (I.3, I.4, I.8 — reuses the document-mentions helper):
 *     E2E_USER_A_EMAIL / E2E_USER_A_PASSWORD
 *     E2E_USER_B_EMAIL / E2E_USER_B_PASSWORD
 *     E2E_ORG_SLUG     (optional, default "default-org")
 *
 *   Direct DB assertions (I.6 cascade, I.9 schema check):
 *     TEST_DATABASE_URL  — required only for the specs that import
 *                          `getDirectPrismaClient()`. Other specs do not
 *                          read this var and ignore its absence.
 *
 *   Slow-suite gate (I.7 — needs 50 round-trips to fill the cap):
 *     TEST_RUN_SLOW_SPECS=true
 *
 * Spec: 2026-05-19-ai-assistant-document-chat-history §3.2 FR-7 / AC-6 / AC-7.
 */

import type { APIRequestContext } from "@playwright/test";

export const HYDRATION_TURN_COUNT = 200;

export type SeedScope =
	| {
			kind: "personal";
			projectId: string;
			documentId: string;
			documentRefKind: "PROJECT_DOCUMENT" | "USER_STORY";
	  }
	| {
			kind: "org";
			organizationId: string;
			organizationSlug: string;
			projectId: string;
			documentId: string;
			documentRefKind: "PROJECT_DOCUMENT" | "USER_STORY";
	  };

export interface SeedConfig {
	personal?: {
		projectId?: string;
		documentId?: string;
	};
	org?: {
		slug?: string;
		id?: string;
		projectId?: string;
		documentId?: string;
	};
}

export function readSeedConfig(): SeedConfig {
	return {
		personal: {
			projectId: process.env.TEST_PERSONAL_PROJECT_ID,
			documentId: process.env.TEST_PERSONAL_DOCUMENT_ID,
		},
		org: {
			slug: process.env.TEST_ORG_SLUG,
			id: process.env.TEST_ORG_ID,
			projectId: process.env.TEST_ORG_PROJECT_ID,
			documentId: process.env.TEST_ORG_DOCUMENT_ID,
		},
	};
}

export function resolveScope(cfg: SeedConfig): SeedScope | null {
	// Prefer the org scope when fully configured — it exercises the tenant
	// XOR path which is the higher-risk surface.
	if (
		cfg.org?.id &&
		cfg.org.slug &&
		cfg.org.projectId &&
		cfg.org.documentId
	) {
		return {
			kind: "org",
			organizationId: cfg.org.id,
			organizationSlug: cfg.org.slug,
			projectId: cfg.org.projectId,
			documentId: cfg.org.documentId,
			documentRefKind: "PROJECT_DOCUMENT",
		};
	}
	if (cfg.personal?.projectId && cfg.personal.documentId) {
		return {
			kind: "personal",
			projectId: cfg.personal.projectId,
			documentId: cfg.personal.documentId,
			documentRefKind: "PROJECT_DOCUMENT",
		};
	}
	return null;
}

/**
 * Convert a SeedScope to the `getActiveForDocument` / `appendTurnForDocument`
 * input shape. Personal context MUST send `organizationId: null` explicitly.
 */
function refInput(scope: SeedScope) {
	return {
		documentRefKind: scope.documentRefKind,
		documentRefId: scope.documentId,
		projectId: scope.projectId,
		organizationId: scope.kind === "org" ? scope.organizationId : null,
	};
}

/**
 * Build a synthetic message body that mimics the persisted shape produced
 * by `appendTurnForDocument` (see `MessageSchema` in
 * `packages/api/modules/agents/procedures/conversations/update-conversation.ts`).
 */
function buildTurn(opts: { index: number; role: "user" | "assistant" }): {
	id: string;
	role: "user" | "assistant";
	content: string;
	timestamp: string;
} {
	return {
		id: `e2e-hydration-${opts.role}-${opts.index}-${Date.now()}`,
		role: opts.role,
		content:
			opts.role === "user"
				? `[e2e hydration seed] user turn #${opts.index}`
				: `[e2e hydration seed] assistant reply #${opts.index}`,
		timestamp: new Date(
			Date.now() - (200 - opts.index) * 1000,
		).toISOString(),
	};
}

/** Read the active conversation via the oRPC REST endpoint. */
export async function getActiveConversation(
	request: APIRequestContext,
	scope: SeedScope,
): Promise<{
	conversationId: string | null;
	messageCount: number;
} | null> {
	const resp = await request.post(
		"/api/rpc/agents/conversations/getActiveForDocument",
		{
			headers: { "Content-Type": "application/json" },
			data: { json: refInput(scope) },
		},
	);
	if (!resp.ok()) {
		return null;
	}
	const body = (await resp.json()) as {
		json?: {
			conversation: {
				conversationId: string;
				messages: unknown[];
			} | null;
		};
	};
	const conv = body.json?.conversation ?? null;
	if (!conv) {
		return { conversationId: null, messageCount: 0 };
	}
	return {
		conversationId: conv.conversationId,
		messageCount: conv.messages.length,
	};
}

/**
 * Seed a conversation with the requested number of turns. Returns the
 * resulting conversation id. Uses `appendTurnForDocument` so we exercise
 * the real persistence boundary (200-turn cap, byte truncation, audit
 * emission). Caller must `removeConversation` for cleanup.
 */
export async function seedConversation(
	request: APIRequestContext,
	scope: SeedScope,
	turns: number,
	opts: { requestedVisibility?: "SHARED" | "PRIVATE" } = {},
): Promise<string> {
	const visibility = opts.requestedVisibility ?? "SHARED";
	let conversationId: string | null = null;
	for (let i = 0; i < turns; i++) {
		const role: "user" | "assistant" = i % 2 === 0 ? "user" : "assistant";
		const turn = buildTurn({ index: i, role });
		const resp = await request.post(
			"/api/rpc/agents/conversations/appendTurnForDocument",
			{
				headers: { "Content-Type": "application/json" },
				data: {
					json: {
						...refInput(scope),
						conversationId,
						message: turn,
						agentId: "project_document_generator",
						requestedVisibility: visibility,
					},
				},
			},
		);
		if (!resp.ok()) {
			const text = await resp.text();
			throw new Error(
				`seedConversation: appendTurn #${i} failed (${resp.status()}): ${text.slice(0, 200)}`,
			);
		}
		const body = (await resp.json()) as {
			json?: { conversationId: string; spilledTo?: string };
		};
		if (!body.json?.conversationId) {
			throw new Error(
				`seedConversation: appendTurn #${i} returned no conversationId`,
			);
		}
		// `spilledTo` overrides on the 201st turn. Track
		// it so subsequent appends land in the continuation row.
		conversationId = body.json.spilledTo ?? body.json.conversationId;
	}
	if (!conversationId) {
		throw new Error("seedConversation: produced no conversationId");
	}
	return conversationId;
}

export async function removeConversation(
	request: APIRequestContext,
	conversationId: string,
): Promise<void> {
	// Best-effort: a failed cleanup is logged but does not fail the test
	// run. The next run can collide with stale state, but our test bodies
	// always treat the active conversation as the source of truth so a
	// stale row only inflates the visible thread.
	const resp = await request.post(
		"/api/rpc/agents/conversations/deleteForDocument",
		{
			headers: { "Content-Type": "application/json" },
			data: { json: { conversationId } },
		},
	);
	if (!resp.ok()) {
		// eslint-disable-next-line no-console
		console.warn(
			`[fixtures] removeConversation failed (${resp.status()}) for ${conversationId}`,
		);
	}
}

/**
 * The exact greeting copy CopilotKit renders when `messages.length === 0`
 * inside `<DocumentEditor>` — taken from the `<CopilotSidebar labels>` block
 * (DocumentEditor.tsx ~line 3603). We pin the substring "Hi! I can help you
 * edit this document in place" rather than the full string so a future copy
 * tweak that does not change the spirit of the greeting still lets the
 * assertion catch regressions.
 *
 * Spec §3.2 FR-8 / AC-7 — this string MUST NOT appear in the first paint of
 * a document that has a seeded active conversation.
 */
export const DOCUMENT_GREETING_SUBSTRING =
	"Hi! I can help you edit this document in place";

export function pageUrlFor(scope: SeedScope): string {
	return scope.kind === "org"
		? `/app/${scope.organizationSlug}/projects/${scope.projectId}/documents/${scope.documentId}`
		: `/app/projects/${scope.projectId}/documents/${scope.documentId}`;
}

// ---------------------------------------------------------------------------
// Navigation helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Direct Prisma client (cascade verification, I.6 + I.9)
// ---------------------------------------------------------------------------

/**
 * Cached singleton so successive `getDirectPrismaClient()` calls inside a
 * spec file share the same connection pool. Imported lazily so a spec that
 * never opts in to direct DB assertions never pays the connection cost.
 */
let _directClient: unknown = null;

/**
 * Returns a real PrismaClient bound to `process.env.TEST_DATABASE_URL`.
 *
 * This intentionally exists in a separate code path from the seed helpers:
 * the seed helpers go through the live oRPC API (covering auth, validation,
 * audit, and the XOR predicate) but cascade-assertion specs need to verify
 * the post-condition AFTER a destructive operation. Going through the API
 * to assert "the row is gone" would couple the assertion to the same
 * procedure that performed the delete; a direct DB query is more honest.
 *
 * Throws a clear error if `TEST_DATABASE_URL` is not set so callers can
 * `test.skip(true, ...)` cleanly at the spec top.
 */
export async function getDirectPrismaClient(): Promise<{
	documentAssistantConversation: {
		findMany: (args: unknown) => Promise<unknown[]>;
		count: (args: unknown) => Promise<number>;
	};
	agentConversation: {
		findMany: (args: unknown) => Promise<unknown[]>;
		count: (args: unknown) => Promise<number>;
		findUnique: (args: unknown) => Promise<unknown>;
	};
	$disconnect: () => Promise<void>;
	// Generated PrismaClient is typed loosely here so this fixture file is
	// safe to import from any spec without paying the full generated-types
	// cost. `noExplicitAny` is `off` for this workspace.
	[k: string]: any;
}> {
	if (!process.env.TEST_DATABASE_URL) {
		throw new Error(
			"getDirectPrismaClient: TEST_DATABASE_URL is not set — gate the spec with " +
				"`test.skip(!process.env.TEST_DATABASE_URL, '...')` before importing this.",
		);
	}
	if (_directClient) {
		return _directClient as any;
	}
	// Dynamic import so the generated client isn't pulled into the Node
	// process unless a spec actively asks for it (keeps the test boot fast).
	// Reach into the generated client directly because the workspace barrel
	// re-exports `db` (a proxy bound to DATABASE_URL) but not the bare
	// PrismaClient constructor — we need a fresh client bound to
	// TEST_DATABASE_URL so cascade specs can target a dedicated test DB.
	const mod = (await import("@repo/database/prisma/generated/client")) as {
		PrismaClient: new (opts: { datasourceUrl?: string }) => any;
	};
	_directClient = new mod.PrismaClient({
		datasourceUrl: process.env.TEST_DATABASE_URL,
	});
	return _directClient as any;
}

// ---------------------------------------------------------------------------
// Direct-API helpers used by the new specs
// ---------------------------------------------------------------------------

/**
 * Resolve the authenticated user's id via the Better Auth session endpoint.
 * Mirrors `mention-roundtrip.spec.ts`. Used by author-only specs (I.8) and
 * by the standalone Fabric AI regression (I.9).
 */
export async function resolveCurrentUserId(
	request: APIRequestContext,
): Promise<string> {
	const resp = await request.get("/api/auth/get-session");
	if (!resp.ok()) {
		throw new Error(
			`resolveCurrentUserId: /api/auth/get-session returned ${resp.status()}`,
		);
	}
	const body = (await resp.json()) as { user?: { id?: string } };
	const id = body?.user?.id;
	if (!id) {
		throw new Error(
			"resolveCurrentUserId: session payload had no user.id — is the request authenticated?",
		);
	}
	return id;
}

/**
 * List conversations for a document via the live oRPC API. Used in the
 * two-user-visibility specs to assert what user B can see without poking
 * into UI state.
 */
export async function listConversationsForDocument(
	request: APIRequestContext,
	scope: SeedScope,
): Promise<
	Array<{
		conversationId: string;
		authorId: string;
		visibility: "SHARED" | "PRIVATE";
		title: string | null;
	}>
> {
	const resp = await request.post(
		"/api/rpc/agents/conversations/listForDocument",
		{
			headers: { "Content-Type": "application/json" },
			data: { json: { ...refInput(scope), limit: 25, cursor: null } },
		},
	);
	if (!resp.ok()) {
		throw new Error(
			`listConversationsForDocument: ${resp.status()} ${await resp.text()}`,
		);
	}
	const body = (await resp.json()) as {
		json?: {
			items: Array<{
				conversationId: string;
				authorId: string;
				visibility: "SHARED" | "PRIVATE";
				title: string | null;
			}>;
		};
	};
	return body.json?.items ?? [];
}

/**
 * Archive the currently-active conversation for a document. Used by I.5 to
 * seed an "archived" state without going through the UI, AND by I.7 to
 * cycle 50 conversation rows past the soft cap with minimal overhead.
 */
export async function archiveActiveConversation(
	request: APIRequestContext,
	conversationId: string,
): Promise<void> {
	const resp = await request.post(
		"/api/rpc/agents/conversations/archiveForDocument",
		{
			headers: { "Content-Type": "application/json" },
			data: { json: { conversationId } },
		},
	);
	if (!resp.ok()) {
		throw new Error(
			`archiveActiveConversation: ${resp.status()} ${await resp.text()}`,
		);
	}
}
