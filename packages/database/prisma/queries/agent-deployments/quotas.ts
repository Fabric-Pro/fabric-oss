/**
 * Database queries for deployment quotas
 * Handles both personal (UserDeploymentQuota) and organizational (OrganizationDeploymentQuota) quotas
 */

import { db } from "../../client";

// =============================================================================
// USER QUOTAS (Personal Accounts)
// =============================================================================

export async function getUserDeploymentQuota(userId: string) {
	return await db.userDeploymentQuota.findUnique({
		where: { userId },
	});
}

export async function getOrCreateUserDeploymentQuota(userId: string) {
	const existing = await db.userDeploymentQuota.findUnique({
		where: { userId },
	});

	if (existing) {
		return existing;
	}

	return await db.userDeploymentQuota.create({
		data: {
			userId,
			// Default limits for personal accounts
			maxDeployments: 3,
			maxConcurrentExecutions: 10,
			dailyExecutionLimit: 100,
			monthlyExecutionLimit: 2000,
		},
	});
}

export async function updateUserDeploymentQuota(
	userId: string,
	data: {
		maxDeployments?: number;
		maxConcurrentExecutions?: number;
		dailyExecutionLimit?: number;
		monthlyExecutionLimit?: number;
		currentDeployments?: number;
		dailyExecutionCount?: number;
		monthlyExecutionCount?: number;
	},
) {
	return await db.userDeploymentQuota.upsert({
		where: { userId },
		update: data,
		create: {
			userId,
			...data,
		},
	});
}

export async function incrementUserExecutionCount(userId: string) {
	return await db.userDeploymentQuota.update({
		where: { userId },
		data: {
			dailyExecutionCount: { increment: 1 },
			monthlyExecutionCount: { increment: 1 },
		},
	});
}

export async function resetUserDailyExecutionCount(userId: string) {
	return await db.userDeploymentQuota.update({
		where: { userId },
		data: {
			dailyExecutionCount: 0,
			dailyResetAt: new Date(),
		},
	});
}

export async function resetUserMonthlyExecutionCount(userId: string) {
	return await db.userDeploymentQuota.update({
		where: { userId },
		data: {
			monthlyExecutionCount: 0,
			monthlyResetAt: new Date(),
		},
	});
}

export async function incrementUserDeploymentCount(userId: string) {
	return await db.userDeploymentQuota.update({
		where: { userId },
		data: {
			currentDeployments: { increment: 1 },
		},
	});
}

export async function decrementUserDeploymentCount(userId: string) {
	return await db.userDeploymentQuota.update({
		where: { userId },
		data: {
			currentDeployments: { decrement: 1 },
		},
	});
}

// =============================================================================
// ORGANIZATION QUOTAS
// =============================================================================

export async function getOrganizationDeploymentQuota(organizationId: string) {
	return await db.organizationDeploymentQuota.findUnique({
		where: { organizationId },
	});
}

export async function getOrCreateOrganizationDeploymentQuota(
	organizationId: string,
) {
	const existing = await db.organizationDeploymentQuota.findUnique({
		where: { organizationId },
	});

	if (existing) {
		return existing;
	}

	return await db.organizationDeploymentQuota.create({
		data: {
			organizationId,
			// Default limits for organizations
			maxDeployments: 10,
			maxConcurrentExecutions: 50,
			dailyExecutionLimit: 1000,
			monthlyExecutionLimit: 20000,
		},
	});
}

export async function updateOrganizationDeploymentQuota(
	organizationId: string,
	data: {
		maxDeployments?: number;
		maxConcurrentExecutions?: number;
		dailyExecutionLimit?: number;
		monthlyExecutionLimit?: number;
		currentDeployments?: number;
		dailyExecutionCount?: number;
		monthlyExecutionCount?: number;
	},
) {
	return await db.organizationDeploymentQuota.upsert({
		where: { organizationId },
		update: data,
		create: {
			organizationId,
			...data,
		},
	});
}

export async function incrementOrgExecutionCount(organizationId: string) {
	return await db.organizationDeploymentQuota.update({
		where: { organizationId },
		data: {
			dailyExecutionCount: { increment: 1 },
			monthlyExecutionCount: { increment: 1 },
		},
	});
}

export async function resetOrgDailyExecutionCount(organizationId: string) {
	return await db.organizationDeploymentQuota.update({
		where: { organizationId },
		data: {
			dailyExecutionCount: 0,
			dailyResetAt: new Date(),
		},
	});
}

export async function resetOrgMonthlyExecutionCount(organizationId: string) {
	return await db.organizationDeploymentQuota.update({
		where: { organizationId },
		data: {
			monthlyExecutionCount: 0,
			monthlyResetAt: new Date(),
		},
	});
}

export async function incrementOrgDeploymentCount(organizationId: string) {
	return await db.organizationDeploymentQuota.update({
		where: { organizationId },
		data: {
			currentDeployments: { increment: 1 },
		},
	});
}

export async function decrementOrgDeploymentCount(organizationId: string) {
	return await db.organizationDeploymentQuota.update({
		where: { organizationId },
		data: {
			currentDeployments: { decrement: 1 },
		},
	});
}

// =============================================================================
// UNIFIED QUOTA HELPERS
// =============================================================================

export interface QuotaCheckResult {
	allowed: boolean;
	reason?: string;
	currentUsage: {
		deployments: number;
		dailyExecutions: number;
		monthlyExecutions: number;
	};
	limits: {
		maxDeployments: number;
		dailyExecutionLimit: number;
		monthlyExecutionLimit: number;
	};
}

/**
 * Check if user/org can create a new deployment
 */
export async function checkDeploymentQuota(
	userId: string,
	organizationId?: string,
): Promise<QuotaCheckResult> {
	if (organizationId) {
		const quota =
			await getOrCreateOrganizationDeploymentQuota(organizationId);

		const result: QuotaCheckResult = {
			allowed: quota.currentDeployments < quota.maxDeployments,
			currentUsage: {
				deployments: quota.currentDeployments,
				dailyExecutions: quota.dailyExecutionCount,
				monthlyExecutions: quota.monthlyExecutionCount,
			},
			limits: {
				maxDeployments: quota.maxDeployments,
				dailyExecutionLimit: quota.dailyExecutionLimit,
				monthlyExecutionLimit: quota.monthlyExecutionLimit,
			},
		};

		if (!result.allowed) {
			result.reason = `Organization has reached maximum deployments (${quota.maxDeployments})`;
		}

		return result;
	}

	// Personal account
	const quota = await getOrCreateUserDeploymentQuota(userId);

	const result: QuotaCheckResult = {
		allowed: quota.currentDeployments < quota.maxDeployments,
		currentUsage: {
			deployments: quota.currentDeployments,
			dailyExecutions: quota.dailyExecutionCount,
			monthlyExecutions: quota.monthlyExecutionCount,
		},
		limits: {
			maxDeployments: quota.maxDeployments,
			dailyExecutionLimit: quota.dailyExecutionLimit,
			monthlyExecutionLimit: quota.monthlyExecutionLimit,
		},
	};

	if (!result.allowed) {
		result.reason = `You have reached maximum deployments (${quota.maxDeployments})`;
	}

	return result;
}

/**
 * Check if user/org can execute (within daily/monthly limits)
 */
export async function checkExecutionQuota(
	_deploymentId: string,
	userId: string,
	organizationId?: string,
): Promise<QuotaCheckResult> {
	if (organizationId) {
		const quota =
			await getOrCreateOrganizationDeploymentQuota(organizationId);

		const dailyExceeded =
			quota.dailyExecutionCount >= quota.dailyExecutionLimit;
		const monthlyExceeded =
			quota.monthlyExecutionCount >= quota.monthlyExecutionLimit;

		const result: QuotaCheckResult = {
			allowed: !dailyExceeded && !monthlyExceeded,
			currentUsage: {
				deployments: quota.currentDeployments,
				dailyExecutions: quota.dailyExecutionCount,
				monthlyExecutions: quota.monthlyExecutionCount,
			},
			limits: {
				maxDeployments: quota.maxDeployments,
				dailyExecutionLimit: quota.dailyExecutionLimit,
				monthlyExecutionLimit: quota.monthlyExecutionLimit,
			},
		};

		if (dailyExceeded) {
			result.reason = `Organization has reached daily execution limit (${quota.dailyExecutionLimit})`;
		} else if (monthlyExceeded) {
			result.reason = `Organization has reached monthly execution limit (${quota.monthlyExecutionLimit})`;
		}

		return result;
	}

	// Personal account
	const quota = await getOrCreateUserDeploymentQuota(userId);

	const dailyExceeded =
		quota.dailyExecutionCount >= quota.dailyExecutionLimit;
	const monthlyExceeded =
		quota.monthlyExecutionCount >= quota.monthlyExecutionLimit;

	const result: QuotaCheckResult = {
		allowed: !dailyExceeded && !monthlyExceeded,
		currentUsage: {
			deployments: quota.currentDeployments,
			dailyExecutions: quota.dailyExecutionCount,
			monthlyExecutions: quota.monthlyExecutionCount,
		},
		limits: {
			maxDeployments: quota.maxDeployments,
			dailyExecutionLimit: quota.dailyExecutionLimit,
			monthlyExecutionLimit: quota.monthlyExecutionLimit,
		},
	};

	if (dailyExceeded) {
		result.reason = `You have reached your daily execution limit (${quota.dailyExecutionLimit})`;
	} else if (monthlyExceeded) {
		result.reason = `You have reached your monthly execution limit (${quota.monthlyExecutionLimit})`;
	}

	return result;
}

/**
 * Increment execution count for user or org
 */
export async function incrementExecutionQuota(
	userId: string,
	organizationId?: string,
) {
	if (organizationId) {
		return await incrementOrgExecutionCount(organizationId);
	}
	return await incrementUserExecutionCount(userId);
}

/**
 * Increment deployment count for user or org
 */
export async function incrementDeploymentQuota(
	userId: string,
	organizationId?: string,
) {
	if (organizationId) {
		return await incrementOrgDeploymentCount(organizationId);
	}
	return await incrementUserDeploymentCount(userId);
}

/**
 * Decrement deployment count for user or org
 */
export async function decrementDeploymentQuota(
	userId: string,
	organizationId?: string,
) {
	if (organizationId) {
		return await decrementOrgDeploymentCount(organizationId);
	}
	return await decrementUserDeploymentCount(userId);
}

// =============================================================================
// DEPLOYMENT RATE LIMIT INFO
// =============================================================================

export interface DeploymentRateLimitResult {
	allowed: boolean;
	reason?: string;
	limits: {
		perMinute: number;
		perHour: number;
		dailyLimit?: number;
		monthlyLimit?: number;
	};
}

/**
 * Get deployment rate limit configuration.
 * Note: Real-time rate limiting is handled by the supervisor workflow in-memory.
 * This function returns the configured limits for display purposes.
 */
export async function checkDeploymentRateLimit(
	deploymentId: string,
): Promise<DeploymentRateLimitResult> {
	const deployment = await db.agentDeployment.findUnique({
		where: { id: deploymentId },
	});

	if (!deployment) {
		return {
			allowed: false,
			reason: "Deployment not found",
			limits: {
				perMinute: 0,
				perHour: 0,
			},
		};
	}

	// Real-time rate limiting is enforced by the supervisor workflow.
	// This just returns the configured limits.
	return {
		allowed: true,
		limits: {
			perMinute: deployment.rateLimitPerMinute,
			perHour: deployment.rateLimitPerHour,
			dailyLimit: deployment.dailyExecutionLimit ?? undefined,
			monthlyLimit: deployment.monthlyExecutionLimit ?? undefined,
		},
	};
}

/**
 * Get current quota usage summary for a user/org
 */
export async function getQuotaUsageSummary(
	userId: string,
	organizationId?: string,
) {
	const quota = organizationId
		? await getOrCreateOrganizationDeploymentQuota(organizationId)
		: await getOrCreateUserDeploymentQuota(userId);

	const deploymentCheck = await checkDeploymentQuota(userId, organizationId);

	return {
		type: organizationId ? "organization" : "personal",
		deployments: {
			current: quota.currentDeployments,
			max: quota.maxDeployments,
			available: quota.maxDeployments - quota.currentDeployments,
		},
		executions: {
			daily: {
				current: quota.dailyExecutionCount,
				limit: quota.dailyExecutionLimit,
				available:
					quota.dailyExecutionLimit - quota.dailyExecutionCount,
				resetsAt: quota.dailyResetAt,
			},
			monthly: {
				current: quota.monthlyExecutionCount,
				limit: quota.monthlyExecutionLimit,
				available:
					quota.monthlyExecutionLimit - quota.monthlyExecutionCount,
				resetsAt: quota.monthlyResetAt,
			},
		},
		canDeploy: deploymentCheck.allowed,
	};
}
