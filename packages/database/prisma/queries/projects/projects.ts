/**
 * Database queries for Project model
 * Handles CRUD operations with multi-tenancy support
 */

import {
	hasPermission,
	type Permission,
	Permissions,
	resolveOrgPermissions,
	resolveProjectPermissions,
} from "@repo/permissions";
import {
	type ClarifyingQuestionFrequency,
	db,
	Prisma,
	type Project,
	ProjectMemberRole,
	type ProjectStatus,
} from "../../client";

/**
 * Create a new project
 */
export async function createProject(data: {
	name: string;
	description?: string;
	/** Which readiness checklist applies. Absent means unjudged (Fizzy #2165). */
	projectPhase?: "DISCOVERY_PLANNING" | "DEVELOPMENT_EXECUTION";
	expectedDevelopmentStartDate?: Date;
	goals?: string;
	techStack?: string[];
	features?: string[];
	projectTypes?: string[];
	userId: string;
	organizationId?: string;
	tags?: string[];
	color?: string;
	icon?: string;
	repositoryUrl?: string;
	repositoryOwner?: string;
	repositoryName?: string;
	defaultBranch?: string;
	implementationDefaultChannel?: "BACKGROUND_AGENTS" | "LOCAL_AGENTS";
	implementationDefaultProvider?: "BACKGROUND_AGENTS" | "KANBAN_LOCAL";
	implementationDefaultWorkingDirectory?: string;
	// Project Management integration (for "existing project" flow)
	projectManagementMcpServerId?: string | null;
	projectManagementMcpConfigId?: string | null;
	projectManagementContainerId?: string | null;
	projectManagementContainerName?: string | null;
	projectManagementAdditionalContext?: Prisma.InputJsonValue | null;
	primaryWebsiteUrl?: string | null;
	additionalWebsiteUrls?: string[];
	status?: "DRAFT" | "ACTIVE";
}) {
	return await db.project.create({
		data: {
			name: data.name,
			description: data.description,
			projectPhase: data.projectPhase,
			expectedDevelopmentStartDate: data.expectedDevelopmentStartDate,
			goals: data.goals,
			techStack: data.techStack || [],
			features: data.features || [],
			projectTypes: data.projectTypes || [],
			userId: data.userId,
			organizationId: data.organizationId,
			tags: data.tags || [],
			color: data.color,
			icon: data.icon,
			status: data.status ?? "DRAFT",
			repositoryUrl: data.repositoryUrl,
			repositoryOwner: data.repositoryOwner,
			repositoryName: data.repositoryName,
			defaultBranch: data.defaultBranch,
			implementationDefaultChannel: data.implementationDefaultChannel,
			implementationDefaultProvider: data.implementationDefaultProvider,
			implementationDefaultWorkingDirectory:
				data.implementationDefaultWorkingDirectory,
			projectManagementMcpServerId: data.projectManagementMcpServerId,
			projectManagementMcpConfigId: data.projectManagementMcpConfigId,
			projectManagementContainerId: data.projectManagementContainerId,
			projectManagementContainerName: data.projectManagementContainerName,
			projectManagementAdditionalContext:
				data.projectManagementAdditionalContext === null
					? Prisma.JsonNull
					: data.projectManagementAdditionalContext,
			primaryWebsiteUrl: data.primaryWebsiteUrl,
			additionalWebsiteUrls: data.additionalWebsiteUrls ?? [],
		},
	});
}

/**
 * Flatten the caller-scoped favorite relation (#1694) into a plain boolean.
 *
 * Every read that selects `userPreferences` goes through this, so no consumer
 * has to know the relation exists and no preference row leaves the server. The
 * project detail read reaches an external contract (the public v1 REST project
 * endpoint), which is the surface that would otherwise serialize the raw array.
 */
export function withFavoriteFlag<
	T extends { userPreferences: { favoritedAt: Date | null }[] },
>(project: T) {
	const { userPreferences, ...rest } = project;
	return { ...rest, isFavorite: userPreferences[0]?.favoritedAt != null };
}

function buildProjectAccessWhere(
	projectId: string,
	userId: string,
	organizationId?: string,
): Prisma.ProjectWhereInput {
	return {
		id: projectId,
		organizationId: organizationId || null,
		OR: [
			{ userId },
			{
				members: {
					some: {
						userId,
						acceptedAt: { not: null },
						OR: [
							{ expiresAt: null },
							{ expiresAt: { gt: new Date() } },
						],
					},
				},
			},
		],
	};
}

/**
 * Lightweight project access lookup for authorization gates.
 *
 * Callers that only need to prove access or persist the project's tenant ID
 * must not pay for the project-detail relation inventory.
 */
export async function getProjectAccessById(
	projectId: string,
	userId: string,
	organizationId?: string,
): Promise<Pick<Project, "id" | "organizationId"> | null> {
	return await db.project.findFirst({
		where: buildProjectAccessWhere(projectId, userId, organizationId),
		select: {
			id: true,
			organizationId: true,
		},
	});
}

/** Lightweight scalar project summary for callers that do not need relations. */
export async function getProjectSummaryById(
	projectId: string,
	userId: string,
	organizationId?: string,
): Promise<Pick<
	Project,
	| "id"
	| "name"
	| "description"
	| "status"
	| "heroEmojis"
	| "createdAt"
	| "updatedAt"
> | null> {
	return await db.project.findFirst({
		where: buildProjectAccessWhere(projectId, userId, organizationId),
		select: {
			id: true,
			name: true,
			description: true,
			status: true,
			heroEmojis: true,
			createdAt: true,
			updatedAt: true,
		},
	});
}

/**
 * Get project by ID with authorization check
 * Enforces strict project-level access control:
 * - Personal projects: owner or accepted project members can access
 * - Organization projects: owner or accepted project members can access (requires org membership)
 *
 * Note: Organization membership alone does NOT grant access to projects.
 */
export async function getProjectById(
	projectId: string,
	userId: string,
	organizationId?: string,
) {
	const project = await db.project.findFirst({
		where: buildProjectAccessWhere(projectId, userId, organizationId),
		include: {
			// The overview computes status counts and its six-card pipeline from
			// this inventory. Fetch every small row so those counts stay exact,
			// but never transfer the unbounded document body.
			documents: {
				orderBy: { createdAt: "desc" },
				select: {
					id: true,
					type: true,
					title: true,
					status: true,
					isActive: true,
				},
			},
			// Only the edit wizard consumes contexts from projects.get, and it
			// hydrates Teams/Notion integrations. Code, file, transcript, and URL
			// rows (especially their content bodies) belong to contexts.list.
			contexts: {
				where: { type: "INTEGRATION" },
				orderBy: { createdAt: "desc" },
				select: {
					id: true,
					type: true,
					sourceTitle: true,
					sourceUrl: true,
					metadata: true,
				},
			},
			repositoryIntegrations: {
				select: {
					id: true,
					status: true,
					provider: true,
					repositoryOwner: true,
					repositoryName: true,
				},
			},
			// Caller-scoped favorite state (#1694) — see listProjects.
			userPreferences: {
				where: { userId },
				select: { favoritedAt: true },
				take: 1,
			},
			_count: {
				select: {
					documents: true,
					contexts: {
						where: { importedDocuments: { none: {} } },
					},
				},
			},
		},
	});
	return project ? withFavoriteFlag(project) : null;
}

/**
 * Preserve the original public v1 project-detail response shape.
 *
 * Unlike internal project views, the versioned external endpoint historically
 * embedded every document and context field. Keep that compatibility boundary
 * explicit so internal callers cannot accidentally reintroduce this expensive
 * relation load on normal project-page traffic.
 */
export async function getProjectByIdForExternalApi(
	projectId: string,
	userId: string,
	organizationId?: string,
) {
	const project = await db.project.findFirst({
		where: buildProjectAccessWhere(projectId, userId, organizationId),
		include: {
			documents: {
				orderBy: { createdAt: "desc" },
			},
			contexts: {
				orderBy: { createdAt: "desc" },
			},
			...(organizationId
				? {}
				: {
						repositoryIntegrations: {
							select: {
								id: true,
								status: true,
								provider: true,
								repositoryOwner: true,
								repositoryName: true,
							},
						},
					}),
			userPreferences: {
				where: { userId },
				select: { favoritedAt: true },
				take: 1,
			},
			_count: {
				select: {
					documents: true,
					contexts: {
						where: { importedDocuments: { none: {} } },
					},
				},
			},
		},
	});

	return project ? withFavoriteFlag(project) : null;
}

/**
 * Get just the project name by ID (lightweight query for breadcrumbs, etc.)
 * Same authorization as getProjectById but only fetches the name field.
 */
export async function getProjectNameById(
	projectId: string,
	userId: string,
	organizationId?: string,
): Promise<string | null> {
	const project = await db.project.findFirst({
		where: buildProjectAccessWhere(projectId, userId, organizationId),
		select: { name: true },
	});

	return project?.name ?? null;
}

/**
 * List projects for a user with pagination
 * Enforces strict project-level access control:
 * - When organizationId is provided: show only projects user owns OR is an accepted member of
 * - When organizationId is NOT provided: only show personal projects owned by the user
 *
 * Note: Organization membership alone does NOT grant visibility to projects.
 */
export async function listProjects(options: {
	userId: string;
	organizationId?: string;
	limit?: number;
	offset?: number;
	status?: ProjectStatus;
	search?: string;
	deletedOnly?: boolean;
	includeDeleted?: boolean;
	includeDraft?: boolean;
	includeStatusCounts?: boolean;
}) {
	const {
		userId,
		organizationId,
		limit = 10,
		offset = 0,
		status,
		search,
		deletedOnly = false,
		includeDeleted = false,
		includeDraft = false,
		includeStatusCounts = false,
	} = options;

	// For organization context, verify user is a member OR a project-scoped
	// guest (accepted ProjectMember row on at least one project in the org).
	// Guests see only the projects they were invited to — that filtering
	// happens in the accessFilter below.
	if (organizationId) {
		const [membership, guestAccess] = await Promise.all([
			db.member.findFirst({
				where: { organizationId, userId },
				select: { id: true },
			}),
			db.projectMember.findFirst({
				where: {
					userId,
					acceptedAt: { not: null },
					OR: [
						{ expiresAt: null },
						{ expiresAt: { gt: new Date() } },
					],
					project: { organizationId },
				},
				select: { id: true },
			}),
		]);

		if (!membership && !guestAccess) {
			return {
				projects: [],
				total: 0,
				hasMore: false,
				nextOffset: undefined,
			};
		}
	}

	// Build where clause based on context
	// For org context: only show projects user owns OR is an accepted member of
	// For personal context: only show personal projects user owns OR is an accepted member of
	const accessFilter: Prisma.ProjectWhereInput = organizationId
		? {
				organizationId,
				OR: [
					{ userId }, // User is owner
					{
						members: {
							some: {
								userId,
								acceptedAt: { not: null },
								OR: [
									{ expiresAt: null },
									{ expiresAt: { gt: new Date() } },
								],
							},
						},
					},
				],
			}
		: {
				organizationId: null,
				OR: [
					{ userId }, // User is owner
					{
						members: {
							some: {
								userId,
								acceptedAt: { not: null },
								OR: [
									{ expiresAt: null },
									{ expiresAt: { gt: new Date() } },
								],
							},
						},
					},
				],
			};

	// Build owner-only access clause (creator or accepted OWNER membership)
	const ownerAccessFilter: Prisma.ProjectWhereInput = organizationId
		? {
				organizationId,
				OR: [
					{ userId },
					{
						members: {
							some: {
								userId,
								role: "OWNER",
								acceptedAt: { not: null },
								OR: [
									{ expiresAt: null },
									{ expiresAt: { gt: new Date() } },
								],
							},
						},
					},
				],
			}
		: {
				organizationId: null,
				OR: [
					{ userId },
					{
						members: {
							some: {
								userId,
								role: "OWNER",
								acceptedAt: { not: null },
								OR: [
									{ expiresAt: null },
									{ expiresAt: { gt: new Date() } },
								],
							},
						},
					},
				],
			};

	// Build deleted filter based on options
	const deletedFilter: Prisma.ProjectWhereInput = deletedOnly
		? { deletedAt: { not: null } }
		: includeDeleted
			? {}
			: { deletedAt: null };

	const searchFilter: Prisma.ProjectWhereInput = search
		? {
				AND: [
					{
						OR: [
							{
								name: {
									contains: search,
									mode: "insensitive",
								},
							},
							{
								description: {
									contains: search,
									mode: "insensitive",
								},
							},
							{ tags: { has: search } },
						],
					},
				],
			}
		: {};

	const where: Prisma.ProjectWhereInput = {
		...accessFilter,
		...deletedFilter,
		// Default: exclude DRAFT projects unless caller explicitly requests a specific status
		...(status
			? { status }
			: includeDraft
				? {}
				: { status: { not: "DRAFT" } }),
		...searchFilter,
	};

	// Also count deleted projects for the UI badge
	const deletedCountFilter: Prisma.ProjectWhereInput = {
		...accessFilter,
		deletedAt: { not: null },
	};

	const ownerDeletedCountFilter: Prisma.ProjectWhereInput = {
		...ownerAccessFilter,
		deletedAt: { not: null },
	};

	// Per-status counts for the filter tabs (opt-in): ONE grouped query that
	// reuses the same access scope + search as the list and ignores the active
	// status filter. Replaces the client firing one list query per tab just to
	// read a count. Reuses `accessFilter` so scoping is identical (no separate
	// hand-written tenant filter).
	const statusCountsFilter: Prisma.ProjectWhereInput = {
		...accessFilter,
		deletedAt: null,
		...searchFilter,
	};

	const [projects, total, deletedCount, ownerDeletedCount, statusGroups] =
		await Promise.all([
			db.project.findMany({
				where,
				include: {
					organization: {
						select: {
							id: true,
							slug: true,
							name: true,
						},
					},
					members: {
						where: {
							userId,
							acceptedAt: { not: null },
							OR: [
								{ expiresAt: null },
								{ expiresAt: { gt: new Date() } },
							],
						},
						select: {
							role: true,
						},
					},
					// Quick-access favorite state (#1694). Scoped to the CALLER —
					// an unfiltered relation would return every member's
					// preference rows and leak per-user state through a list
					// endpoint that only checks project read access.
					userPreferences: {
						where: { userId },
						select: { favoritedAt: true },
						take: 1,
					},
					_count: {
						select: {
							documents: true,
							contexts: {
								where: { importedDocuments: { none: {} } },
							},
						},
					},
				},
				orderBy: deletedOnly
					? { deletedAt: "desc" }
					: { updatedAt: "desc" },
				take: limit,
				skip: offset,
			}),
			db.project.count({ where }),
			db.project.count({ where: deletedCountFilter }),
			db.project.count({ where: ownerDeletedCountFilter }),
			includeStatusCounts
				? db.project.groupBy({
						by: ["status"],
						where: statusCountsFilter,
						_count: true,
					})
				: Promise.resolve(
						[] as { status: ProjectStatus; _count: number }[],
					),
		]);

	const statusCounts: Record<string, number> = {};
	for (const group of statusGroups) {
		statusCounts[group.status] = group._count;
	}

	return {
		// Flatten the caller-scoped preference row into a plain boolean so no
		// consumer has to know the relation exists, and so the row never carries
		// another user's state off the server.
		projects: projects.map(withFavoriteFlag),
		total,
		deletedCount,
		ownerDeletedCount,
		statusCounts,
		hasMore: offset + limit < total,
		nextOffset: offset + limit < total ? offset + limit : undefined,
	};
}

/**
 * Update project
 * Enforces strict isolation between personal and organizational projects
 *
 * Access control:
 * - Original creator (project.userId) can always update
 * - Project members with OWNER or EDITOR role can update
 *
 * IMPORTANT: Callers should verify edit access via `requireProjectPermission`
 * middleware with the appropriate permission key before calling.
 * This function enforces tenant isolation but trusts that access has been verified.
 */
export async function updateProject(
	projectId: string,
	_userId: string,
	data: {
		name?: string;
		description?: string;
		/** null clears the phase, returning the project to unjudged (#2165). */
		projectPhase?: "DISCOVERY_PLANNING" | "DEVELOPMENT_EXECUTION" | null;
		expectedDevelopmentStartDate?: Date | null;
		goals?: string;
		techStack?: string[];
		features?: string[];
		projectTypes?: string[];
		status?: ProjectStatus;
		tags?: string[];
		color?: string;
		icon?: string;
		// SECURITY: projectManagementMcpServerId is the preferred field (each user uses their own config)
		projectManagementMcpServerId?: string | null;
		projectManagementMcpConfigId?: string | null; // @deprecated - kept for migration
		projectManagementContainerId?: string | null;
		projectManagementContainerName?: string | null;
		projectManagementAdditionalContext?: any;
		prdSourceTitle?: string | null;
		prdSourceUrl?: string | null;
		// GitHub Repository defaults for code tasks
		repositoryUrl?: string | null;
		repositoryOwner?: string | null;
		repositoryName?: string | null;
		defaultBranch?: string | null;
		implementationDefaultChannel?:
			| "BACKGROUND_AGENTS"
			| "LOCAL_AGENTS"
			| null;
		implementationDefaultProvider?:
			| "BACKGROUND_AGENTS"
			| "KANBAN_LOCAL"
			| null;
		implementationDefaultWorkingDirectory?: string | null;
		// Website URLs (project-level context for AI)
		primaryWebsiteUrl?: string | null;
		additionalWebsiteUrls?: string[];
		// ADO state polling
		adoStatePollActive?: boolean;
		// Auto-push PM sync: push status changes to PM tool on Kanban move
		autoPushPmSync?: boolean;
		// Project-level Read-only mode: blocks outbound writes
		// to connected external sources while enabled
		readOnlyMode?: boolean;
		// Per-project attachment-sync opt-in (Fizzy #1746)
		syncAttachments?: boolean;
		// PM terminal-status auto-close (card #1360 Phase A)
		pmAutoCloseEnabled?: boolean;
		// PM custom field read-mapping feature flag
		pmFieldMappingEnabled?: boolean;
		// AI Assistant clarifying-question frequency (MINIMAL/BALANCED/THOROUGH)
		clarifyingQuestionFrequency?: ClarifyingQuestionFrequency;
		// QA test-case generation settings
		generateManualTestCases?: boolean;
		applyTddApproach?: boolean;
		// Feature Maturation V2 — Project-level hidden stages configuration
		hiddenMaturationStatuses?: string[];
		// Wizard ephemera; nulled on DRAFT → ACTIVE activation
		wizardState?: Prisma.NullableJsonNullValueInput | Prisma.InputJsonValue;
	},
	organizationId?: string,
) {
	// Authorization is enforced upstream (e.g. `requireProjectPermission` in
	// oRPC procedures, `requireScope` + tenant check in the v1 REST API,
	// `canEditProject` in the MCP gateway). The WHERE clause here only
	// enforces tenant isolation — the project must exist in the caller's XOR
	// tenant context (personal vs. organization). Duplicating role checks
	// here previously caused drift from the permission map and surfaced as
	// spurious 500s for legitimately-authorized callers (e.g. PROJECT_ADMIN).
	const orgFilter = organizationId
		? { organizationId }
		: { organizationId: null };

	// Translate `null` → Prisma.JsonNull for the nullable JSON column. Prisma
	// rejects a bare `null` on Json columns and requires the sentinel; callers
	// pass `null` to clear the column when switching PM providers.
	const { projectManagementAdditionalContext, ...rest } = data;
	const updateData: Prisma.ProjectUpdateInput = { ...rest };
	if (projectManagementAdditionalContext !== undefined) {
		updateData.projectManagementAdditionalContext =
			projectManagementAdditionalContext === null
				? Prisma.JsonNull
				: projectManagementAdditionalContext;
	}

	return await db.project.update({
		where: {
			id: projectId,
			...orgFilter,
		},
		data: updateData,
	});
}

/**
 * Soft delete a project
 * Sets deletedAt, deletedBy, and schedules permanent deletion 7 days from now
 * Enforces strict isolation between personal and organizational projects
 */
export async function softDeleteProject(
	projectId: string,
	userId: string,
	organizationId?: string,
) {
	// Strict isolation: if no organizationId, only allow deleting personal projects
	// Allows original creator OR promoted owners (ProjectMember with OWNER role)
	const orgFilter = organizationId
		? { organizationId }
		: { organizationId: null };

	const now = new Date();
	const scheduledDeletion = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days

	return await db.project.update({
		where: {
			id: projectId,
			...orgFilter,
			OR: [
				{ userId },
				{
					members: {
						some: {
							userId,
							role: "OWNER",
							acceptedAt: { not: null },
							OR: [
								{ expiresAt: null },
								{ expiresAt: { gt: new Date() } },
							],
						},
					},
				},
			],
		},
		data: {
			deletedAt: now,
			deletedBy: userId,
			scheduledPermanentDeleteAt: scheduledDeletion,
		},
	});
}

/**
 * Restore a soft-deleted project
 * Clears deletedAt, deletedBy, and scheduledPermanentDeleteAt
 * Enforces strict isolation between personal and organizational projects
 * Defensive ownership check ensures only the project owner or org members can restore
 */
export async function restoreProject(
	projectId: string,
	userId: string,
	organizationId?: string,
) {
	// Strict isolation: if no organizationId, only allow restoring personal projects
	// Allows original creator OR promoted owners (ProjectMember with OWNER role)
	const orgFilter = organizationId
		? { organizationId }
		: { organizationId: null };

	return await db.project.update({
		where: {
			id: projectId,
			...orgFilter,
			deletedAt: { not: null }, // Can only restore deleted projects
			OR: [
				{ userId },
				{
					members: {
						some: {
							userId,
							role: "OWNER",
							acceptedAt: { not: null },
							OR: [
								{ expiresAt: null },
								{ expiresAt: { gt: new Date() } },
							],
						},
					},
				},
			],
		},
		data: {
			deletedAt: null,
			deletedBy: null,
			scheduledPermanentDeleteAt: null,
			deletionReminderSentAt: null,
		},
	});
}

/**
 * Permanently delete project (hard delete)
 * Cascade deletes documents and contexts
 * Used by scheduled cleanup workflow and manual permanent delete
 *
 * Includes guard to ensure project is still soft-deleted to prevent race condition
 * where user restores project after cleanup workflow fetches it but before delete executes
 */
export async function permanentDeleteProject(
	projectId: string,
	requireSoftDeleted = true,
) {
	const whereClause = requireSoftDeleted
		? {
				id: projectId,
				deletedAt: { not: null }, // Guard: only delete if still soft-deleted
			}
		: { id: projectId };

	return await db.project.delete({
		where: whereClause,
	});
}

/**
 * Get projects ready for permanent deletion
 * Returns projects where scheduledPermanentDeleteAt <= now
 */
export async function getProjectsReadyForPermanentDeletion(batchSize = 100) {
	const now = new Date();

	return await db.project.findMany({
		where: {
			deletedAt: { not: null },
			scheduledPermanentDeleteAt: { lte: now },
		},
		select: {
			id: true,
			name: true,
			userId: true,
			organizationId: true,
		},
		take: batchSize,
		orderBy: { scheduledPermanentDeleteAt: "asc" },
	});
}

/**
 * Get projects that need deletion reminder (expiring within 24-48 hours, no reminder sent yet)
 */
export async function getProjectsNeedingDeletionReminder(batchSize = 100) {
	const now = new Date();
	const in24Hours = new Date(now.getTime() + 24 * 60 * 60 * 1000);
	const in48Hours = new Date(now.getTime() + 48 * 60 * 60 * 1000);

	return await db.project.findMany({
		where: {
			deletedAt: { not: null },
			scheduledPermanentDeleteAt: {
				gt: in24Hours,
				lte: in48Hours,
			},
			deletionReminderSentAt: null,
		},
		select: {
			id: true,
			name: true,
			userId: true,
			organizationId: true,
			scheduledPermanentDeleteAt: true,
			user: {
				select: {
					email: true,
					name: true,
				},
			},
		},
		take: batchSize,
		orderBy: { scheduledPermanentDeleteAt: "asc" },
	});
}

/**
 * Mark deletion reminder as sent for a project
 */
export async function markDeletionReminderSent(projectId: string) {
	return await db.project.update({
		where: { id: projectId },
		data: { deletionReminderSentAt: new Date() },
	});
}

/**
 * Legacy delete project function - now calls permanentDeleteProject
 * @deprecated Use softDeleteProject for user-initiated deletes, permanentDeleteProject for cleanup
 */
export async function deleteProject(
	projectId: string,
	userId: string,
	organizationId?: string,
) {
	// Strict isolation: if no organizationId, only allow deleting personal projects
	const orgFilter = organizationId
		? { organizationId }
		: { organizationId: null };

	return await db.project.delete({
		where: {
			id: projectId,
			userId,
			...orgFilter,
		},
	});
}

/**
 * Get project statistics
 * Enforces strict isolation between personal and organizational projects
 */
export async function getProjectStats(userId: string, organizationId?: string) {
	// Strict isolation: if no organizationId, only count personal projects
	const orgFilter = organizationId
		? { organizationId }
		: { organizationId: null };

	const where: Prisma.ProjectWhereInput = {
		userId,
		...orgFilter,
	};

	const [total, active, completed, archived] = await Promise.all([
		db.project.count({ where }),
		db.project.count({ where: { ...where, status: "ACTIVE" } }),
		db.project.count({ where: { ...where, status: "COMPLETED" } }),
		db.project.count({ where: { ...where, status: "ARCHIVED" } }),
	]);

	return {
		total,
		active,
		completed,
		archived,
		draft: total - active - completed - archived,
	};
}

/**
 * Check if user has access to project
 *
 * Access is granted if:
 * 1. For personal projects: User is the project owner OR accepted project member
 * 2. For org projects: User is org member AND (project owner OR project member)
 *
 * SECURITY: For organization projects, we verify org membership first.
 * This ensures users removed from an org lose access to all org projects.
 */
export async function hasProjectAccess(
	projectId: string,
	userId: string,
	_organizationId?: string,
): Promise<boolean> {
	const project = await db.project.findFirst({
		where: {
			id: projectId,
		},
		select: {
			id: true,
			userId: true,
			organizationId: true,
		},
	});

	if (!project) {
		return false;
	}

	// Personal projects (no organizationId) - owner or accepted project member can access
	if (!project.organizationId) {
		// Owner has access
		if (project.userId === userId) {
			return true;
		}

		// Check if user is a project member (collaborator)
		const projectMembership = await db.projectMember.findFirst({
			where: {
				projectId,
				userId,
				acceptedAt: { not: null },
				OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
			},
			select: { id: true },
		});

		return !!projectMembership;
	}

	// Organization project — two paths:
	//  (a) Caller is an OrgMember of the host org AND either owns the
	//      project or has an accepted ProjectMember row.
	//  (b) Caller is a project-scoped guest: no OrgMember row, but an
	//      accepted ProjectMember row. This is the external-guest path.
	const [orgMembership, projectMembership] = await Promise.all([
		db.member.findFirst({
			where: {
				organizationId: project.organizationId,
				userId,
			},
			select: { id: true },
		}),
		db.projectMember.findFirst({
			where: {
				projectId,
				userId,
				acceptedAt: { not: null },
				OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
			},
			select: { id: true },
		}),
	]);

	if (orgMembership) {
		if (project.userId === userId) {
			return true;
		}
		return !!projectMembership;
	}

	// No OrgMember — allow only if this is an accepted project-scoped
	// guest. The caller is never the project owner here (owners always
	// belong to the host org).
	return !!projectMembership;
}

/**
 * Legacy lowercase project role string. Retained for backward compatibility
 * with call sites written before `PROJECT_ADMIN` and `COMMENTER` were added
 * in migration `project_member_roles`. New call sites should use the typed
 * helpers in `@repo/permissions` and the `requireProjectPermission`
 * middleware — see plan at `.claude/plans/run-all-mirgrations-snug-clock.md`.
 */
export type LegacyProjectRole =
	| "owner"
	| "project_admin"
	| "editor"
	| "commenter"
	| "viewer";

/**
 * Get user's role in a project.
 *
 * SECURITY: For organization projects, we verify org membership first.
 * This ensures users removed from an org have no role in org projects.
 *
 * @deprecated Use `getProjectMemberRole` for new code — it returns the real
 * `ProjectMemberRole` enum instead of a lowercased string. This legacy
 * helper is retained only for `get-project`'s display field until the
 * frontend client is migrated (plan Phase 6).
 */
export async function getProjectRole(
	projectId: string,
	userId: string,
): Promise<LegacyProjectRole | null> {
	const project = await db.project.findFirst({
		where: { id: projectId },
		select: { userId: true, organizationId: true },
	});

	if (!project) {
		return null;
	}

	// Personal projects - owner or accepted project member has access
	if (!project.organizationId) {
		// Owner has full access
		if (project.userId === userId) {
			return "owner";
		}

		// Check project membership
		const projectMembership = await db.projectMember.findFirst({
			where: {
				projectId,
				userId,
				acceptedAt: { not: null },
				OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
			},
			select: { role: true },
		});

		if (projectMembership) {
			return projectMembership.role.toLowerCase() as LegacyProjectRole;
		}

		return null;
	}

	// Organization project - MUST verify org membership first
	const orgMembership = await db.member.findFirst({
		where: {
			organizationId: project.organizationId,
			userId,
		},
		select: { id: true },
	});

	if (!orgMembership) {
		// User is not a member of the organization - no role
		return null;
	}

	// User is org member - check project-level role
	// Owner has full access
	if (project.userId === userId) {
		return "owner";
	}

	// Check project membership
	const projectMembership = await db.projectMember.findFirst({
		where: {
			projectId,
			userId,
			acceptedAt: { not: null },
			OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
		},
		select: { role: true },
	});

	if (projectMembership) {
		return projectMembership.role.toLowerCase() as LegacyProjectRole;
	}

	return null;
}

/**
 * Return the caller's role on a project as the uppercase `ProjectMemberRole`
 * enum, or `null` if they have no access.
 *
 * Use this for display purposes (e.g., showing "Role: Project Admin" in the
 * UI). DO NOT use it for authorization — route authorization through the
 * `requireProjectPermission` middleware and `@repo/permissions`.
 *
 * For personal projects: the project owner always resolves to `OWNER`.
 * For organization projects: org membership is verified first (removed org
 * members get `null` even if a stale `ProjectMember` row exists).
 */
export async function getProjectMemberRole(
	projectId: string,
	userId: string,
): Promise<ProjectMemberRole | null> {
	const project = await db.project.findFirst({
		where: { id: projectId },
		select: { userId: true, organizationId: true },
	});
	if (!project) {
		return null;
	}

	if (project.organizationId) {
		const orgMembership = await db.member.findFirst({
			where: { organizationId: project.organizationId, userId },
			select: { id: true },
		});
		if (!orgMembership) {
			return null;
		}
	}

	if (project.userId === userId) {
		return ProjectMemberRole.OWNER;
	}

	const projectMembership = await db.projectMember.findFirst({
		where: {
			projectId,
			userId,
			acceptedAt: { not: null },
			OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
		},
		select: { role: true },
	});

	return projectMembership?.role ?? null;
}

/**
 * A caller's standing on a project: which organization hosts it RIGHT NOW,
 * what the caller may do there, and which path said so.
 *
 * The organization id is read fresh from the row on every call. That is the
 * half a background caller needs and a request-time caller does not: a queued
 * job carries the organization it was authorized under, and only a fresh read
 * can tell whether the project still belongs to it.
 */
export interface ProjectAccess {
	/** The project's host organization RIGHT NOW, or null for a personal one. */
	organizationId: string | null;
	/** What the caller may do, by the path that granted it. */
	permissions: readonly Permission[];
	/** Which path granted them. `"owner"` is a short-circuit — see below. */
	source: "owner" | "project-member" | "org" | "none";
}

/**
 * Resolve a caller's effective permissions on a project, with the SAME
 * precedence as `requireProjectPermission`:
 *
 *   A. personal-project owner
 *   C. an active (accepted, non-expired) ProjectMember row is AUTHORITATIVE —
 *      its role alone decides, and the org role is NOT consulted. This is what
 *      makes a per-project demotion (an org admin restricted to Viewer on one
 *      project) actually enforceable.
 *   B. otherwise, the caller's org role on the project's host organization.
 *
 * Returns `null` when the project does not exist.
 *
 * ## Callers must apply the owner short-circuit themselves
 *
 * This returns a permission SET, and a set is not the gate's answer. The gate
 * passes a personal-project owner unconditionally — see `assertProjectPermission`
 * in `packages/api/orpc/middleware/require-permission.ts`, which returns early
 * on `source === "owner"` because an owner is authorized for ANY project
 * permission, including ones outside the OWNER set. No project role grants
 * `AGENT_CREATE`/`AGENT_UPDATE`/`AGENT_DELETE`, so a caller that writes
 * `hasPermission(access.permissions, AGENT_CREATE)` and stops there answers
 * "no" where the gate answers "yes".
 *
 * So the shape to copy is:
 *
 *   access.source === "owner" || hasPermission(access.permissions, P)
 *
 * ## Why this exists next to the authority instead of importing it
 *
 * `resolveEffectiveProjectPermissions` (`@repo/api`) is the authority for
 * request-time decisions. `@repo/api` depends on `@repo/database` and not the
 * reverse, so background callers — Temporal activities, MCP tools, route
 * handlers — cannot import it, and the ladder gets written out again. It is
 * written out four times today; this is the one that background callers can
 * share, and `canEditProject` / `canCreateProjectStory` directly above are the
 * two that should be folded into it next.
 *
 * The fetch is deliberately SERIAL where the authority's is parallel: path A
 * returns before the ProjectMember lookup is issued at all. The authority runs
 * on every project-scoped request and trades one discarded point-lookup for a
 * round trip; a background caller runs once per job, where that trade buys
 * nothing — and `can-edit-project-precedence.test.ts` asserts the lookup does
 * not happen on the owner path.
 */
export async function resolveProjectAccess(
	projectId: string,
	userId: string,
): Promise<ProjectAccess | null> {
	const project = await db.project.findUnique({
		where: { id: projectId },
		select: { userId: true, organizationId: true },
	});
	if (!project) {
		return null;
	}

	// Path A
	if (project.userId === userId && project.organizationId === null) {
		return {
			organizationId: null,
			permissions: resolveProjectPermissions(ProjectMemberRole.OWNER),
			source: "owner",
		};
	}

	// Path C — checked BEFORE Path B so a per-project demotion is honored.
	const member = await db.projectMember.findUnique({
		where: { projectId_userId: { projectId, userId } },
		select: { role: true, acceptedAt: true, expiresAt: true },
	});
	const memberActive =
		member !== null &&
		member.acceptedAt !== null &&
		(member.expiresAt === null || member.expiresAt > new Date());
	if (memberActive) {
		return {
			organizationId: project.organizationId,
			permissions: resolveProjectPermissions(member.role),
			source: "project-member",
		};
	}

	// Path B — fallback to org role when no active project-level row exists.
	if (project.organizationId) {
		const orgMember = await db.member.findFirst({
			where: { organizationId: project.organizationId, userId },
			select: { role: true },
		});
		if (orgMember) {
			return {
				organizationId: project.organizationId,
				permissions: resolveOrgPermissions(orgMember.role),
				source: "org",
			};
		}
	}

	return {
		organizationId: project.organizationId,
		permissions: [],
		source: "none",
	};
}

/**
 * Returns `true` if `userId` may edit `projectId`, matching the
 * authorization paths of `requireProjectPermission(PROJECT_UPDATE)`.
 *
 * For non-oRPC surfaces (Next.js route handlers, MCP gateway, etc.) that
 * cannot use the middleware directly. oRPC procedures should still prefer
 * `requireProjectPermission`.
 *
 * Resolution order mirrors the middleware exactly:
 *   A. Personal-project owner.
 *   C. Active ProjectMember row (accepted, non-expired) is authoritative —
 *      its role alone determines access, even if the org role would grant
 *      more. This is what makes a per-project demotion (e.g. org admin
 *      restricted to Viewer on a specific project) actually enforceable.
 *   B. Fallback: caller is an OrgMember of the project's host org AND that
 *      org role grants the permission. Only consulted when there is no
 *      active project-level row.
 */
export async function canEditProject(
	projectId: string,
	userId: string,
): Promise<boolean> {
	const project = await db.project.findUnique({
		where: { id: projectId },
		select: { userId: true, organizationId: true },
	});
	if (!project) {
		return false;
	}

	// Path A
	if (project.userId === userId && project.organizationId === null) {
		return true;
	}

	// Path C — checked BEFORE Path B so a per-project demotion is honored.
	const member = await db.projectMember.findUnique({
		where: { projectId_userId: { projectId, userId } },
		select: { role: true, acceptedAt: true, expiresAt: true },
	});
	const memberActive =
		member !== null &&
		member.acceptedAt !== null &&
		(member.expiresAt === null || member.expiresAt > new Date());
	if (memberActive) {
		return hasPermission(
			resolveProjectPermissions(member.role),
			Permissions.PROJECT_UPDATE,
		);
	}

	// Path B — fallback to org role when no active project-level row exists.
	if (project.organizationId) {
		const orgMember = await db.member.findFirst({
			where: { organizationId: project.organizationId, userId },
			select: { role: true },
		});
		if (
			orgMember &&
			hasPermission(
				resolveOrgPermissions(orgMember.role),
				Permissions.PROJECT_UPDATE,
			)
		) {
			return true;
		}
	}

	return false;
}

/**
 * Returns `true` if `userId` may create stories on `projectId`, matching the
 * authorization paths of `requireProjectPermission(STORY_CREATE)`.
 *
 * For non-oRPC surfaces (agent built-in tools, MCP gateway, etc.) that
 * cannot use the middleware directly.
 *
 * Resolution order mirrors the middleware exactly:
 *   A. Personal-project owner.
 *   C. Active ProjectMember row (accepted, non-expired) is authoritative —
 *      its role alone determines access, even if the org role would grant
 *      more. This is what makes a per-project demotion (e.g. org admin
 *      restricted to Viewer on a specific project) actually enforceable.
 *   B. Fallback: caller is an OrgMember of the project's host org AND that
 *      org role grants the permission. Only consulted when there is no
 *      active project-level row.
 */
export async function canCreateProjectStory(
	projectId: string,
	userId: string,
): Promise<boolean> {
	const project = await db.project.findUnique({
		where: { id: projectId },
		select: { userId: true, organizationId: true },
	});
	if (!project) {
		return false;
	}

	// Path A
	if (project.userId === userId && project.organizationId === null) {
		return true;
	}

	// Path C — checked BEFORE Path B so a per-project demotion is honored.
	const member = await db.projectMember.findUnique({
		where: { projectId_userId: { projectId, userId } },
		select: { role: true, acceptedAt: true, expiresAt: true },
	});
	const memberActive =
		member !== null &&
		member.acceptedAt !== null &&
		(member.expiresAt === null || member.expiresAt > new Date());
	if (memberActive) {
		return hasPermission(
			resolveProjectPermissions(member.role),
			Permissions.STORY_CREATE,
		);
	}

	// Path B — fallback to org role when no active project-level row exists.
	if (project.organizationId) {
		const orgMember = await db.member.findFirst({
			where: { organizationId: project.organizationId, userId },
			select: { role: true },
		});
		if (
			orgMember &&
			hasPermission(
				resolveOrgPermissions(orgMember.role),
				Permissions.STORY_CREATE,
			)
		) {
			return true;
		}
	}

	return false;
}

/**
 * Upsert a DRAFT project by client-generated draftKey (idempotent)
 * Uses XOR tenant isolation: personal (organizationId IS NULL) vs org context
 */
export async function upsertDraftProjectByKey(data: {
	draftKey: string;
	name: string;
	userId: string;
	organizationId?: string | null;
	description?: string;
	techStack?: string[];
	features?: string[];
	projectTypes?: string[];
	tags?: string[];
	icon?: string;
	color?: string;
	goals?: string;
	wizardState?: Prisma.InputJsonValue;
	repositoryUrl?: string | null;
	repositoryOwner?: string | null;
	repositoryName?: string | null;
	defaultBranch?: string | null;
	projectManagementMcpServerId?: string | null;
	projectManagementMcpConfigId?: string | null;
	projectManagementContainerId?: string | null;
	projectManagementContainerName?: string | null;
	projectManagementAdditionalContext?: Prisma.InputJsonValue;
}): Promise<{ project: Project; created: boolean }> {
	const orgId = data.organizationId ?? null;

	// Build a partial update payload from defined fields only. `undefined` means
	// "don't touch this column"; defined values (including null on nullable cols)
	// overwrite. Shared between the existing-draft branch and the P2002 race branch.
	const buildUpdateData = (): Prisma.ProjectUpdateInput => {
		const updateData: Prisma.ProjectUpdateInput = {
			name: data.name,
			updatedAt: new Date(),
		};
		if (data.description !== undefined) {
			updateData.description = data.description;
		}
		if (data.techStack !== undefined) {
			updateData.techStack = data.techStack;
		}
		if (data.features !== undefined) {
			updateData.features = data.features;
		}
		if (data.projectTypes !== undefined) {
			updateData.projectTypes = data.projectTypes;
		}
		if (data.tags !== undefined) {
			updateData.tags = data.tags;
		}
		if (data.icon !== undefined) {
			updateData.icon = data.icon;
		}
		if (data.color !== undefined) {
			updateData.color = data.color;
		}
		if (data.goals !== undefined) {
			updateData.goals = data.goals;
		}
		if (data.wizardState !== undefined) {
			updateData.wizardState = data.wizardState;
		}
		if (data.repositoryUrl !== undefined) {
			updateData.repositoryUrl = data.repositoryUrl;
		}
		if (data.repositoryOwner !== undefined) {
			updateData.repositoryOwner = data.repositoryOwner;
		}
		if (data.repositoryName !== undefined) {
			updateData.repositoryName = data.repositoryName;
		}
		if (data.defaultBranch !== undefined) {
			updateData.defaultBranch = data.defaultBranch;
		}
		if (data.projectManagementMcpServerId !== undefined) {
			updateData.projectManagementMcpServerId =
				data.projectManagementMcpServerId;
		}
		if (data.projectManagementMcpConfigId !== undefined) {
			updateData.projectManagementMcpConfigId =
				data.projectManagementMcpConfigId;
		}
		if (data.projectManagementContainerId !== undefined) {
			updateData.projectManagementContainerId =
				data.projectManagementContainerId;
		}
		if (data.projectManagementContainerName !== undefined) {
			updateData.projectManagementContainerName =
				data.projectManagementContainerName;
		}
		if (data.projectManagementAdditionalContext !== undefined) {
			updateData.projectManagementAdditionalContext =
				data.projectManagementAdditionalContext;
		}
		return updateData;
	};

	// Check for existing draft first (outside transaction for compatibility with PrismaPg adapter)
	const existingDraft = await db.project.findFirst({
		where: {
			draftKey: data.draftKey,
			userId: data.userId,
			organizationId: orgId,
			status: "DRAFT",
			deletedAt: null,
		},
		orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
	});

	if (existingDraft) {
		const updated = await db.project.update({
			where: { id: existingDraft.id },
			data: buildUpdateData(),
		});
		return { project: updated, created: false };
	}

	// Check for non-draft project with same draftKey (already activated)
	const existingProject = await db.project.findFirst({
		where: {
			draftKey: data.draftKey,
			userId: data.userId,
			organizationId: orgId,
			deletedAt: null,
		},
		orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
	});

	if (existingProject) {
		return { project: existingProject, created: false };
	}

	// Create new draft — unique constraint on (userId, draftKey, organizationId)
	// prevents duplicates; P2002 is caught to handle concurrent autosave races.
	try {
		const created = await db.project.create({
			data: {
				draftKey: data.draftKey,
				name: data.name,
				userId: data.userId,
				organizationId: orgId,
				status: "DRAFT",
				description: data.description,
				techStack: data.techStack ?? [],
				features: data.features ?? [],
				projectTypes: data.projectTypes ?? [],
				tags: data.tags ?? [],
				icon: data.icon,
				color: data.color,
				goals: data.goals,
				wizardState: data.wizardState,
				repositoryUrl: data.repositoryUrl,
				repositoryOwner: data.repositoryOwner,
				repositoryName: data.repositoryName,
				defaultBranch: data.defaultBranch,
				projectManagementMcpServerId: data.projectManagementMcpServerId,
				projectManagementMcpConfigId: data.projectManagementMcpConfigId,
				projectManagementContainerId: data.projectManagementContainerId,
				projectManagementContainerName:
					data.projectManagementContainerName,
				projectManagementAdditionalContext:
					data.projectManagementAdditionalContext,
			},
		});

		return { project: created, created: true };
	} catch (error) {
		if (
			error instanceof Prisma.PrismaClientKnownRequestError &&
			error.code === "P2002"
		) {
			// Race condition: another request created the draft first — update it instead
			const existing = await db.project.findFirst({
				where: {
					draftKey: data.draftKey,
					userId: data.userId,
					organizationId: orgId,
					status: "DRAFT",
					deletedAt: null,
				},
			});

			if (existing) {
				const updated = await db.project.update({
					where: { id: existing.id },
					data: buildUpdateData(),
				});
				return { project: updated, created: false };
			}
		}
		throw error;
	}
}

/**
 * List recent DRAFT projects for a user (for the "Continue draft" banner)
 * Uses XOR tenant isolation
 */
export async function listUserDraftProjects(opts: {
	userId: string;
	organizationId?: string | null;
	limit?: number;
}): Promise<
	Array<{ id: string; name: string; createdAt: Date; updatedAt: Date }>
> {
	const orgId = opts.organizationId ?? null;
	const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

	return await db.project.findMany({
		where: {
			userId: opts.userId,
			organizationId: orgId,
			status: "DRAFT",
			deletedAt: null,
			draftKey: { not: null },
			createdAt: { gte: sevenDaysAgo },
		},
		select: {
			id: true,
			name: true,
			createdAt: true,
			updatedAt: true,
			wizardState: true,
		},
		orderBy: { updatedAt: "desc" },
		take: opts.limit ?? 5,
	});
}
