/**
 * Risk Assessment — Pure Deterministic Functions
 *
 * Shared risk assessment logic used by BOTH upfront execution and iterative
 * execution phases. These are pure functions with no I/O, safe for Temporal
 * workflow replay.
 *
 * Issue #3: Unify risk assessment into shared pure function
 *
 * This replaces the duplicated, simplified `assessToolCallRisk` that was
 * inlined in iterative-execution.ts with a single implementation used by
 * both execution paths.
 */

import { isFabricOwnedRead } from "./fabric-catalog-access";

// =============================================================================
// Types
// =============================================================================

export interface ToolCallForRisk {
	name: string;
	args: Record<string, unknown>;
}

export interface RiskAssessmentResult {
	riskLevel: "low" | "medium" | "high" | "critical";
	requiresApproval: boolean;
	reason?: string;
}

export type AutonomyLevel = "CONSERVATIVE" | "BALANCED" | "AUTONOMOUS";

/**
 * Which matching rules decide the risk. `legacy` substring-matches keywords
 * against the tool name AND the serialized arguments, so a read-only search
 * whose query mentions "unclear", "removed from scope" or "all" was held for
 * delete approval. `read-only-exempt-v1` never scans a Fabric-owned read,
 * keeps substring matching on the tool name (short, server-chosen, and where
 * `bulkdelete` must still read as a delete), and matches the arguments by
 * word, inflections included. The loop picks the version behind a patch
 * marker, so a recorded history keeps the decision it was made with.
 */
export type RiskRules = "legacy" | "read-only-exempt-v1";

export interface RiskAssessmentOptions {
	rules: RiskRules;
	/**
	 * The loop will run this call itself or through the Fabric catalog, not
	 * through a user's MCP server. Only then can a read be vouched for.
	 */
	fabricRouted?: boolean;
}

/**
 * Configuration for how autonomy levels affect approval requirements
 */
const AUTONOMY_CONFIG: Record<
	AutonomyLevel,
	{ approveRiskLevels: Array<RiskAssessmentResult["riskLevel"]> }
> = {
	CONSERVATIVE: {
		// Conservative: Approve medium, high, and critical
		approveRiskLevels: ["medium", "high", "critical"],
	},
	BALANCED: {
		// Balanced: Approve high and critical only (default)
		approveRiskLevels: ["high", "critical"],
	},
	AUTONOMOUS: {
		// Autonomous: Only critical requires approval
		approveRiskLevels: ["critical"],
	},
};

// =============================================================================
// Keywords
// =============================================================================

const DESTRUCTIVE_KEYWORDS = [
	"delete",
	"remove",
	"destroy",
	"purge",
	"erase",
	"drop",
	"truncate",
	"archive",
	"clear",
];

const BULK_KEYWORDS = ["bulk", "batch", "all", "every", "multiple", "mass"];

const MODIFY_KEYWORDS = [
	"create",
	"update",
	"add",
	"modify",
	"write",
	"set",
	"put",
	"patch",
];

// =============================================================================
// Pure Functions
// =============================================================================

/**
 * Assess the risk level of a tool call.
 *
 * Used by both upfront execution (execution.ts step-level risk) and
 * iterative execution (iterative-execution.ts per-tool-call risk).
 *
 * Detection logic:
 * - Destructive keywords → high risk (critical if bulk)
 * - Bulk modify keywords → high risk
 * - Single modify operations → medium risk (no approval)
 * - Everything else → low risk
 *
 * Returns keyword match details in the reason for transparency.
 */
/**
 * Tools that should be excluded from bulk/destructive risk assessment.
 * These are Fabric content-creation tools whose arguments commonly contain
 * words like "all", "every", "batch" in descriptions/content but are not
 * actually performing bulk or destructive operations.
 */
const RISK_EXEMPT_TOOLS = new Set([
	// Excalidraw
	"create_view",
	// First-class Frame tools — content creation, not bulk/destructive
	"fabric_create_frame",
	"fabric_create_slideshow",
	"fabric_update_frame",
	"fabric_get_frame",
	"fabric_list_frames",
	"fabric_share_frame",
]);

/**
 * Lower-cased words of argument text. Splits on anything not a letter or
 * digit, at camelCase humps and at acronym boundaries, so `HTTPDelete` gives
 * `http`, `delete` and `removeAll` gives `remove`, `all`.
 */
function wordsOf(text: string): string[] {
	return text
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
}

const INFLECTION_SUFFIXES = [
	"",
	"s",
	"es",
	"d",
	"ed",
	"ing",
	"al",
	"ion",
	"ure",
];

/**
 * A keyword and its common inflections: `delete` → deletes, deleted,
 * deleting, deletion; `remove` → removal; `drop` → dropped; `erase` →
 * erasure. Only whole words are compared, so `unclear`, `address`, `call` and
 * `small` never match `clear`, `add` or `all`.
 */
function matchesKeyword(word: string, keyword: string): boolean {
	const stems = [keyword];
	if (keyword.endsWith("e")) {
		stems.push(keyword.slice(0, -1));
	}
	if (/[^aeiou][aeiou][bdgmnpt]$/.test(keyword)) {
		stems.push(keyword + keyword[keyword.length - 1]);
	}
	return stems.some(
		(stem) =>
			word.startsWith(stem) &&
			INFLECTION_SUFFIXES.includes(word.slice(stem.length)),
	);
}

export function assessToolCallRisk(
	toolCall: ToolCallForRisk,
	autonomyLevel: AutonomyLevel = "BALANCED",
	options: RiskAssessmentOptions = { rules: "legacy" },
): RiskAssessmentResult {
	const toolNameLower = toolCall.name.toLowerCase();
	const autonomyConfig = AUTONOMY_CONFIG[autonomyLevel];
	const legacy = options.rules === "legacy";

	if (
		!legacy &&
		isFabricOwnedRead(toolCall.name, options.fabricRouted === true)
	) {
		return {
			riskLevel: "low",
			requiresApproval: autonomyConfig.approveRiskLevels.includes("low"),
			reason: undefined,
		};
	}

	// Content creation tools are exempt from bulk/destructive keyword scanning
	// because their content arguments commonly contain false-positive trigger words
	if (RISK_EXEMPT_TOOLS.has(toolCall.name)) {
		return {
			riskLevel: "low",
			requiresApproval: false,
			reason: `Content tool: ${toolCall.name}`,
		};
	}

	const argsString = JSON.stringify(toolCall.args).toLowerCase();
	const argWords = legacy ? [] : wordsOf(JSON.stringify(toolCall.args) ?? "");
	const inName = (kw: string) => toolNameLower.includes(kw);
	const inArgs = (kw: string) =>
		legacy
			? argsString.includes(kw)
			: argWords.some((word) => matchesKeyword(word, kw));

	// Check for destructive operations and capture matched keywords
	const matchedDestructive = DESTRUCTIVE_KEYWORDS.filter(
		(kw) => inName(kw) || inArgs(kw),
	);
	const isDestructive = matchedDestructive.length > 0;

	// Check for bulk operations and capture matched keywords
	const matchedBulk = BULK_KEYWORDS.filter((kw) => inName(kw) || inArgs(kw));
	const isBulk = matchedBulk.length > 0;

	// Build keyword source info (tool name vs args)
	const describeMatches = (keywords: string[], label: string) => {
		const nameHits = keywords.filter(inName);
		const argHits = keywords.filter((kw) => inArgs(kw) && !inName(kw));
		const parts: string[] = [];
		if (nameHits.length > 0) {
			parts.push(
				`${label} in tool name: ${nameHits.map((k) => `'${k}'`).join(", ")}`,
			);
		}
		if (argHits.length > 0) {
			parts.push(
				`${label} in args: ${argHits.map((k) => `'${k}'`).join(", ")}`,
			);
		}
		return parts.join("; ");
	};

	if (isDestructive) {
		const _triggerDetails = [
			describeMatches(matchedDestructive, "destructive"),
			isBulk ? describeMatches(matchedBulk, "bulk") : "",
		]
			.filter(Boolean)
			.join(" | ");

		const riskLevel: RiskAssessmentResult["riskLevel"] = isBulk
			? "critical"
			: "high";
		return {
			riskLevel,
			requiresApproval:
				autonomyConfig.approveRiskLevels.includes(riskLevel),
			reason: isBulk
				? `This action will delete or remove items in bulk using ${toolCall.name}. Please review before proceeding.`
				: `This action may delete or remove data using ${toolCall.name}. Please confirm to proceed.`,
		};
	}

	// Check for create/update operations
	const isModifying = MODIFY_KEYWORDS.some(inName);

	if (isModifying && isBulk) {
		const riskLevel: RiskAssessmentResult["riskLevel"] = "high";
		return {
			riskLevel,
			requiresApproval:
				autonomyConfig.approveRiskLevels.includes(riskLevel),
			reason: `This action will modify multiple items using ${toolCall.name}. Please review before proceeding.`,
		};
	}

	if (isModifying) {
		const riskLevel: RiskAssessmentResult["riskLevel"] = "medium";
		return {
			riskLevel,
			requiresApproval:
				autonomyConfig.approveRiskLevels.includes(riskLevel),
			reason: undefined,
		};
	}

	// Read operations are low risk
	return {
		riskLevel: "low",
		requiresApproval: autonomyConfig.approveRiskLevels.includes("low"),
		reason: undefined,
	};
}

/**
 * Determines if a step description indicates a destructive operation.
 * Used by the execution phase for step-level risk assessment.
 */
export function isDestructiveStep(description: string): boolean {
	const lower = description.toLowerCase();
	return DESTRUCTIVE_KEYWORDS.some((kw) => lower.includes(kw));
}

/**
 * Determines if a step description indicates a bulk operation.
 * Used by the execution phase for step-level risk assessment.
 */
export function isBulkOperation(description: string): boolean {
	const lower = description.toLowerCase();
	const bulkIndicators = [...BULK_KEYWORDS, "each", "list of", "matching"];
	return bulkIndicators.some((indicator) => lower.includes(indicator));
}
