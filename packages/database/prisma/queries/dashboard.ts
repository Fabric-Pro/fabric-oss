/**
 * Dashboard Statistics Queries
 *
 * Provides aggregated statistics for dashboard views
 */

import { db } from "../client";

function normalizeTaskStatus(status: string | null | undefined): string {
	return status?.toLowerCase() ?? "";
}

interface DashboardConversationMetadata {
	mode?: string;
	executions?: Array<{
		id?: string;
		userMessage?: string;
		routingDecision?: {
			agentName?: string;
		};
		plan?: {
			description?: string;
		};
		status?: string;
		startedAt?: string;
		completedAt?: string;
		error?: string;
	}>;
}

function getConversationExecutionCounts(
	conversations: Array<{
		metadata: unknown;
		createdAt: Date;
		updatedAt: Date;
	}>,
	since?: Date,
): Record<
	"pending" | "running" | "completed" | "failed" | "cancelled",
	number
> {
	const counts = {
		pending: 0,
		running: 0,
		completed: 0,
		failed: 0,
		cancelled: 0,
	};

	for (const conversation of conversations) {
		const metadata = conversation.metadata as
			| DashboardConversationMetadata
			| null
			| undefined;
		const executions = Array.isArray(metadata?.executions)
			? metadata.executions
			: [];

		if (executions.length > 0) {
			for (const execution of executions) {
				const eventDate = execution.startedAt
					? new Date(execution.startedAt)
					: conversation.updatedAt;
				if (since && eventDate < since) {
					continue;
				}

				const normalized = normalizeTaskStatus(execution.status);
				if (normalized === "pending") {
					counts.pending += 1;
				} else if (normalized === "running") {
					counts.running += 1;
				} else if (
					normalized === "completed" ||
					normalized === "complete"
				) {
					counts.completed += 1;
				} else if (normalized === "failed" || normalized === "error") {
					counts.failed += 1;
				} else if (
					normalized === "cancelled" ||
					normalized === "canceled"
				) {
					counts.cancelled += 1;
				} else {
					counts.completed += 1;
				}
			}
			continue;
		}

		if (metadata?.mode === "direct") {
			const eventDate = conversation.updatedAt || conversation.createdAt;
			if (since && eventDate < since) {
				continue;
			}
			counts.completed += 1;
		}
	}

	return counts;
}

function getConversationRecentTasks<
	TUser extends { name?: string | null; image?: string | null } | undefined,
>(
	conversations: Array<{
		id: string;
		agentId: string;
		title?: string | null;
		createdAt: Date;
		updatedAt: Date;
		metadata: unknown;
		user?: TUser;
	}>,
	since?: Date,
): Array<{
	id: string;
	agentId: string;
	status: string;
	stage: string;
	updatedAt: Date;
	createdAt: Date;
	title?: string | null;
	conversationId?: string;
	user?: TUser;
}> {
	const items: Array<{
		id: string;
		agentId: string;
		status: string;
		stage: string;
		updatedAt: Date;
		createdAt: Date;
		title?: string | null;
		conversationId?: string;
		user?: TUser;
	}> = [];

	for (const conversation of conversations) {
		const metadata = conversation.metadata as
			| DashboardConversationMetadata
			| null
			| undefined;
		const executions = Array.isArray(metadata?.executions)
			? metadata.executions
			: [];

		if (executions.length > 0) {
			for (const execution of executions) {
				const startedAt = execution.startedAt
					? new Date(execution.startedAt)
					: conversation.createdAt;
				const updatedAt = execution.completedAt
					? new Date(execution.completedAt)
					: startedAt;

				if (since && updatedAt < since) {
					continue;
				}

				items.push({
					id: `${conversation.id}:${execution.id || execution.startedAt || startedAt.toISOString()}`,
					agentId:
						execution.routingDecision?.agentName ||
						conversation.agentId,
					status: normalizeTaskStatus(execution.status),
					stage:
						execution.plan?.description ||
						(metadata?.mode === "orchestrator"
							? "Orchestrator execution"
							: "Conversation execution"),
					updatedAt,
					createdAt: startedAt,
					title: conversation.title,
					conversationId: conversation.id,
					...(conversation.user ? { user: conversation.user } : {}),
				});
			}
			continue;
		}

		if (metadata?.mode === "direct") {
			const updatedAt = conversation.updatedAt;
			if (since && updatedAt < since) {
				continue;
			}

			items.push({
				id: `conversation:${conversation.id}`,
				agentId: conversation.agentId,
				status: "completed",
				stage: "Direct conversation",
				updatedAt,
				createdAt: conversation.createdAt,
				title: conversation.title,
				conversationId: conversation.id,
				...(conversation.user ? { user: conversation.user } : {}),
			});
		}
	}

	return items;
}

/**
 * Safely run a skill query - returns empty/default if the skill table doesn't exist
 * (e.g. migration not yet applied). Allows dashboard to work before skill migration.
 */
async function safeSkillQuery<T>(
	fn: () => Promise<T>,
	fallback: T,
): Promise<T> {
	try {
		return await fn();
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		// Table may not exist if skill migration hasn't been applied
		if (
			msg.includes("does not exist") ||
			msg.includes('"skill"') ||
			msg.includes("public.skill")
		) {
			return fallback;
		}
		throw e;
	}
}

/**
 * Get comprehensive dashboard statistics for a user
 */
export async function getUserDashboardStats(userId: string, since?: Date) {
	const activityFilter = since ? { createdAt: { gte: since } } : {};
	const [
		projects,
		agents,
		agentTasks,
		conversations,
		mcpConfigs,
		prompts,
		aiChats,
		projectDocuments,
		sdlcPipelines,
		workflows,
		skills,
	] = await Promise.all([
		// Project stats - all personal projects (organizationId: null), exclude soft-deleted
		// No date filter: total count reflects current state, not creation period
		db.project.groupBy({
			by: ["status"],
			where: { userId, organizationId: null, deletedAt: null },
			_count: true,
		}),
		// Agent stats - only user's personal agents (current state)
		db.agent.groupBy({
			by: ["status"],
			where: { userId, organizationId: null },
			_count: true,
		}),
		// Agent task stats - filtered by time range (activity metric)
		db.agentTask.groupBy({
			by: ["status"],
			where: { userId, organizationId: null, ...activityFilter },
			_count: true,
		}),
		db.agentConversation.findMany({
			where: {
				userId,
				organizationId: null,
				...(since ? { updatedAt: { gte: since } } : {}),
			},
			select: {
				metadata: true,
				createdAt: true,
				updatedAt: true,
			},
		}),
		// MCP configs (user's configured MCP servers, not the registry)
		db.mCPConfig.count({
			where: { userId, organizationId: null },
		}),
		// Prompt stats - only user's personal prompts (exclude system prompts to avoid misleading counts)
		db.prompt.count({
			where: { userId, organizationId: null },
		}),
		// AI chat stats - filtered by time range (activity metric)
		db.aiChat.count({
			where: { userId, organizationId: null, ...activityFilter },
		}),
		// Project document stats - all documents from non-deleted projects (current state)
		db.projectDocument.groupBy({
			by: ["status"],
			where: {
				project: {
					userId,
					organizationId: null,
					deletedAt: null,
				},
			},
			_count: true,
		}),
		// SDLC pipeline stats
		db.sDLCPipeline.groupBy({
			by: ["status"],
			where: { userId, organizationId: null },
			_count: true,
		}),
		// Workflow stats
		db.workflow.groupBy({
			by: ["status"],
			where: { userId, organizationId: null },
			_count: true,
		}),
		// Skill stats - USER scope only for personal context
		// Safe: returns 0 if skill table doesn't exist (migration not applied)
		safeSkillQuery(
			() =>
				db.skill.count({
					where: {
						scope: "USER",
						userId,
						organizationId: null,
					},
				}),
			0,
		),
	]);

	// Calculate project statistics
	const projectStats = {
		total: projects.reduce((sum, p) => sum + p._count, 0),
		active: projects.find((p) => p.status === "ACTIVE")?._count || 0,
		completed: projects.find((p) => p.status === "COMPLETED")?._count || 0,
		draft: projects.find((p) => p.status === "DRAFT")?._count || 0,
		archived: projects.find((p) => p.status === "ARCHIVED")?._count || 0,
	};

	// Calculate agent statistics
	const agentStats = {
		total: agents.reduce((sum, a) => sum + a._count, 0),
		active: agents.find((a) => a.status === "ACTIVE")?._count || 0,
		inactive: agents.find((a) => a.status === "INACTIVE")?._count || 0,
		deploying: agents.find((a) => a.status === "DEPLOYING")?._count || 0,
		error: agents.find((a) => a.status === "ERROR")?._count || 0,
	};

	// Calculate agent task statistics
	const conversationTaskCounts = getConversationExecutionCounts(
		conversations,
		since,
	);
	const taskStats = {
		total:
			agentTasks.reduce((sum, t) => sum + t._count, 0) +
			conversationTaskCounts.pending +
			conversationTaskCounts.running +
			conversationTaskCounts.completed +
			conversationTaskCounts.failed +
			conversationTaskCounts.cancelled,
		pending:
			(agentTasks.find((t) => normalizeTaskStatus(t.status) === "pending")
				?._count || 0) + conversationTaskCounts.pending,
		running:
			(agentTasks.find((t) => normalizeTaskStatus(t.status) === "running")
				?._count || 0) + conversationTaskCounts.running,
		completed:
			(agentTasks.find(
				(t) => normalizeTaskStatus(t.status) === "completed",
			)?._count || 0) + conversationTaskCounts.completed,
		failed:
			(agentTasks.find((t) => normalizeTaskStatus(t.status) === "failed")
				?._count || 0) + conversationTaskCounts.failed,
	};

	// Calculate document statistics
	const documentStats = {
		total: projectDocuments.reduce((sum, d) => sum + d._count, 0),
		draft: projectDocuments.find((d) => d.status === "DRAFT")?._count || 0,
		generating:
			projectDocuments.find((d) => d.status === "GENERATING")?._count ||
			0,
		processing:
			projectDocuments.find((d) => d.status === "IN_PROGRESS")?._count ||
			0,
		ready:
			projectDocuments.find((d) => d.status === "COMPLETE")?._count || 0,
		failed:
			projectDocuments.find((d) => d.status === "FAILED")?._count || 0,
	};

	// Calculate pipeline statistics
	const pipelineStats = {
		total: sdlcPipelines.reduce((sum, p) => sum + p._count, 0),
		inProgress:
			sdlcPipelines.find((p) => p.status === "in_progress")?._count || 0,
		completed:
			sdlcPipelines.find((p) => p.status === "completed")?._count || 0,
		failed: sdlcPipelines.find((p) => p.status === "failed")?._count || 0,
	};

	// Calculate workflow statistics
	const workflowStats = {
		total: workflows.reduce((sum, w) => sum + w._count, 0),
		draft: workflows.find((w) => w.status === "DRAFT")?._count || 0,
		active: workflows.find((w) => w.status === "ACTIVE")?._count || 0,
		archived: workflows.find((w) => w.status === "ARCHIVED")?._count || 0,
	};

	return {
		projects: projectStats,
		agents: agentStats,
		tasks: taskStats,
		mcpServers: mcpConfigs,
		prompts: prompts,
		aiChats: aiChats,
		documents: documentStats,
		pipelines: pipelineStats,
		workflows: workflowStats,
		skills: skills,
	};
}

/**
 * Get comprehensive dashboard statistics for an organization
 */
export async function getOrganizationDashboardStats(
	organizationId: string,
	userId?: string,
	since?: Date,
) {
	const activityFilter = since ? { createdAt: { gte: since } } : {};
	// Build project access filter - if userId provided, only count projects user can access
	// Always exclude soft-deleted projects. No date filter: total count reflects current state.
	const projectAccessFilter: any = userId
		? {
				organizationId,
				deletedAt: null,
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
		: { organizationId, deletedAt: null };

	const [
		projects,
		agents,
		agentTasks,
		conversations,
		mcpConfigs,
		prompts,
		aiChats,
		projectDocuments,
		sdlcPipelines,
		members,
		workflows,
		skills,
	] = await Promise.all([
		// Project stats - all accessible projects (current state, no date filter)
		db.project.groupBy({
			by: ["status"],
			where: projectAccessFilter,
			_count: true,
		}),
		// Agent stats - only org's agents (current state)
		db.agent.groupBy({
			by: ["status"],
			where: { organizationId },
			_count: true,
		}),
		// Agent task stats - filtered by time range (activity metric)
		db.agentTask.groupBy({
			by: ["status"],
			where: { organizationId, ...activityFilter },
			_count: true,
		}),
		db.agentConversation.findMany({
			where: {
				organizationId,
				...(since ? { updatedAt: { gte: since } } : {}),
			},
			select: {
				metadata: true,
				createdAt: true,
				updatedAt: true,
			},
		}),
		// MCP configs (user's configured MCP servers in this org)
		db.mCPConfig.count({
			where: { organizationId, userId },
		}),
		// Prompt stats - include org prompts AND system prompts
		db.prompt.count({
			where: {
				OR: [
					{ organizationId }, // Org's prompts
					{ scope: "SYSTEM" }, // System prompts visible to all
				],
			},
		}),
		// AI chat stats - filtered by time range (activity metric)
		db.aiChat.count({
			where: { organizationId, userId, ...activityFilter },
		}),
		// Project document stats - all docs from accessible projects (current state)
		db.projectDocument.groupBy({
			by: ["status"],
			where: {
				project: projectAccessFilter,
			},
			_count: true,
		}),
		// SDLC pipeline stats
		db.sDLCPipeline.groupBy({
			by: ["status"],
			where: { organizationId },
			_count: true,
		}),
		// Member count
		db.member.count({
			where: { organizationId },
		}),
		// Workflow stats
		db.workflow.groupBy({
			by: ["status"],
			where: { organizationId },
			_count: true,
		}),
		// Skill stats - ORGANIZATION scope for org context
		// Safe: returns 0 if skill table doesn't exist (migration not applied)
		safeSkillQuery(
			() =>
				db.skill.count({
					where: {
						scope: "ORGANIZATION",
						organizationId,
					},
				}),
			0,
		),
	]);

	const projectStats = {
		total: projects.reduce((sum, p) => sum + p._count, 0),
		active: projects.find((p) => p.status === "ACTIVE")?._count || 0,
		completed: projects.find((p) => p.status === "COMPLETED")?._count || 0,
		draft: projects.find((p) => p.status === "DRAFT")?._count || 0,
		archived: projects.find((p) => p.status === "ARCHIVED")?._count || 0,
	};

	const agentStats = {
		total: agents.reduce((sum, a) => sum + a._count, 0),
		active: agents.find((a) => a.status === "ACTIVE")?._count || 0,
		inactive: agents.find((a) => a.status === "INACTIVE")?._count || 0,
		deploying: agents.find((a) => a.status === "DEPLOYING")?._count || 0,
		error: agents.find((a) => a.status === "ERROR")?._count || 0,
	};

	const conversationTaskCounts = getConversationExecutionCounts(
		conversations,
		since,
	);
	const taskStats = {
		total:
			agentTasks.reduce((sum, t) => sum + t._count, 0) +
			conversationTaskCounts.pending +
			conversationTaskCounts.running +
			conversationTaskCounts.completed +
			conversationTaskCounts.failed +
			conversationTaskCounts.cancelled,
		pending:
			(agentTasks.find((t) => normalizeTaskStatus(t.status) === "pending")
				?._count || 0) + conversationTaskCounts.pending,
		running:
			(agentTasks.find((t) => normalizeTaskStatus(t.status) === "running")
				?._count || 0) + conversationTaskCounts.running,
		completed:
			(agentTasks.find(
				(t) => normalizeTaskStatus(t.status) === "completed",
			)?._count || 0) + conversationTaskCounts.completed,
		failed:
			(agentTasks.find((t) => normalizeTaskStatus(t.status) === "failed")
				?._count || 0) + conversationTaskCounts.failed,
	};

	const documentStats = {
		total: projectDocuments.reduce((sum, d) => sum + d._count, 0),
		draft: projectDocuments.find((d) => d.status === "DRAFT")?._count || 0,
		generating:
			projectDocuments.find((d) => d.status === "GENERATING")?._count ||
			0,
		processing:
			projectDocuments.find((d) => d.status === "IN_PROGRESS")?._count ||
			0,
		ready:
			projectDocuments.find((d) => d.status === "COMPLETE")?._count || 0,
		failed:
			projectDocuments.find((d) => d.status === "FAILED")?._count || 0,
	};

	const pipelineStats = {
		total: sdlcPipelines.reduce((sum, p) => sum + p._count, 0),
		inProgress:
			sdlcPipelines.find((p) => p.status === "in_progress")?._count || 0,
		completed:
			sdlcPipelines.find((p) => p.status === "completed")?._count || 0,
		failed: sdlcPipelines.find((p) => p.status === "failed")?._count || 0,
	};

	// Calculate workflow statistics
	const workflowStats = {
		total: workflows.reduce((sum, w) => sum + w._count, 0),
		draft: workflows.find((w) => w.status === "DRAFT")?._count || 0,
		active: workflows.find((w) => w.status === "ACTIVE")?._count || 0,
		archived: workflows.find((w) => w.status === "ARCHIVED")?._count || 0,
	};

	return {
		projects: projectStats,
		agents: agentStats,
		tasks: taskStats,
		mcpServers: mcpConfigs,
		prompts: prompts,
		aiChats: aiChats,
		documents: documentStats,
		pipelines: pipelineStats,
		members: members,
		workflows: workflowStats,
		skills: skills,
	};
}

/**
 * Get recent activity for a user
 */
export async function getUserRecentActivity(
	userId: string,
	limit = 10,
	since?: Date,
) {
	const dateFilter = since ? { updatedAt: { gte: since } } : {};
	const [
		recentProjects,
		recentTasks,
		recentConversations,
		recentDocuments,
		recentPrompts,
		recentChats,
		recentWorkflows,
		recentAgents,
		recentSkills,
		recentMcpConfigs,
		recentPipelines,
	] = await Promise.all([
		// Recent projects - only personal projects (organizationId: null), exclude soft-deleted
		db.project.findMany({
			where: {
				userId,
				organizationId: null,
				deletedAt: null,
				...dateFilter,
			},
			orderBy: { updatedAt: "desc" },
			take: limit,
			select: {
				id: true,
				name: true,
				status: true,
				updatedAt: true,
				icon: true,
				color: true,
			},
		}),
		// Recent agent tasks
		db.agentTask.findMany({
			where: { userId, organizationId: null, ...dateFilter },
			orderBy: { updatedAt: "desc" },
			take: limit,
			select: {
				id: true,
				agentId: true,
				status: true,
				stage: true,
				updatedAt: true,
				createdAt: true,
			},
		}),
		db.agentConversation.findMany({
			where: { userId, organizationId: null, ...dateFilter },
			orderBy: { updatedAt: "desc" },
			take: limit,
			select: {
				id: true,
				agentId: true,
				title: true,
				metadata: true,
				createdAt: true,
				updatedAt: true,
			},
		}),
		// Recent documents - only personal project documents (organizationId: null), exclude soft-deleted projects
		db.projectDocument.findMany({
			where: {
				project: {
					userId,
					organizationId: null,
					deletedAt: null,
				},
				...dateFilter,
			},
			orderBy: { updatedAt: "desc" },
			take: limit,
			select: {
				id: true,
				title: true,
				type: true,
				status: true,
				updatedAt: true,
				project: {
					select: {
						name: true,
						id: true,
					},
				},
			},
		}),
		// Recent prompts - only personal prompts (organizationId: null)
		db.prompt.findMany({
			where: { userId, organizationId: null, ...dateFilter },
			orderBy: { updatedAt: "desc" },
			take: limit,
			select: {
				id: true,
				key: true,
				name: true,
				category: true,
				updatedAt: true,
				usageCount: true,
			},
		}),
		// Recent AI chats
		db.aiChat.findMany({
			where: { userId, organizationId: null, ...dateFilter },
			orderBy: { updatedAt: "desc" },
			take: limit,
			select: {
				id: true,
				title: true,
				updatedAt: true,
			},
		}),
		// Recent workflows
		db.workflow.findMany({
			where: { userId, organizationId: null, ...dateFilter },
			orderBy: { updatedAt: "desc" },
			take: limit,
			select: {
				id: true,
				name: true,
				status: true,
				updatedAt: true,
			},
		}),
		// Recent agents - user's personal agents
		db.agent.findMany({
			where: { userId, organizationId: null, ...dateFilter },
			orderBy: { updatedAt: "desc" },
			take: limit,
			select: {
				id: true,
				agentId: true,
				displayName: true,
				status: true,
				updatedAt: true,
			},
		}),
		// Recent skills - USER scope only for personal context
		// Safe: returns [] if skill table doesn't exist (migration not applied)
		safeSkillQuery(
			() =>
				db.skill.findMany({
					where: {
						scope: "USER",
						userId,
						organizationId: null,
						...dateFilter,
					},
					orderBy: { updatedAt: "desc" },
					take: limit,
					select: {
						id: true,
						name: true,
						category: true,
						updatedAt: true,
					},
				}),
			[],
		),
		// Recent MCP configs
		db.mCPConfig.findMany({
			where: { userId, organizationId: null, ...dateFilter },
			orderBy: { updatedAt: "desc" },
			take: limit,
			select: {
				id: true,
				displayName: true,
				updatedAt: true,
				mcpServer: {
					select: { name: true },
				},
			},
		}),
		// Recent SDLC pipelines
		db.sDLCPipeline.findMany({
			where: { userId, organizationId: null, ...dateFilter },
			orderBy: { updatedAt: "desc" },
			take: limit,
			select: {
				id: true,
				name: true,
				status: true,
				updatedAt: true,
			},
		}),
	]);

	const mergedRecentTasks = [
		...recentTasks.map((task) => ({
			id: task.id,
			agentId: task.agentId,
			status: normalizeTaskStatus(task.status),
			stage: task.stage,
			updatedAt: task.updatedAt,
			createdAt: task.createdAt,
			title: undefined as string | null | undefined,
			conversationId: undefined as string | undefined,
		})),
		...getConversationRecentTasks(recentConversations, since),
	]
		.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
		.slice(0, limit);

	return {
		projects: recentProjects,
		tasks: mergedRecentTasks,
		documents: recentDocuments,
		prompts: recentPrompts,
		chats: recentChats,
		workflows: recentWorkflows,
		agents: recentAgents,
		skills: recentSkills,
		mcpConfigs: recentMcpConfigs,
		pipelines: recentPipelines,
	};
}

/**
 * Get recent activity for an organization
 * If userId provided, only show activity from projects user can access
 */
export async function getOrganizationRecentActivity(
	organizationId: string,
	limit = 10,
	userId?: string,
	since?: Date,
) {
	const dateFilter = since ? { updatedAt: { gte: since } } : {};
	// Build project access filter - if userId provided, only show projects user can access
	// Always exclude soft-deleted projects
	const projectAccessFilter: any = userId
		? {
				organizationId,
				deletedAt: null,
				...dateFilter,
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
		: { organizationId, deletedAt: null, ...dateFilter };

	const [
		recentProjects,
		recentTasks,
		recentConversations,
		recentDocuments,
		recentPrompts,
		recentChats,
		recentWorkflows,
		recentAgents,
		recentSkills,
		recentMcpConfigs,
		recentPipelines,
	] = await Promise.all([
		// Recent projects - only those user can access
		db.project.findMany({
			where: projectAccessFilter,
			orderBy: { updatedAt: "desc" },
			take: limit,
			select: {
				id: true,
				name: true,
				status: true,
				updatedAt: true,
				icon: true,
				color: true,
				user: {
					select: {
						name: true,
						image: true,
					},
				},
			},
		}),
		// Recent agent tasks
		db.agentTask.findMany({
			where: { organizationId, ...dateFilter },
			orderBy: { updatedAt: "desc" },
			take: limit,
			select: {
				id: true,
				agentId: true,
				status: true,
				stage: true,
				updatedAt: true,
				createdAt: true,
				user: {
					select: {
						name: true,
						image: true,
					},
				},
			},
		}),
		db.agentConversation.findMany({
			where: { organizationId, ...dateFilter },
			orderBy: { updatedAt: "desc" },
			take: limit,
			select: {
				id: true,
				agentId: true,
				title: true,
				metadata: true,
				createdAt: true,
				updatedAt: true,
				user: {
					select: {
						name: true,
						image: true,
					},
				},
			},
		}),
		// Recent documents - only from projects user can access
		db.projectDocument.findMany({
			where: {
				project: projectAccessFilter,
				...dateFilter,
			},
			orderBy: { updatedAt: "desc" },
			take: limit,
			select: {
				id: true,
				title: true,
				type: true,
				status: true,
				updatedAt: true,
				project: {
					select: {
						name: true,
						id: true,
						user: {
							select: {
								name: true,
								image: true,
							},
						},
					},
				},
			},
		}),
		// Recent prompts
		db.prompt.findMany({
			where: { organizationId, ...dateFilter },
			orderBy: { updatedAt: "desc" },
			take: limit,
			select: {
				id: true,
				key: true,
				name: true,
				category: true,
				updatedAt: true,
				usageCount: true,
			},
		}),
		// Recent AI chats
		db.aiChat.findMany({
			where: { organizationId, userId, ...dateFilter },
			orderBy: { updatedAt: "desc" },
			take: limit,
			select: {
				id: true,
				title: true,
				updatedAt: true,
				user: {
					select: {
						name: true,
						image: true,
					},
				},
			},
		}),
		// Recent workflows
		db.workflow.findMany({
			where: { organizationId, ...dateFilter },
			orderBy: { updatedAt: "desc" },
			take: limit,
			select: {
				id: true,
				name: true,
				status: true,
				updatedAt: true,
				user: {
					select: {
						name: true,
						image: true,
					},
				},
			},
		}),
		// Recent agents - org's agents
		db.agent.findMany({
			where: { organizationId, ...dateFilter },
			orderBy: { updatedAt: "desc" },
			take: limit,
			select: {
				id: true,
				agentId: true,
				displayName: true,
				status: true,
				updatedAt: true,
				user: { select: { name: true, image: true } },
			},
		}),
		// Recent skills - ORGANIZATION scope for org context
		// Safe: returns [] if skill table doesn't exist (migration not applied)
		safeSkillQuery(
			() =>
				db.skill.findMany({
					where: {
						scope: "ORGANIZATION",
						organizationId,
						...dateFilter,
					},
					orderBy: { updatedAt: "desc" },
					take: limit,
					select: {
						id: true,
						name: true,
						category: true,
						updatedAt: true,
					},
				}),
			[],
		),
		// Recent MCP configs
		db.mCPConfig.findMany({
			where: { organizationId, userId, ...dateFilter },
			orderBy: { updatedAt: "desc" },
			take: limit,
			select: {
				id: true,
				displayName: true,
				updatedAt: true,
				mcpServer: { select: { name: true } },
				user: { select: { name: true, image: true } },
			},
		}),
		// Recent SDLC pipelines
		db.sDLCPipeline.findMany({
			where: { organizationId, ...dateFilter },
			orderBy: { updatedAt: "desc" },
			take: limit,
			select: {
				id: true,
				name: true,
				status: true,
				updatedAt: true,
				user: { select: { name: true, image: true } },
			},
		}),
	]);

	const mergedRecentTasks = [
		...recentTasks.map((task) => ({
			id: task.id,
			agentId: task.agentId,
			status: normalizeTaskStatus(task.status),
			stage: task.stage,
			updatedAt: task.updatedAt,
			createdAt: task.createdAt,
			user: task.user,
			title: undefined as string | null | undefined,
			conversationId: undefined as string | undefined,
		})),
		...getConversationRecentTasks(recentConversations, since),
	]
		.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
		.slice(0, limit);

	return {
		projects: recentProjects,
		tasks: mergedRecentTasks,
		documents: recentDocuments,
		prompts: recentPrompts,
		chats: recentChats,
		workflows: recentWorkflows,
		agents: recentAgents,
		skills: recentSkills,
		mcpConfigs: recentMcpConfigs,
		pipelines: recentPipelines,
	};
}
