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

import { db } from "@repo/database";
import { type NextRequest, NextResponse } from "next/server";
import {
	authenticateKanbanRequest,
	canUpdateKanbanProject,
	kanbanPermissionRefusal,
	requireKanbanScope,
} from "../auth";

export async function POST(request: NextRequest) {
	const auth = await authenticateKanbanRequest(request, {
		allowLaunchToken: false,
	});
	if (!auth) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}
	const scopeRefusal = requireKanbanScope(auth, "kanban:write");
	if (scopeRefusal) {
		return scopeRefusal;
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
			...(auth.organizationId
				? { organizationId: auth.organizationId }
				: {}),
			createdById: auth.userId,
			status: "PULLED",
		},
		select: {
			id: true,
			organizationId: true,
			projectId: true,
			storyId: true,
		},
	});

	if (!item) {
		return NextResponse.json(
			{ error: "Queue item not found or not in PULLED status" },
			{ status: 404 },
		);
	}

	if (
		!(await canUpdateKanbanProject(auth, {
			id: item.projectId,
			organizationId: item.organizationId,
		}))
	) {
		return kanbanPermissionRefusal(
			"The credential owner no longer has permission to update this Kanban item",
		);
	}

	const result = await db.kanbanQueue.updateMany({
		where: {
			id: queueItemId,
			organizationId: item.organizationId,
			createdById: auth.userId,
			status: "PULLED",
		},
		data: {
			status: "COMPLETED",
			completedAt: new Date(),
			...(branchName ? { branchName } : {}),
		},
	});
	if (result.count === 0) {
		return NextResponse.json(
			{ error: "Queue item not found or not in PULLED status" },
			{ status: 404 },
		);
	}

	return NextResponse.json({ ok: true, queueItemId });
}
