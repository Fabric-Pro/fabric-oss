/**
 * Database queries for Workspace Members (fixed group permissions)
 *
 * Workspace permissions use four fixed groups:
 * - Administrators: Full access (manage settings, members, delete content)
 * - Contributors: Can upload/edit documents but not delete or manage
 * - Stakeholders: View-only access
 * - Agents: AI agents with read-only access
 */

import { db } from "../../client";
import { canManageWorkspace } from "./workspaces";

// ============================================================================
// Types
// ============================================================================

export type WorkspaceGroup =
	| "administrators"
	| "contributors"
	| "stakeholders"
	| "agents";

export interface WorkspaceMember {
	id: string;
	userId: string;
	group: WorkspaceGroup;
	addedBy: string;
	addedAt: Date;
	user: {
		id: string;
		name: string | null;
		email: string;
		image: string | null;
	};
	addedByUser: {
		id: string;
		name: string | null;
	};
}

export interface WorkspaceAgentMember {
	id: string;
	agentId: string;
	addedBy: string;
	addedAt: Date;
	agent: {
		id: string;
		name: string;
		description: string | null;
	};
	addedByUser: {
		id: string;
		name: string | null;
	};
}

// ============================================================================
// Add Members
// ============================================================================

/**
 * Add a user to a workspace group
 * Only administrators can add members
 */
export async function addWorkspaceMember(
	workspaceId: string,
	userId: string,
	group: Exclude<WorkspaceGroup, "agents">,
	addedBy: string,
) {
	// Verify adder is an administrator
	const canManage = await canManageWorkspace(workspaceId, addedBy);
	if (!canManage) {
		throw new Error("Only administrators can add members");
	}

	// Check if user is already in any group
	const existingMembership = await getUserWorkspaceGroup(workspaceId, userId);
	if (existingMembership) {
		throw new Error(`User is already in the ${existingMembership} group`);
	}

	// Add to appropriate group
	switch (group) {
		case "administrators":
			return await db.workspaceAdministrator.create({
				data: {
					workspaceId,
					userId,
					addedBy,
				},
			});
		case "contributors":
			return await db.workspaceContributor.create({
				data: {
					workspaceId,
					userId,
					addedBy,
				},
			});
		case "stakeholders":
			return await db.workspaceStakeholder.create({
				data: {
					workspaceId,
					userId,
					addedBy,
				},
			});
	}
}

/**
 * Add an agent to workspace (agents group)
 * Only administrators can add agents
 */
export async function addWorkspaceAgent(
	workspaceId: string,
	agentId: string,
	addedBy: string,
) {
	// Verify adder is an administrator
	const canManage = await canManageWorkspace(workspaceId, addedBy);
	if (!canManage) {
		throw new Error("Only administrators can add agents to workspaces");
	}

	// Check if agent is already added
	const existing = await db.workspaceAgent.findFirst({
		where: { workspaceId, agentId },
	});
	if (existing) {
		throw new Error("Agent is already in the workspace");
	}

	return await db.workspaceAgent.create({
		data: {
			workspaceId,
			agentId,
			addedBy,
		},
	});
}

// ============================================================================
// Remove Members
// ============================================================================

/**
 * Remove a user from a workspace
 * Only administrators can remove members
 * Cannot remove the workspace owner
 */
export async function removeWorkspaceMember(
	workspaceId: string,
	userId: string,
	removedBy: string,
) {
	// Verify remover is an administrator
	const canManage = await canManageWorkspace(workspaceId, removedBy);
	if (!canManage) {
		throw new Error("Only administrators can remove members");
	}

	// Check if user is the owner
	const workspace = await db.workspace.findFirst({
		where: { id: workspaceId },
		select: { userId: true },
	});
	if (workspace?.userId === userId) {
		throw new Error("Cannot remove the workspace owner");
	}

	// Find and remove from all groups (user can only be in one)
	const [admin, contributor, stakeholder] = await Promise.all([
		db.workspaceAdministrator.findFirst({ where: { workspaceId, userId } }),
		db.workspaceContributor.findFirst({ where: { workspaceId, userId } }),
		db.workspaceStakeholder.findFirst({ where: { workspaceId, userId } }),
	]);

	if (admin) {
		return await db.workspaceAdministrator.delete({
			where: { id: admin.id },
		});
	}
	if (contributor) {
		return await db.workspaceContributor.delete({
			where: { id: contributor.id },
		});
	}
	if (stakeholder) {
		return await db.workspaceStakeholder.delete({
			where: { id: stakeholder.id },
		});
	}

	throw new Error("User is not a member of this workspace");
}

/**
 * Remove an agent from workspace
 * Only administrators can remove agents
 */
export async function removeWorkspaceAgent(
	workspaceId: string,
	agentId: string,
	removedBy: string,
) {
	// Verify remover is an administrator
	const canManage = await canManageWorkspace(workspaceId, removedBy);
	if (!canManage) {
		throw new Error("Only administrators can remove agents");
	}

	return await db.workspaceAgent.delete({
		where: {
			workspaceId_agentId: {
				workspaceId,
				agentId,
			},
		},
	});
}

// ============================================================================
// Move Members Between Groups
// ============================================================================

/**
 * Change a member's group
 * Only administrators can move members
 * Cannot change the owner's group
 */
export async function changeWorkspaceMemberGroup(
	workspaceId: string,
	userId: string,
	newGroup: Exclude<WorkspaceGroup, "agents">,
	changedBy: string,
) {
	// Verify changer is an administrator
	const canManage = await canManageWorkspace(workspaceId, changedBy);
	if (!canManage) {
		throw new Error("Only administrators can change member groups");
	}

	// Check if user is the owner
	const workspace = await db.workspace.findFirst({
		where: { id: workspaceId },
		select: { userId: true },
	});
	if (workspace?.userId === userId) {
		throw new Error("Cannot change the owner's group");
	}

	return await db.$transaction(async (tx) => {
		// Remove from all existing groups
		await Promise.all([
			tx.workspaceAdministrator.deleteMany({
				where: { workspaceId, userId },
			}),
			tx.workspaceContributor.deleteMany({
				where: { workspaceId, userId },
			}),
			tx.workspaceStakeholder.deleteMany({
				where: { workspaceId, userId },
			}),
		]);

		// Add to new group
		switch (newGroup) {
			case "administrators":
				return await tx.workspaceAdministrator.create({
					data: { workspaceId, userId, addedBy: changedBy },
				});
			case "contributors":
				return await tx.workspaceContributor.create({
					data: { workspaceId, userId, addedBy: changedBy },
				});
			case "stakeholders":
				return await tx.workspaceStakeholder.create({
					data: { workspaceId, userId, addedBy: changedBy },
				});
		}
	});
}

// ============================================================================
// List Members
// ============================================================================

/**
 * Get all members of a workspace grouped by their group
 */
export async function getWorkspaceMembers(workspaceId: string) {
	// Get workspace owner
	const workspace = await db.workspace.findUnique({
		where: { id: workspaceId },
		select: {
			userId: true,
			user: {
				select: {
					id: true,
					name: true,
					email: true,
					image: true,
				},
			},
		},
	});

	// Get all groups in parallel
	const [administrators, contributors, stakeholders, agents] =
		await Promise.all([
			db.workspaceAdministrator.findMany({
				where: { workspaceId },
				select: {
					id: true,
					userId: true,
					addedBy: true,
					addedAt: true,
					user: {
						select: {
							id: true,
							name: true,
							email: true,
							image: true,
						},
					},
					adder: {
						select: {
							id: true,
							name: true,
						},
					},
				},
				orderBy: { addedAt: "asc" },
			}),
			db.workspaceContributor.findMany({
				where: { workspaceId },
				select: {
					id: true,
					userId: true,
					addedBy: true,
					addedAt: true,
					user: {
						select: {
							id: true,
							name: true,
							email: true,
							image: true,
						},
					},
					adder: {
						select: {
							id: true,
							name: true,
						},
					},
				},
				orderBy: { addedAt: "asc" },
			}),
			db.workspaceStakeholder.findMany({
				where: { workspaceId },
				select: {
					id: true,
					userId: true,
					addedBy: true,
					addedAt: true,
					user: {
						select: {
							id: true,
							name: true,
							email: true,
							image: true,
						},
					},
					adder: {
						select: {
							id: true,
							name: true,
						},
					},
				},
				orderBy: { addedAt: "asc" },
			}),
			db.workspaceAgent.findMany({
				where: { workspaceId },
				select: {
					id: true,
					agentId: true,
					addedBy: true,
					addedAt: true,
					agent: {
						select: {
							id: true,
							name: true,
							description: true,
						},
					},
					adder: {
						select: {
							id: true,
							name: true,
						},
					},
				},
				orderBy: { addedAt: "asc" },
			}),
		]);

	return {
		owner: workspace?.user
			? {
					userId: workspace.userId,
					user: workspace.user,
					isOwner: true,
				}
			: null,
		administrators: administrators.map((a) => ({
			id: a.id,
			userId: a.userId,
			group: "administrators" as const,
			addedBy: a.addedBy,
			addedAt: a.addedAt,
			user: a.user,
			addedByUser: a.adder,
		})),
		contributors: contributors.map((c) => ({
			id: c.id,
			userId: c.userId,
			group: "contributors" as const,
			addedBy: c.addedBy,
			addedAt: c.addedAt,
			user: c.user,
			addedByUser: c.adder,
		})),
		stakeholders: stakeholders.map((s) => ({
			id: s.id,
			userId: s.userId,
			group: "stakeholders" as const,
			addedBy: s.addedBy,
			addedAt: s.addedAt,
			user: s.user,
			addedByUser: s.adder,
		})),
		agents: agents.map((a) => ({
			id: a.id,
			agentId: a.agentId,
			addedBy: a.addedBy,
			addedAt: a.addedAt,
			agent: a.agent,
			addedByUser: a.adder,
		})),
	};
}

/**
 * Get the group a user belongs to in a workspace
 */
export async function getUserWorkspaceGroup(
	workspaceId: string,
	userId: string,
): Promise<WorkspaceGroup | "owner" | null> {
	// Check owner first
	const workspace = await db.workspace.findFirst({
		where: { id: workspaceId },
		select: { userId: true },
	});

	if (workspace?.userId === userId) {
		return "owner";
	}

	// Check each group
	const [isAdmin, isContributor, isStakeholder] = await Promise.all([
		db.workspaceAdministrator.findFirst({
			where: { workspaceId, userId },
			select: { id: true },
		}),
		db.workspaceContributor.findFirst({
			where: { workspaceId, userId },
			select: { id: true },
		}),
		db.workspaceStakeholder.findFirst({
			where: { workspaceId, userId },
			select: { id: true },
		}),
	]);

	if (isAdmin) {
		return "administrators";
	}
	if (isContributor) {
		return "contributors";
	}
	if (isStakeholder) {
		return "stakeholders";
	}

	return null;
}

/**
 * Check if an agent has access to a workspace
 */
export async function hasAgentWorkspaceAccess(
	workspaceId: string,
	agentId: string,
): Promise<boolean> {
	const access = await db.workspaceAgent.findFirst({
		where: { workspaceId, agentId },
		select: { id: true },
	});
	return !!access;
}

/**
 * Get all workspaces an agent has access to
 */
export async function getAgentWorkspaces(agentId: string) {
	return await db.workspaceAgent.findMany({
		where: { agentId },
		select: {
			workspaceId: true,
			addedAt: true,
			workspace: {
				select: {
					id: true,
					name: true,
					description: true,
					type: true,
					status: true,
					_count: {
						select: { documents: true },
					},
				},
			},
		},
		orderBy: { addedAt: "desc" },
	});
}

/**
 * Search users who can be added to a workspace
 * For org workspaces, only shows org members
 * Excludes users already in the workspace
 */
export async function searchUsersForWorkspace(
	workspaceId: string,
	query: string,
	limit = 10,
) {
	// Get workspace details
	const workspace = await db.workspace.findUnique({
		where: { id: workspaceId },
		select: {
			userId: true,
			organizationId: true,
		},
	});

	if (!workspace) {
		return [];
	}

	// Get existing member IDs
	const [admins, contributors, stakeholders] = await Promise.all([
		db.workspaceAdministrator.findMany({
			where: { workspaceId },
			select: { userId: true },
		}),
		db.workspaceContributor.findMany({
			where: { workspaceId },
			select: { userId: true },
		}),
		db.workspaceStakeholder.findMany({
			where: { workspaceId },
			select: { userId: true },
		}),
	]);

	const existingMemberIds = new Set([
		workspace.userId,
		...admins.map((a) => a.userId),
		...contributors.map((c) => c.userId),
		...stakeholders.map((s) => s.userId),
	]);

	// Build query based on workspace type
	if (workspace.organizationId) {
		// Organization workspace - only search org members
		const orgMembers = await db.member.findMany({
			where: {
				organizationId: workspace.organizationId,
				userId: { notIn: Array.from(existingMemberIds) },
				user: {
					OR: [
						{ name: { contains: query, mode: "insensitive" } },
						{ email: { contains: query, mode: "insensitive" } },
					],
				},
			},
			select: {
				user: {
					select: {
						id: true,
						name: true,
						email: true,
						image: true,
					},
				},
			},
			take: limit,
		});

		return orgMembers.map((m) => m.user);
	}
	// Personal workspace - search all users
	return await db.user.findMany({
		where: {
			id: { notIn: Array.from(existingMemberIds) },
			OR: [
				{ name: { contains: query, mode: "insensitive" } },
				{ email: { contains: query, mode: "insensitive" } },
			],
		},
		select: {
			id: true,
			name: true,
			email: true,
			image: true,
		},
		take: limit,
	});
}
