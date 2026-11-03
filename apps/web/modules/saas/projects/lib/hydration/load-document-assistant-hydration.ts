/**
 * Server-side helper that loads the SSR hydration payload for the document /
 * feature assistant sidebar — bypassing the oRPC HTTP roundtrip.
 *
 * # Why this exists
 *
 * The four SSR page loaders for documents + stories (personal + org context)
 * previously called `orpcClient.agents.conversations.getActiveForDocument(...)`,
 * which fires an HTTP `fetch` against the same Next.js server's own
 * `/api/rpc/...` endpoint. That request reliably fails with
 * `TypeError: fetch failed [ECONNREFUSED]` on multiple deploy targets:
 *
 *   - **Node prod build on Windows** (and any host that resolves `localhost`
 *     to `::1` while Next.js binds to `0.0.0.0` only) — IPv6/IPv4 mismatch.
 *   - **Vercel serverless functions** — a function fetching its own
 *     deployment URL can run into runtime networking restrictions.
 *
 * The catch handler in the SSR loaders swallowed the error and returned
 * `{ conversation: null }`, so `initialAssistantMessages` was empty and
 * `<CustomMessages>` had no historical turns to render — the live sidebar
 * "lost" all prior conversation history after every reload. The user-facing
 * symptom is identical to a hydrator race, which is what we chased for
 * several PRs before tracing the actual failure to the SSR fetch via
 * instrumentation against a local production bundle.
 *
 * # The fix
 *
 * Call the underlying DB query (`getActiveDocumentAssistantConversation`)
 * directly in-process, mirroring the oRPC procedure's logic:
 *
 *   1. Check the caller can see the document's project, and that the
 *      document is in the page's project (`canAccessDocumentProject`, the
 *      procedure's own check). A refusal returns no conversation, without
 *      the fail-open warning: it is not a failed load.
 *   2. Resolve tenant filter (XOR: org context OR personal context).
 *   3. Apply the org feature flag gate (personal context always enabled).
 *   4. Query the DB.
 *   5. Re-sign attachment GET URLs (so image previews render after a
 *      reload — the persisted URLs in storage are stale by design).
 *   6. Return the same envelope shape the oRPC handler returns, so the
 *      page-level component contract is unchanged.
 *
 * Org-membership verification is skipped intentionally — the page loader
 * has already established it via `getActiveOrganization(slug)` and would
 * redirect to `/app` if missing. Duplicating the check here would just add
 * latency. Organization membership does not stand in for project access,
 * which is why step 1 is not skipped.
 *
 * # Audit
 *
 * The four SSR loaders that call this helper are the ONLY places we read
 * conversation history server-side. Every other path (drawer list, drawer
 * viewer, persistence on send) goes through the regular oRPC client from
 * the browser, where the same `fetch` works because the browser resolves
 * `your-fabric-host.example` / `localhost` correctly and there's no
 * function-fetches-itself loop.
 */

import {
	canAccessDocumentProject,
	resignMessageAttachments,
} from "@repo/api/modules/agents/procedures/conversations/document-assistant/_shared";
import { db, getActiveDocumentAssistantConversation } from "@repo/database";
import { logger } from "@repo/logs";

interface LoadDocumentAssistantHydrationInput {
	userId: string;
	organizationId: string | null;
	/** The project the page names; the document must belong to it. */
	projectId: string;
	documentRefKind: "PROJECT_DOCUMENT" | "USER_STORY";
	documentRefId: string;
}

interface LoadDocumentAssistantHydrationConversation {
	id: string;
	conversationId: string;
	title: string | null;
	visibility: "SHARED" | "PRIVATE";
	visibilityLockedAt: string | null;
	messages: unknown[];
	parentConversationId: string | null;
	agentId: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface LoadDocumentAssistantHydrationResult {
	conversation: LoadDocumentAssistantHydrationConversation | null;
}

export async function loadDocumentAssistantHydration({
	userId,
	organizationId,
	projectId,
	documentRefKind,
	documentRefId,
}: LoadDocumentAssistantHydrationInput): Promise<LoadDocumentAssistantHydrationResult> {
	try {
		// The thread procedures show a document's threads only to a caller
		// who can see its project; organization membership, which the page
		// loader established, is not enough.
		if (
			!(await canAccessDocumentProject({
				documentRefKind,
				documentRefId,
				projectId,
				userId,
			}))
		) {
			return { conversation: null };
		}

		// Feature-flag gate: spec §3.11 FR-27. Personal context (no
		// organizationId) is always treated as enabled; org context defers
		// to the org's `documentAssistantHistoryEnabled` column.
		if (organizationId) {
			const org = await db.organization.findUnique({
				where: { id: organizationId },
				select: { documentAssistantHistoryEnabled: true },
			});
			if (org?.documentAssistantHistoryEnabled === false) {
				return { conversation: null };
			}
		}

		const row = await getActiveDocumentAssistantConversation({
			tenantFilter: organizationId
				? { organizationId, userId }
				: { organizationId: null, userId },
			documentRefKind,
			documentRefId,
		});

		if (!row) {
			return { conversation: null };
		}

		const conv = row.conversation;
		const messages = await resignMessageAttachments(
			conv.messages as unknown[],
		);

		return {
			conversation: {
				id: row.id,
				conversationId: row.conversationId,
				title: conv.title ?? null,
				visibility: row.visibility as "SHARED" | "PRIVATE",
				visibilityLockedAt:
					row.visibilityLockedAt?.toISOString() ?? null,
				messages,
				parentConversationId: conv.parentConversationId ?? null,
				agentId: conv.agentId ?? null,
				createdAt: row.createdAt.toISOString(),
				updatedAt: row.updatedAt.toISOString(),
			},
		};
	} catch (error) {
		// Fail open — an SSR-hydration error shouldn't 500 the editor.
		// The user sees a fresh / empty sidebar, identical to a brand-new
		// document, instead of a broken page. The page-level component
		// is the higher-priority user goal.
		logger.warn(
			{
				err: error,
				documentRefKind,
				documentRefId,
				organizationId,
			},
			"[document-assistant] in-process hydration load failed",
		);
		return { conversation: null };
	}
}
