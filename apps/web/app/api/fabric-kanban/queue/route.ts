/**
 * Fabric Kanban Queue API
 *
 * Called by the fabric-kanban CLI to pull pending implementation items.
 * Authentication: Organization API key in the Authorization header.
 * Project resolution: Git remote URL matched against project.repositoryUrl.
 *
 * Items are always scoped to the user who owns the API key (createdById),
 * so each developer only pulls the features they personally queued.
 *
 * GET  /api/fabric-kanban/queue?repoUrl=<url>   — list PENDING items
 * POST /api/fabric-kanban/queue                 — mark items as PULLED
 */

import { createHash } from "node:crypto";
import { verifyKanbanLaunchToken } from "@repo/api/modules/kanban/procedures/create-token";
import { db } from "@repo/database";
import { type NextRequest, NextResponse } from "next/server";

function normalizeRepoUrl(raw: string): string {
	let url = raw.trim();
	// Convert SSH git@github.com:owner/repo.git → https://github.com/owner/repo
	url = url.replace(/^git@([^:]+):(.+)$/, "https://$1/$2");
	// Strip trailing .git
	url = url.replace(/\.git$/, "");
	// Strip trailing slash
	url = url.replace(/\/$/, "");
	return url.toLowerCase();
}

type AuthContext = {
	/** The user who owns or created the API key — always present */
	userId: string;
	organizationId: string | null;
};

async function authenticate(request: NextRequest): Promise<AuthContext | null> {
	const authHeader = request.headers.get("Authorization");
	if (!authHeader?.startsWith("Bearer ")) {
		return null;
	}
	const rawKey = authHeader.slice(7);
	const keyHash = createHash("sha256").update(rawKey).digest("hex");

	// Try org API key first — use createdByUserId so we know which user is pulling
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
		return {
			userId: orgKey.createdByUserId,
			organizationId: orgKey.organizationId,
		};
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
		return { userId: userKey.userId, organizationId: null };
	}

	// Fall back to short-lived JWT issued by the exchange-token endpoint.
	// This lets the kanban CLI authenticate queue requests using the token
	// it received during the embed launch handshake, without needing a
	// separately configured long-lived API key.
	try {
		const claims = await verifyKanbanLaunchToken(rawKey);
		return {
			userId: claims.sub,
			organizationId: claims.organizationId ?? null,
		};
	} catch {
		// Not a valid JWT — fall through to null
	}

	return null;
}

/**
 * GET /api/fabric-kanban/queue?repoUrl=<url>
 *
 * Returns PENDING items queued by the authenticated user for the project
 * matching the given repo URL. Each developer only sees their own queue.
 */
export async function GET(request: NextRequest) {
	const auth = await authenticate(request);
	if (!auth) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const repoUrl = request.nextUrl.searchParams.get("repoUrl");
	if (!repoUrl) {
		return NextResponse.json(
			{ error: "Missing repoUrl query parameter" },
			{ status: 400 },
		);
	}

	const normalized = normalizeRepoUrl(repoUrl);

	// Find projects accessible by this key with a matching repository URL
	const projects = await db.project.findMany({
		where: {
			...(auth.organizationId
				? { organizationId: auth.organizationId }
				: { userId: auth.userId, organizationId: null }),
			repositoryUrl: {
				in: [normalized, `${normalized}.git`],
				mode: "insensitive",
			},
			deletedAt: null,
		},
		select: {
			id: true,
			name: true,
			repositoryUrl: true,
			repositoryOwner: true,
			repositoryName: true,
			defaultBranch: true,
		},
	});

	if (projects.length === 0) {
		return NextResponse.json(
			{
				error: "No project found for this repository URL in your organization",
				repoUrl: normalized,
			},
			{ status: 404 },
		);
	}

	const projectIds = projects.map((p) => p.id);

	// Always filter by the user who queued the items — each developer only
	// pulls their own queue regardless of whether they used an org or personal key
	const items = await db.kanbanQueue.findMany({
		where: {
			projectId: { in: projectIds },
			createdById: auth.userId,
			status: "PENDING",
		},
		orderBy: { queuedAt: "asc" },
		include: {
			project: {
				select: {
					id: true,
					name: true,
					repositoryUrl: true,
					repositoryOwner: true,
					repositoryName: true,
					defaultBranch: true,
				},
			},
			user: {
				select: { name: true, email: true },
			},
		},
	});

	return NextResponse.json({
		project: projects[0],
		pendingCount: items.length,
		items: items.map((item) => ({
			id: item.id,
			project: item.project,
			context: item.context,
			queuedAt: item.queuedAt,
			queuedBy: {
				name: item.user.name,
				email: item.user.email,
			},
		})),
	});
}

/**
 * POST /api/fabric-kanban/queue
 * Body: { itemIds: string[] }
 *
 * Marks the given queue items as PULLED (so they won't be returned again).
 * Only marks items that belong to the authenticated user.
 */
export async function POST(request: NextRequest) {
	const auth = await authenticate(request);
	if (!auth) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	let body: { itemIds?: string[] };
	try {
		body = await request.json();
	} catch {
		return NextResponse.json(
			{ error: "Invalid JSON body" },
			{ status: 400 },
		);
	}

	const { itemIds } = body;
	if (!Array.isArray(itemIds) || itemIds.length === 0) {
		return NextResponse.json(
			{ error: "itemIds must be a non-empty array" },
			{ status: 400 },
		);
	}

	// Only mark items that this user queued — prevents one user marking
	// another user's items as pulled
	const result = await db.kanbanQueue.updateMany({
		where: {
			id: { in: itemIds },
			createdById: auth.userId,
			status: "PENDING",
		},
		data: {
			status: "PULLED",
			pulledAt: new Date(),
		},
	});

	return NextResponse.json({ pulled: result.count });
}
