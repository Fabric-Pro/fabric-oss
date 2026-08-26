/**
 * Project Presence API Endpoint
 *
 * Handles presence updates for real-time collaboration.
 * Broadcasts when users join, leave, or update their activity.
 */

import { emitPresenceUpdate } from "@repo/api/lib/realtime";
import { auth } from "@repo/auth";
import { hasProjectAccess, updateProjectPresence } from "@repo/database";
import { headers } from "next/headers";
import type { NextRequest } from "next/server";
import { z } from "zod";

const PresenceUpdateSchema = z.object({
	action: z.enum(["join", "leave", "heartbeat"]),
	activeTab: z.string().optional(),
	editingDocId: z.string().optional(),
});

export async function POST(
	req: NextRequest,
	{ params }: { params: Promise<{ projectId: string }> },
) {
	const { projectId } = await params;

	try {
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
		const hasAccess = await hasProjectAccess(projectId, session.user.id);
		if (!hasAccess) {
			return new Response(JSON.stringify({ error: "Forbidden" }), {
				status: 403,
				headers: { "Content-Type": "application/json" },
			});
		}

		// Parse request body
		const body = await req.json();
		const validation = PresenceUpdateSchema.safeParse(body);

		if (!validation.success) {
			return new Response(
				JSON.stringify({
					error: "Invalid request",
					details: validation.error.issues,
				}),
				{
					status: 400,
					headers: { "Content-Type": "application/json" },
				},
			);
		}

		const { action, activeTab, editingDocId } = validation.data;

		// Update presence in database (for persistence and querying)
		if (action !== "leave") {
			await updateProjectPresence({
				projectId,
				userId: session.user.id,
				userName: session.user.name || "Anonymous",
				userImage: session.user.image || undefined,
				activeTab,
				editingDocId,
			});
		}

		// Emit realtime event
		await emitPresenceUpdate({
			projectId,
			userId: session.user.id,
			userName: session.user.name || "Anonymous",
			userImage: session.user.image || undefined,
			action,
			activeTab,
			editingDocId,
		});

		return new Response(JSON.stringify({ success: true }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	} catch (error: unknown) {
		console.error("[Presence API] Error:", error);
		return new Response(
			JSON.stringify({
				error:
					error instanceof Error
						? error.message
						: "Internal server error",
			}),
			{
				status: 500,
				headers: { "Content-Type": "application/json" },
			},
		);
	}
}

export const runtime = "nodejs";
