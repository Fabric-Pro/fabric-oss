/**
 * Fabric Kanban Queue API
 *
 * Called by the fabric-kanban CLI to pull pending implementation items.
 * Authentication: organization key, personal key, or launch token in the
 * Authorization header.
 * Project resolution: Git remote URL matched against project.repositoryUrl.
 *
 * Items are always scoped to the user who owns the API key (createdById),
 * so each developer only pulls the features they personally queued.
 *
 * GET  /api/fabric-kanban/queue?repoUrl=<url>   — list PENDING items
 * POST /api/fabric-kanban/queue                 — mark items as PULLED
 */

import { db } from "@repo/database";
import { type NextRequest, NextResponse } from "next/server";
import {
	authenticateKanbanRequest,
	canReadKanbanProject,
	canUpdateKanbanProject,
	kanbanPermissionRefusal,
	requireKanbanScope,
} from "../auth";

function normalizeRepoUrl(raw: string): string {
	let url = raw.trim();
	// Convert SSH git@<host>:owner/repo.git → https://<host>/owner/repo (host-agnostic)
	url = url.replace(/^git@([^:]+):(.+)$/, "https://$1/$2");
	// Strip trailing .git
	url = url.replace(/\.git$/, "");
	// Strip trailing slash
	url = url.replace(/\/$/, "");
	return url.toLowerCase();
}

function projectNotFound(repoUrl: string) {
	return NextResponse.json(
		{
			error: "No project found for this repository URL in your organization",
			repoUrl,
		},
		{ status: 404 },
	);
}

/**
 * GET /api/fabric-kanban/queue?repoUrl=<url>
 *
 * Returns PENDING items queued by the authenticated user for the project
 * matching the given repo URL. Each developer only sees their own queue.
 */
export async function GET(request: NextRequest) {
	const auth = await authenticateKanbanRequest(request, {
		allowLaunchToken: true,
	});
	if (!auth) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}
	const scopeRefusal = requireKanbanScope(auth, "kanban:read");
	if (scopeRefusal) {
		return scopeRefusal;
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
				: { organizationId: { not: null } }),
			repositoryUrl: {
				in: [normalized, `${normalized}.git`],
				mode: "insensitive",
			},
			deletedAt: null,
		},
		select: {
			id: true,
			name: true,
			organizationId: true,
			repositoryUrl: true,
			repositoryOwner: true,
			repositoryName: true,
			defaultBranch: true,
		},
	});

	if (projects.length === 0) {
		return projectNotFound(normalized);
	}

	const authorizedProjects = [];
	for (const project of projects) {
		if (await canReadKanbanProject(auth, project)) {
			authorizedProjects.push(project);
		}
	}
	if (authorizedProjects.length === 0) {
		return projectNotFound(normalized);
	}
	if (
		auth.type === "personal-key" &&
		new Set(authorizedProjects.map((project) => project.organizationId))
			.size > 1
	) {
		return kanbanPermissionRefusal(
			"The personal key resolves to more than one organization for this repository",
		);
	}

	const projectIds = authorizedProjects.map((project) => project.id);

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
	const firstProject = authorizedProjects[0];

	return NextResponse.json({
		project: {
			id: firstProject.id,
			name: firstProject.name,
			repositoryUrl: firstProject.repositoryUrl,
			repositoryOwner: firstProject.repositoryOwner,
			repositoryName: firstProject.repositoryName,
			defaultBranch: firstProject.defaultBranch,
		},
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
	const auth = await authenticateKanbanRequest(request, {
		allowLaunchToken: true,
	});
	if (!auth) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}
	const scopeRefusal = requireKanbanScope(auth, "kanban:write");
	if (scopeRefusal) {
		return scopeRefusal;
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

	const items = await db.kanbanQueue.findMany({
		where: {
			id: { in: itemIds },
			...(auth.organizationId
				? { organizationId: auth.organizationId }
				: {}),
			createdById: auth.userId,
			status: "PENDING",
		},
		select: { id: true, projectId: true, organizationId: true },
	});
	for (const item of items) {
		if (
			!(await canUpdateKanbanProject(auth, {
				id: item.projectId,
				organizationId: item.organizationId,
			}))
		) {
			return kanbanPermissionRefusal(
				"The credential owner no longer has permission to pull this Kanban item",
			);
		}
	}
	const authorizedItemIds = items.map((item) => item.id);

	const result = await db.kanbanQueue.updateMany({
		where: {
			id: { in: authorizedItemIds },
			...(auth.organizationId
				? { organizationId: auth.organizationId }
				: {}),
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
