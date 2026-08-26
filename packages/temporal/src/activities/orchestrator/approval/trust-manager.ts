/**
 * Trust Manager
 *
 * Manages trust levels and delegation for reducing approval fatigue.
 * Implements trust-based auto-approval with learning from outcomes.
 *
 * Part of Phase 3: Smart Approval Flow
 */

import { db } from "@repo/database";
import { logger } from "@repo/logs";
import type { TaskPlan, TaskStep } from "../types";

// =============================================================================
// Types
// =============================================================================

export type TrustLevel = "none" | "read" | "write" | "full";

export interface AgentTrustConfig {
	agentId: string;
	level: TrustLevel;
	/** Specific operations this trust applies to */
	scope: string[];
	/** When this trust expires */
	expiresAt?: Date;
	/** How many times this trust can be used (undefined = unlimited) */
	usageLimit?: number;
	/** Current usage count */
	usageCount: number;
	/** When this trust was granted */
	grantedAt: Date;
	/** Who granted this trust */
	grantedBy: string;
}

export interface OperationTrustConfig {
	operationType: string;
	autoApprove: boolean;
	maxRiskLevel: "low" | "medium" | "high";
	requiresReview: boolean;
}

export interface TrustHistoryEntry {
	agentId: string;
	operation: string;
	riskLevel: string;
	approved: boolean;
	outcome: "success" | "failure" | "unknown";
	timestamp: Date;
	userId: string;
}

export interface TrustConfiguration {
	userId: string;
	organizationId?: string;
	/** Per-agent trust levels */
	agentTrust: Map<string, AgentTrustConfig>;
	/** Per-operation trust levels */
	operationTrust: Map<string, OperationTrustConfig>;
	/** Trust history for learning */
	trustHistory: TrustHistoryEntry[];
	/** Global trust settings */
	globalSettings: {
		/** Maximum auto-approve risk level */
		maxAutoApproveRisk: "low" | "medium" | "high";
		/** Whether to enable trust learning */
		enableLearning: boolean;
		/** Trust decay rate (days until trust starts decaying) */
		trustDecayDays: number;
		/** Minimum success rate for trust increase */
		minSuccessRateForIncrease: number;
	};
}

export interface AutoApprovalDecision {
	autoApprove: boolean;
	reason: string;
	trustSource: "agent" | "operation" | "learned" | "none";
	confidenceScore: number;
	requiresLogging: boolean;
}

export interface PlanApprovalSummary {
	plan: TaskPlan;
	overallRisk: "low" | "medium" | "high" | "critical";
	highRiskSteps: Array<{
		stepId: string;
		description: string;
		risk: string;
		impact: string;
	}>;
	plannedActions: Array<{
		action: string;
		target: string;
		reversible: boolean;
	}>;
	autoApprovedSteps: string[];
	pendingApprovalSteps: string[];
}

// =============================================================================
// Trust Manager
// =============================================================================

/**
 * Load trust configuration for a user.
 * Trust configuration is now persisted in UserOrchestratorPreferences.trustConfiguration field.
 */
export async function loadTrustConfiguration(
	userId: string,
	organizationId?: string,
): Promise<TrustConfiguration> {
	try {
		// Try to load from database using composite unique key
		const prefs = await db.userOrchestratorPreferences.findUnique({
			where: {
				userId_organizationId: {
					userId,
					organizationId: organizationId || "", // "" for personal accounts
				},
			},
			select: { trustConfiguration: true },
		});

		if (prefs?.trustConfiguration) {
			const stored = prefs.trustConfiguration as StoredTrustConfiguration;

			// Reconstruct Maps from stored arrays
			const config: TrustConfiguration = {
				userId,
				organizationId,
				agentTrust: new Map(
					stored.agentTrust?.map((a) => [
						a.agentId,
						{
							...a,
							grantedAt: new Date(a.grantedAt),
							expiresAt: a.expiresAt
								? new Date(a.expiresAt)
								: undefined,
						},
					]) || [],
				),
				operationTrust: new Map(
					stored.operationTrust?.map((o) => [o.operationType, o]) ||
						[],
				),
				trustHistory:
					stored.trustHistory?.map((h) => ({
						...h,
						timestamp: new Date(h.timestamp),
					})) || [],
				globalSettings: stored.globalSettings || {
					maxAutoApproveRisk: "low",
					enableLearning: true,
					trustDecayDays: 30,
					minSuccessRateForIncrease: 0.9,
				},
			};

			// Ensure default operations are set
			setDefaultOperationTrust(config);
			return config;
		}
	} catch (error) {
		logger.warn(
			"[TrustManager] Failed to load trust configuration from DB, using defaults",
			{
				userId,
				error: error instanceof Error ? error.message : "Unknown error",
			},
		);
	}

	// Return default configuration if not found or on error
	const config: TrustConfiguration = {
		userId,
		organizationId,
		agentTrust: new Map(),
		operationTrust: new Map(),
		trustHistory: [],
		globalSettings: {
			maxAutoApproveRisk: "low",
			enableLearning: true,
			trustDecayDays: 30,
			minSuccessRateForIncrease: 0.9,
		},
	};

	// Set default operation trust for common operations
	setDefaultOperationTrust(config);

	return config;
}

/** Serializable format for database storage */
interface StoredAgentTrustConfig {
	agentId: string;
	level: TrustLevel;
	scope: string[];
	expiresAt?: string;
	usageLimit?: number;
	usageCount: number;
	grantedAt: string;
	grantedBy: string;
}

interface StoredTrustHistoryEntry {
	agentId: string;
	operation: string;
	riskLevel: string;
	approved: boolean;
	outcome: "success" | "failure" | "unknown";
	timestamp: string;
	userId: string;
}

interface StoredTrustConfiguration {
	agentTrust?: StoredAgentTrustConfig[];
	operationTrust?: OperationTrustConfig[];
	trustHistory?: StoredTrustHistoryEntry[];
	globalSettings?: TrustConfiguration["globalSettings"];
}

function setDefaultOperationTrust(config: TrustConfiguration): void {
	// Default trust for read operations
	if (!config.operationTrust.has("read")) {
		config.operationTrust.set("read", {
			operationType: "read",
			autoApprove: true,
			maxRiskLevel: "low",
			requiresReview: false,
		});
	}

	// Default trust for list operations
	if (!config.operationTrust.has("list")) {
		config.operationTrust.set("list", {
			operationType: "list",
			autoApprove: true,
			maxRiskLevel: "low",
			requiresReview: false,
		});
	}

	// Default trust for search operations
	if (!config.operationTrust.has("search")) {
		config.operationTrust.set("search", {
			operationType: "search",
			autoApprove: true,
			maxRiskLevel: "low",
			requiresReview: false,
		});
	}
}

/**
 * Save trust configuration to database.
 * Trust configuration is persisted in UserOrchestratorPreferences.trustConfiguration field.
 */
export async function saveTrustConfiguration(
	config: TrustConfiguration,
): Promise<boolean> {
	try {
		// Convert Maps to arrays for JSON storage
		const storedConfig: StoredTrustConfiguration = {
			agentTrust: Array.from(config.agentTrust.values()).map(
				(a): StoredAgentTrustConfig => ({
					agentId: a.agentId,
					level: a.level,
					scope: a.scope,
					usageLimit: a.usageLimit,
					usageCount: a.usageCount,
					grantedAt: a.grantedAt.toISOString(),
					grantedBy: a.grantedBy,
					expiresAt: a.expiresAt?.toISOString(),
				}),
			),
			operationTrust: Array.from(config.operationTrust.values()),
			trustHistory: config.trustHistory.slice(-100).map(
				(h): StoredTrustHistoryEntry => ({
					agentId: h.agentId,
					operation: h.operation,
					riskLevel: h.riskLevel,
					approved: h.approved,
					outcome: h.outcome,
					timestamp: h.timestamp.toISOString(),
					userId: h.userId,
				}),
			),
			globalSettings: config.globalSettings,
		};

		// Upsert to database using composite unique key
		await db.userOrchestratorPreferences.upsert({
			where: {
				userId_organizationId: {
					userId: config.userId,
					organizationId: config.organizationId || "",
				},
			},
			create: {
				userId: config.userId,
				organizationId: config.organizationId || "",
				trustConfiguration: JSON.parse(JSON.stringify(storedConfig)),
			},
			update: {
				trustConfiguration: JSON.parse(JSON.stringify(storedConfig)),
			},
		});

		logger.info("[TrustManager] Trust configuration saved to database", {
			userId: config.userId,
			agentTrustCount: config.agentTrust.size,
			operationTrustCount: config.operationTrust.size,
			historyEntries: storedConfig.trustHistory?.length || 0,
		});

		return true;
	} catch (error) {
		logger.error(
			"[TrustManager] Failed to save trust configuration to database",
			{
				userId: config.userId,
				error: error instanceof Error ? error.message : "Unknown error",
			},
		);
		return false;
	}
}

// =============================================================================
// Auto-Approval Logic
// =============================================================================

/**
 * Determine if a step can be auto-approved based on trust configuration.
 */
export function checkAutoApproval(
	step: TaskStep,
	config: TrustConfiguration,
): AutoApprovalDecision {
	const stepRisk = step.riskLevel || "low";

	// Critical risk steps are never auto-approved
	if (stepRisk === "critical") {
		return {
			autoApprove: false,
			reason: "Critical risk operations always require explicit approval",
			trustSource: "none",
			confidenceScore: 1.0,
			requiresLogging: true,
		};
	}

	// Check agent-specific trust
	if (step.executor) {
		const agentTrust = config.agentTrust.get(step.executor);
		if (agentTrust) {
			const decision = checkAgentTrust(
				step,
				agentTrust,
				config.globalSettings,
			);
			if (decision.autoApprove) {
				return decision;
			}
		}
	}

	// Check operation-type trust
	const operationType = inferOperationType(step);
	const operationTrust = config.operationTrust.get(operationType);
	if (operationTrust) {
		const decision = checkOperationTrust(step, operationTrust);
		if (decision.autoApprove) {
			return decision;
		}
	}

	// Check learned trust from history
	if (config.globalSettings.enableLearning) {
		const learnedDecision = checkLearnedTrust(step, config);
		if (learnedDecision.autoApprove) {
			return learnedDecision;
		}
	}

	// Default: require approval
	return {
		autoApprove: false,
		reason: "No trust configuration allows auto-approval for this operation",
		trustSource: "none",
		confidenceScore: 0,
		requiresLogging: false,
	};
}

function checkAgentTrust(
	step: TaskStep,
	trust: AgentTrustConfig,
	_globalSettings: TrustConfiguration["globalSettings"],
): AutoApprovalDecision {
	// Check expiration
	if (trust.expiresAt && trust.expiresAt < new Date()) {
		return {
			autoApprove: false,
			reason: "Agent trust has expired",
			trustSource: "agent",
			confidenceScore: 0,
			requiresLogging: false,
		};
	}

	// Check usage limit
	if (trust.usageLimit && trust.usageCount >= trust.usageLimit) {
		return {
			autoApprove: false,
			reason: "Agent trust usage limit exceeded",
			trustSource: "agent",
			confidenceScore: 0,
			requiresLogging: false,
		};
	}

	// Check scope
	const operationType = inferOperationType(step);
	if (trust.scope.length > 0 && !trust.scope.includes(operationType)) {
		return {
			autoApprove: false,
			reason: `Operation '${operationType}' not in agent's trust scope`,
			trustSource: "agent",
			confidenceScore: 0,
			requiresLogging: false,
		};
	}

	// Check trust level against step risk
	const stepRisk = step.riskLevel || "low";
	const canAutoApprove = trustLevelAllowsRisk(trust.level, stepRisk);

	if (canAutoApprove) {
		return {
			autoApprove: true,
			reason: `Agent '${trust.agentId}' has ${trust.level} trust level for this operation`,
			trustSource: "agent",
			confidenceScore: trustLevelToConfidence(trust.level),
			requiresLogging: true,
		};
	}

	return {
		autoApprove: false,
		reason: `Agent trust level '${trust.level}' insufficient for ${stepRisk} risk operation`,
		trustSource: "agent",
		confidenceScore: 0,
		requiresLogging: false,
	};
}

function checkOperationTrust(
	step: TaskStep,
	trust: OperationTrustConfig,
): AutoApprovalDecision {
	if (!trust.autoApprove) {
		return {
			autoApprove: false,
			reason: `Operation '${trust.operationType}' requires explicit approval`,
			trustSource: "operation",
			confidenceScore: 0,
			requiresLogging: false,
		};
	}

	const stepRisk = step.riskLevel || "low";
	const riskAllowed =
		riskLevelValue(stepRisk) <= riskLevelValue(trust.maxRiskLevel);

	if (riskAllowed) {
		return {
			autoApprove: true,
			reason: `Operation '${trust.operationType}' is auto-approved for ${trust.maxRiskLevel} risk or lower`,
			trustSource: "operation",
			confidenceScore: 0.8,
			requiresLogging: trust.requiresReview,
		};
	}

	return {
		autoApprove: false,
		reason: `Operation risk '${stepRisk}' exceeds max allowed '${trust.maxRiskLevel}'`,
		trustSource: "operation",
		confidenceScore: 0,
		requiresLogging: false,
	};
}

function checkLearnedTrust(
	step: TaskStep,
	config: TrustConfiguration,
): AutoApprovalDecision {
	// Find similar past operations
	const operationType = inferOperationType(step);
	const relevantHistory = config.trustHistory.filter(
		(h) =>
			h.operation === operationType &&
			h.agentId === step.executor &&
			h.riskLevel === step.riskLevel,
	);

	if (relevantHistory.length < 5) {
		// Not enough history for learning
		return {
			autoApprove: false,
			reason: "Insufficient history for learned trust",
			trustSource: "learned",
			confidenceScore: 0,
			requiresLogging: false,
		};
	}

	// Calculate success rate
	const successfulOps = relevantHistory.filter(
		(h) => h.approved && h.outcome === "success",
	);
	const successRate = successfulOps.length / relevantHistory.length;

	if (successRate >= config.globalSettings.minSuccessRateForIncrease) {
		return {
			autoApprove: true,
			reason: `Learned trust based on ${(successRate * 100).toFixed(0)}% success rate over ${relevantHistory.length} operations`,
			trustSource: "learned",
			confidenceScore: successRate * 0.8, // Cap at 80% confidence for learned trust
			requiresLogging: true,
		};
	}

	return {
		autoApprove: false,
		reason: `Success rate ${(successRate * 100).toFixed(0)}% below threshold`,
		trustSource: "learned",
		confidenceScore: 0,
		requiresLogging: false,
	};
}

// =============================================================================
// Plan-Level Approval
// =============================================================================

/**
 * Analyze a plan for approval requirements and create a summary.
 */
export function analyzePlanForApproval(
	plan: TaskPlan,
	config: TrustConfiguration,
): PlanApprovalSummary {
	const highRiskSteps: PlanApprovalSummary["highRiskSteps"] = [];
	const plannedActions: PlanApprovalSummary["plannedActions"] = [];
	const autoApprovedSteps: string[] = [];
	const pendingApprovalSteps: string[] = [];

	// Analyze each step
	for (const step of plan.steps) {
		const autoApproval = checkAutoApproval(step, config);

		if (autoApproval.autoApprove) {
			autoApprovedSteps.push(step.id);
		} else {
			// Any step that's not auto-approved requires approval
			// This includes: medium/high/critical risk, or steps explicitly marked requiresApproval
			pendingApprovalSteps.push(step.id);
		}

		// Track high-risk steps
		if (step.riskLevel === "high" || step.riskLevel === "critical") {
			highRiskSteps.push({
				stepId: step.id,
				description: step.description,
				risk: step.riskLevel,
				impact: assessStepImpact(step),
			});
		}

		// Track planned actions
		const action = extractPlannedAction(step);
		if (action) {
			plannedActions.push(action);
		}
	}

	// Determine overall risk
	const overallRisk = determineOverallRisk(plan.steps);

	return {
		plan,
		overallRisk,
		highRiskSteps,
		plannedActions,
		autoApprovedSteps,
		pendingApprovalSteps,
	};
}

function assessStepImpact(step: TaskStep): string {
	const impacts: string[] = [];
	const descLower = step.description.toLowerCase();

	if (descLower.includes("delete") || descLower.includes("remove")) {
		impacts.push("Data will be permanently deleted");
	}

	if (descLower.includes("create") || descLower.includes("add")) {
		impacts.push("New resources will be created");
	}

	if (descLower.includes("update") || descLower.includes("modify")) {
		impacts.push("Existing data will be modified");
	}

	if (
		descLower.includes("send") ||
		descLower.includes("email") ||
		descLower.includes("notify")
	) {
		impacts.push("External communications will be sent");
	}

	return impacts.length > 0 ? impacts.join("; ") : "Standard operation";
}

function extractPlannedAction(
	step: TaskStep,
): PlanApprovalSummary["plannedActions"][0] | null {
	const operationType = inferOperationType(step);
	const target = extractTarget(step.description);

	if (!target) {
		return null;
	}

	return {
		action: operationType,
		target,
		reversible: operationType === "read" || operationType === "create",
	};
}

function extractTarget(description: string): string {
	// Try to extract the target from the description
	const patterns = [
		/(?:create|add|update|delete|get|list|search)\s+(?:the\s+)?(.+?)(?:\s+(?:in|from|on|to)|$)/i,
		/(?:for|on|in)\s+(.+?)$/i,
	];

	for (const pattern of patterns) {
		const match = description.match(pattern);
		if (match?.[1]) {
			return match[1].trim().slice(0, 50);
		}
	}

	return description.slice(0, 30);
}

function determineOverallRisk(
	steps: TaskStep[],
): "low" | "medium" | "high" | "critical" {
	const hasCritical = steps.some((s) => s.riskLevel === "critical");
	const hasHigh = steps.some((s) => s.riskLevel === "high");
	const mediumCount = steps.filter((s) => s.riskLevel === "medium").length;

	if (hasCritical) {
		return "critical";
	}
	if (hasHigh) {
		return "high";
	}
	if (mediumCount >= 2) {
		return "medium";
	}
	return "low";
}

// =============================================================================
// Trust Learning
// =============================================================================

/**
 * Record an operation outcome for trust learning.
 */
export function recordTrustOutcome(
	config: TrustConfiguration,
	step: TaskStep,
	approved: boolean,
	outcome: "success" | "failure" | "unknown",
): TrustConfiguration {
	const entry: TrustHistoryEntry = {
		agentId: step.executor || "unknown",
		operation: inferOperationType(step),
		riskLevel: step.riskLevel || "low",
		approved,
		outcome,
		timestamp: new Date(),
		userId: config.userId,
	};

	// Add to history (keep last 100 entries)
	config.trustHistory.push(entry);
	if (config.trustHistory.length > 100) {
		config.trustHistory = config.trustHistory.slice(-100);
	}

	// Update agent trust based on outcome (optional enhancement)
	if (outcome === "success" && approved && step.executor) {
		maybeIncreaseTrust(config, step.executor);
	} else if (outcome === "failure" && step.executor) {
		maybeDecreaseTrust(config, step.executor);
	}

	return config;
}

function maybeIncreaseTrust(config: TrustConfiguration, agentId: string): void {
	const trust = config.agentTrust.get(agentId);
	if (!trust) {
		return;
	}

	// Only auto-increase if learning is enabled
	if (!config.globalSettings.enableLearning) {
		return;
	}

	// Calculate recent success rate
	const recentHistory = config.trustHistory.filter(
		(h) =>
			h.agentId === agentId &&
			Date.now() - h.timestamp.getTime() < 7 * 24 * 60 * 60 * 1000,
	);

	if (recentHistory.length < 10) {
		return;
	}

	const successRate =
		recentHistory.filter((h) => h.outcome === "success").length /
		recentHistory.length;

	if (successRate >= config.globalSettings.minSuccessRateForIncrease) {
		// Consider increasing trust level
		const nextLevel = getNextTrustLevel(trust.level);
		if (nextLevel !== trust.level) {
			logger.info(
				`[TrustManager] Trust increase candidate: ${agentId} from ${trust.level} to ${nextLevel}`,
			);
			// Note: Actual trust increase should require explicit user action
		}
	}
}

function maybeDecreaseTrust(config: TrustConfiguration, agentId: string): void {
	const trust = config.agentTrust.get(agentId);
	if (!trust) {
		return;
	}

	// Count recent failures
	const recentFailures = config.trustHistory.filter(
		(h) =>
			h.agentId === agentId &&
			h.outcome === "failure" &&
			Date.now() - h.timestamp.getTime() < 24 * 60 * 60 * 1000, // Last 24 hours
	);

	if (recentFailures.length >= 3) {
		// Auto-decrease trust after multiple failures
		const prevLevel = trust.level;
		trust.level = getPreviousTrustLevel(trust.level);
		logger.warn(
			`[TrustManager] Trust decreased: ${agentId} from ${prevLevel} to ${trust.level}`,
		);
	}
}

// =============================================================================
// Utility Functions
// =============================================================================

function inferOperationType(step: TaskStep): string {
	const descLower = step.description.toLowerCase();

	if (descLower.includes("delete") || descLower.includes("remove")) {
		return "delete";
	}
	if (
		descLower.includes("create") ||
		descLower.includes("add") ||
		descLower.includes("new")
	) {
		return "create";
	}
	if (
		descLower.includes("update") ||
		descLower.includes("modify") ||
		descLower.includes("edit")
	) {
		return "update";
	}
	if (descLower.includes("search") || descLower.includes("find")) {
		return "search";
	}
	if (descLower.includes("list") || descLower.includes("show all")) {
		return "list";
	}
	if (
		descLower.includes("get") ||
		descLower.includes("retrieve") ||
		descLower.includes("fetch")
	) {
		return "read";
	}

	return step.type || "unknown";
}

function trustLevelAllowsRisk(
	trustLevel: TrustLevel,
	riskLevel: string,
): boolean {
	const trustValues: Record<TrustLevel, number> = {
		none: 0,
		read: 1,
		write: 2,
		full: 3,
	};

	const riskValues: Record<string, number> = {
		low: 1,
		medium: 2,
		high: 3,
		critical: 4,
	};

	const trustValue = trustValues[trustLevel];
	const riskValue = riskValues[riskLevel] || 2;

	return trustValue >= riskValue - 1;
}

function trustLevelToConfidence(level: TrustLevel): number {
	const confidenceMap: Record<TrustLevel, number> = {
		none: 0,
		read: 0.6,
		write: 0.8,
		full: 0.95,
	};
	return confidenceMap[level];
}

function riskLevelValue(level: string): number {
	const values: Record<string, number> = {
		low: 1,
		medium: 2,
		high: 3,
		critical: 4,
	};
	return values[level] || 2;
}

function getNextTrustLevel(current: TrustLevel): TrustLevel {
	const order: TrustLevel[] = ["none", "read", "write", "full"];
	const currentIndex = order.indexOf(current);
	return order[Math.min(currentIndex + 1, order.length - 1)];
}

function getPreviousTrustLevel(current: TrustLevel): TrustLevel {
	const order: TrustLevel[] = ["none", "read", "write", "full"];
	const currentIndex = order.indexOf(current);
	return order[Math.max(currentIndex - 1, 0)];
}
