/**
 * Project Realtime SSE Endpoint
 *
 * Provides Server-Sent Events (SSE) for real-time project collaboration
 * using Upstash Realtime (Redis Streams).
 *
 * Events:
 * - presence_update: Who's viewing the project
 * - document_change: Document created/updated/deleted
 * - context_change: Context added/updated/deleted
 * - lock_update: Document lock acquired/released
 * - activity: Activity feed events
 */

import {
	getProjectChannelName,
	getProjectRealtime,
} from "@repo/api/lib/realtime";
import { auth } from "@repo/auth";
import { hasProjectAccess } from "@repo/database";
import { handle } from "@upstash/realtime";
import { headers } from "next/headers";
import type { NextRequest } from "next/server";

export async function GET(
	req: NextRequest,
	{ params }: { params: Promise<{ projectId: string }> },
) {
	const { projectId } = await params;

	// Get realtime instance
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

	// Create URL with the project channel
	const url = new URL(req.url);
	url.searchParams.set("channel", getProjectChannelName(projectId));

	// Create a new request with the channel parameter
	const modifiedRequest = new Request(url.toString(), {
		method: req.method,
		headers: req.headers,
		signal: req.signal,
	});

	// Handle SSE connection with auth middleware
	// Type assertion needed: pnpm resolves two @upstash/realtime copies (zod 4.1 vs 4.3)
	// with structurally identical but nominally incompatible Realtime classes
	return handle({
		realtime: realtime as unknown as Parameters<
			typeof handle
		>[0]["realtime"],
		middleware: async ({ request: _request, channels: _channels }) => {
			// Get user session
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

			// Check project access
			const hasAccess = await hasProjectAccess(
				projectId,
				session.user.id,
			);
			if (!hasAccess) {
				return new Response(JSON.stringify({ error: "Forbidden" }), {
					status: 403,
					headers: { "Content-Type": "application/json" },
				});
			}

			// Allow connection to proceed
			return undefined;
		},
	})(modifiedRequest);
}

// Ensure this runs on Node.js runtime for SSE support
export const runtime = "nodejs";

// Disable body parsing for SSE
export const dynamic = "force-dynamic";

// Pin the function budget explicitly; @upstash/realtime closes the
// stream gracefully at ~268s (see REALTIME_STREAM_MAX_DURATION_SECS
// in @repo/api/lib/realtime) so the close never races this limit.
export const maxDuration = 300;
