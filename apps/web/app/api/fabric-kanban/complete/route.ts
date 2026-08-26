/**
 * Fabric Kanban Completion API
 *
 * Called by fabric-kanban when a local agent finishes implementation
 * and moves a task to "ready for review".
 *
 * POST /api/fabric-kanban/complete
 * Body: { queueItemId, branchName, commit? }
 *
 * Updates KanbanQueue status to COMPLETED and stores the branch name.
 */

import { createHash } from "node:crypto";
import { db } from "@repo/database";
import { type NextRequest, NextResponse } from "next/server";

type AuthContext =
	| { type: "org"; organizationId: string }
	| { type: "user"; userId: string; organizationId: null };

async function authenticate(request: NextRequest): Promise<AuthContext | null> {
	const authHeader = request.headers.get("Authorization");
	if (!authHeader?.startsWith("Bearer ")) {
		return null;
	}
	const rawKey = authHeader.slice(7);
	const keyHash = createHash("sha256").update(rawKey).digest("hex");

	const orgKey = await db.organizationApiKey.findFirst({
		where: {
			keyHash,
			isActive: true,
			OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
		},
		select: { id: true, organizationId: true },
	});
	if (orgKey) {
		await db.organizationApiKey.update({
			where: { id: orgKey.id },
			data: { lastUsedAt: new Date(), usageCount: { increment: 1 } },
		});
		return { type: "org", organizationId: orgKey.organizationId };
	}

	const userKey = await db.userApiKey.findFirst({
		where: {
			keyHash,
			isActive: true,
			OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
		},
		select: { id: true, userId: true },
	});
	if (userKey) {
		await db.userApiKey.update({
			where: { id: userKey.id },
			data: { lastUsedAt: new Date(), usageCount: { increment: 1 } },
		});
		return { type: "user", userId: userKey.userId, organizationId: null };
	}

	return null;
}

export async function POST(request: NextRequest) {
	const auth = await authenticate(request);
	if (!auth) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	let body: { queueItemId?: string; branchName?: string; commit?: string };
	try {
		body = await request.json();
	} catch {
		return NextResponse.json(
			{ error: "Invalid JSON body" },
			{ status: 400 },
		);
	}

	const { queueItemId, branchName } = body;
	if (!queueItemId) {
		return NextResponse.json(
			{ error: "queueItemId is required" },
			{ status: 400 },
		);
	}

	// Verify the queue item belongs to this auth context
	const item = await db.kanbanQueue.findFirst({
		where: {
			id: queueItemId,
			organizationId: auth.type === "org" ? auth.organizationId : null,
			status: "PULLED",
		},
		select: { id: true, storyId: true },
	});

	if (!item) {
		return NextResponse.json(
			{ error: "Queue item not found or not in PULLED status" },
			{ status: 404 },
		);
	}

	await db.kanbanQueue.update({
		where: { id: queueItemId },
		data: {
			status: "COMPLETED",
			completedAt: new Date(),
			...(branchName ? { branchName } : {}),
		},
	});

	return NextResponse.json({ ok: true, queueItemId });
}
