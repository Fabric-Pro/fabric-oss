/**
 * Conversation Realtime SSE Endpoint.
 *
 * Authenticated Server-Sent Events stream for a single AgentConversation.
 * Subscribers receive `message_appended` events (and only that event
 * type today) when new messages — particularly operation-result system
 * messages — land in the conversation's `messages` JSON blob.
 *
 * Authorization model:
 *
 *   1. The caller MUST have an authenticated session (Better Auth).
 *   2. The caller MUST own the conversation as verified by
 *      `getAgentConversationById({ id, userId, organizationId })`.
 *      A `null` result is mapped to **404 Not Found** — NEVER a
 *      different code that could differentiate "this conversation
 *      doesn't exist" from "this conversation exists in another
 *      tenant". The query helper already enforces strict XOR tenant
 *      scoping (`organizationId === null` for personal context,
 *      explicit string for org context), so calling it with the
 *      session's active org closes the obvious bypass.
 *   3. A document-assistant thread may also be opened by a non-owner
 *      when it is SHARED in their organization
 *      (`canSubscribeToDocumentAssistantConversation`). On every such
 *      thread, owner included, the caller MUST also see the project of
 *      the thread's document (`canAccessDocumentProject`, the check the
 *      thread procedures make), and the document must still be in the
 *      project the thread names. A refusal is the same 404.
 *   4. If Redis isn't configured, return 503 — same as
 *      `/api/projects/[projectId]/realtime`.
 *
 * Implementation mirrors the project realtime route exactly so future
 * Upstash SDK upgrades carry through symmetrically.
 */

import {
	getConversationChannelName,
	getProjectRealtime,
} from "@repo/api/lib/realtime";
import { canAccessDocumentProject } from "@repo/api/modules/agents/procedures/conversations/document-assistant/_shared";
import { auth } from "@repo/auth";
import { getAgentConversationById } from "@repo/database/prisma/queries/agent-conversations";
import {
	canSubscribeToDocumentAssistantConversation,
	getDocumentAssistantThreadRef,
} from "@repo/database/prisma/queries/document-assistant-conversation";
import { handle } from "@upstash/realtime";
import { headers } from "next/headers";
import type { NextRequest } from "next/server";

export async function GET(
	req: NextRequest,
	{ params }: { params: Promise<{ conversationId: string }> },
) {
	const { conversationId } = await params;

	const realtime = getProjectRealtime();
	if (!realtime) {
		return new Response(
			JSON.stringify({ error: "Realtime not configured" }),
			{
				status: 503,
				headers: { "Content-Type": "application/json" },
			},
		);
	}

	const url = new URL(req.url);
	url.searchParams.set("channel", getConversationChannelName(conversationId));

	const modifiedRequest = new Request(url.toString(), {
		method: req.method,
		headers: req.headers,
		signal: req.signal,
	});

	// Type assertion needed: pnpm resolves two @upstash/realtime copies
	// (zod 4.1 vs 4.3) with structurally identical but nominally
	// incompatible Realtime classes. Mirror of the project realtime
	// route's workaround at apps/web/app/api/projects/[projectId]/realtime/route.ts.
	return handle({
		realtime: realtime as unknown as Parameters<
			typeof handle
		>[0]["realtime"],
		middleware: async ({ request: _request, channels: _channels }) => {
			const headersList = await headers();
			const session = await auth.api.getSession({
				headers: headersList,
			});

			if (!session?.user) {
				return new Response(JSON.stringify({ error: "Unauthorized" }), {
					status: 401,
					headers: { "Content-Type": "application/json" },
				});
			}

			// Strict ownership check. We use the session's active org
			// (if any) as the tenant filter; passing `undefined`
			// triggers the legacy "match by userId only" path which is
			// dangerous here — a personal conversation must NOT be
			// accessible from an active-org session, and vice versa.
			// The tri-state in `getAgentConversationById` does this for
			// us: explicit null = personal, string = org, undefined =
			// legacy-no-filter (which we avoid).
			const organizationId = session.session.activeOrganizationId ?? null;
			const conversation = await getAgentConversationById({
				id: conversationId,
				userId: session.user.id,
				organizationId,
			});

			// The owner check above covers every conversation type (including
			// PRIVATE document-assistant threads and non-document surfaces like
			// standalone Fabric AI / Sidekick / Backlog). If the caller is NOT
			// the owner, still allow subscribing to a SHARED document-assistant
			// conversation in their tenant — teammates viewing the same shared
			// document should receive realtime updates, matching the
			// `(visibility = SHARED OR userId = me)` predicate that
			// `getByIdForDocument` already uses to render it. The realtime stream
			// only carries `message_appended` notifications (content is re-fetched
			// through that same predicate), so this cannot leak message content.
			let authorized =
				conversation !== null ||
				(await canSubscribeToDocumentAssistantConversation({
					conversationId,
					userId: session.user.id,
				}));

			// A document-assistant thread is shown by the thread procedures
			// only to a caller who can see its document's project, so ask the
			// same of every subscriber, the owner included: a caller off the
			// project, or a document no longer in the project the thread
			// names, gets the same 404. A conversation without a join row is
			// not about a document and keeps the owner-only rule above.
			if (authorized) {
				const threadRef = await getDocumentAssistantThreadRef({
					conversationId,
				});
				if (threadRef !== null) {
					authorized = await canAccessDocumentProject({
						...threadRef,
						userId: session.user.id,
					});
				}
			}

			if (!authorized) {
				// Always 404 — never reveal whether the row exists in
				// another tenant. Mirrors the record-diff-outcome
				// pattern (packages/api/.../record-diff-outcome.ts:84).
				return new Response(
					JSON.stringify({ error: "Conversation not found" }),
					{
						status: 404,
						headers: { "Content-Type": "application/json" },
					},
				);
			}

			return undefined;
		},
	})(modifiedRequest);
}

// SSE requires the Node.js runtime (Edge would terminate the stream).
export const runtime = "nodejs";

// Streaming responses must not be cached or have their bodies parsed.
export const dynamic = "force-dynamic";

// Pin the function budget explicitly; @upstash/realtime closes the
// stream gracefully at ~268s (see REALTIME_STREAM_MAX_DURATION_SECS
// in @repo/api/lib/realtime) so the close never races this limit.
export const maxDuration = 300;
