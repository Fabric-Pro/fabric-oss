/**
 * Document Lock API Endpoint
 *
 * Handles document locking for collaborative editing.
 * POST: Acquire lock
 * DELETE: Release lock
 * GET: Check lock status
 *
 * Supports sendBeacon for reliable lock release on page unload.
 */

import { emitLockUpdate } from "@repo/api/lib/realtime";
import { auth } from "@repo/auth";
import {
	acquireDocumentLock,
	canEditProject,
	extendLock,
	getDocumentLockStatus,
	hasProjectAccess,
	releaseDocumentLock,
} from "@repo/database";
import { headers } from "next/headers";
import type { NextRequest } from "next/server";

type RouteContext = {
	params: Promise<{ projectId: string; documentId: string }>;
};

/**
 * GET: Check the lock status of a document
 */
export async function GET(_req: NextRequest, { params }: RouteContext) {
	const { projectId, documentId } = await params;

	try {
		const headersList = await headers();
		const session = await auth.api.getSession({
			headers: headersList,
		});

		if (!session?.user) {
			return Response.json({ error: "Unauthorized" }, { status: 401 });
		}

		// Check project access
		const hasAccess = await hasProjectAccess(projectId, session.user.id);
		if (!hasAccess) {
			return Response.json({ error: "Forbidden" }, { status: 403 });
		}

		const status = await getDocumentLockStatus(documentId);

		return Response.json({
			isLocked: status.isLocked,
			lockedBy: status.lockedBy,
			lockedByMe: status.lockedBy?.userId === session.user.id,
			expiresAt: status.expiresAt?.toISOString(),
		});
	} catch (error: unknown) {
		console.error("[Document Lock API] GET error:", error);
		return Response.json(
			{
				error:
					error instanceof Error
						? error.message
						: "Internal server error",
			},
			{ status: 500 },
		);
	}
}

/**
 * POST: Acquire a lock on a document or extend existing lock (heartbeat)
 */
export async function POST(req: NextRequest, { params }: RouteContext) {
	const { projectId, documentId } = await params;

	try {
		const headersList = await headers();
		const session = await auth.api.getSession({
			headers: headersList,
		});

		if (!session?.user) {
			return Response.json({ error: "Unauthorized" }, { status: 401 });
		}

		// Check project access
		const hasAccess = await hasProjectAccess(projectId, session.user.id);
		if (!hasAccess) {
			return Response.json({ error: "Forbidden" }, { status: 403 });
		}

		// Check if user can edit (owner or editor role)
		const canEdit = await canEditProject(projectId, session.user.id);
		if (!canEdit) {
			return Response.json(
				{ error: "You don't have edit permissions for this project" },
				{ status: 403 },
			);
		}

		// Check if this is a heartbeat request (extending existing lock)
		const url = new URL(req.url);
		const isHeartbeat = url.searchParams.get("heartbeat") === "true";

		if (isHeartbeat) {
			// Just extend the lock if we hold it
			const status = await getDocumentLockStatus(documentId);
			if (status.lockedBy?.userId === session.user.id) {
				await extendLock(documentId, session.user.id);
				return Response.json({ extended: true });
			}
			return Response.json({ extended: false }, { status: 409 });
		}

		// Try to acquire the lock
		const result = await acquireDocumentLock(
			documentId,
			session.user.id,
			session.user.name || "Anonymous",
		);

		if (result.acquired) {
			// Emit realtime event
			await emitLockUpdate({
				projectId,
				documentId,
				lockedBy: session.user.id,
				lockedByName: session.user.name || "Anonymous",
				lockedAt: new Date().toISOString(),
			});

			return Response.json({
				acquired: true,
				lock: {
					userId: session.user.id,
					userName: session.user.name || "Anonymous",
					expiresAt: result.lock.expiresAt.toISOString(),
				},
			});
		}
		return Response.json(
			{
				acquired: false,
				lockedBy: result.lockedBy?.userId,
				lockedByName: result.lockedBy?.userName,
			},
			{ status: 409 },
		);
	} catch (error: unknown) {
		console.error("[Document Lock API] POST error:", error);
		return Response.json(
			{
				error:
					error instanceof Error
						? error.message
						: "Internal server error",
			},
			{ status: 500 },
		);
	}
}

/**
 * DELETE: Release a lock on a document
 * Also handles sendBeacon with ?action=release query param
 */
export async function DELETE(_req: NextRequest, { params }: RouteContext) {
	const { projectId, documentId } = await params;

	try {
		const headersList = await headers();
		const session = await auth.api.getSession({
			headers: headersList,
		});

		if (!session?.user) {
			return Response.json({ error: "Unauthorized" }, { status: 401 });
		}

		// Release the lock (only if held by this user)
		const released = await releaseDocumentLock(documentId, session.user.id);

		if (released) {
			// Emit realtime event
			await emitLockUpdate({
				projectId,
				documentId,
				lockedBy: null,
				lockedByName: undefined,
				lockedAt: undefined,
			});
		}

		return Response.json({ released });
	} catch (error: unknown) {
		console.error("[Document Lock API] DELETE error:", error);
		return Response.json(
			{
				error:
					error instanceof Error
						? error.message
						: "Internal server error",
			},
			{ status: 500 },
		);
	}
}

export const runtime = "nodejs";
