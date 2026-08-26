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

import { createHash } from "node:crypto";
import { db } from "@repo/database";
import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
	const authHeader = request.headers.get("Authorization");
	if (!authHeader?.startsWith("Bearer ")) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const rawKey = authHeader.slice(7);
	const keyHash = createHash("sha256").update(rawKey).digest("hex");

	// Try org API key first
	const orgKey = await db.organizationApiKey.findFirst({
		where: {
			keyHash,
			isActive: true,
			OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
		},
		select: { id: true, organizationId: true, createdByUserId: true },
	});

	if (orgKey) {
		await db.organizationApiKey.update({
			where: { id: orgKey.id },
			data: { lastUsedAt: new Date(), usageCount: { increment: 1 } },
		});

		const user = await db.user.findUnique({
			where: { id: orgKey.createdByUserId },
			select: { name: true, email: true },
		});

		if (!user) {
			return NextResponse.json(
				{ error: "User not found" },
				{ status: 404 },
			);
		}

		return NextResponse.json({
			userId: orgKey.createdByUserId,
			organizationId: orgKey.organizationId,
			name: user.name,
			email: user.email,
		});
	}

	// Fall back to personal API key
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

		const user = await db.user.findUnique({
			where: { id: userKey.userId },
			select: { name: true, email: true },
		});

		if (!user) {
			return NextResponse.json(
				{ error: "User not found" },
				{ status: 404 },
			);
		}

		return NextResponse.json({
			userId: userKey.userId,
			organizationId: null,
			name: user.name,
			email: user.email,
		});
	}

	return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
