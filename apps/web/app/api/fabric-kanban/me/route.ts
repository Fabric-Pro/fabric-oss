/**
 * Fabric Kanban Identity Endpoint
 *
 * Returns the authenticated user's identity from an API key.
 * Supports both personal API keys (fab_xxx) and organization API keys.
 *
 * GET /api/fabric-kanban/me
 * Authorization: Bearer <api-key>
 *
 * Response: { userId, organizationId, name, email }
 */

import { db } from "@repo/database";
import { type NextRequest, NextResponse } from "next/server";
import { authenticateKanbanRequest, requireKanbanScope } from "../auth";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
	const auth = await authenticateKanbanRequest(request, {
		allowLaunchToken: false,
	});
	if (!auth) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}
	const scopeRefusal = requireKanbanScope(auth, "kanban:read");
	if (scopeRefusal) {
		return scopeRefusal;
	}

	const user = await db.user.findUnique({
		where: { id: auth.userId },
		select: { name: true, email: true },
	});
	if (!user) {
		return NextResponse.json({ error: "User not found" }, { status: 404 });
	}

	return NextResponse.json({
		userId: auth.userId,
		organizationId: auth.organizationId,
		name: user.name,
		email: user.email,
	});
}
