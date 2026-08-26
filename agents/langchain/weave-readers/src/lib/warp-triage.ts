/**
 * Warp 3-Step Triage System
 *
 * Fast-exit heuristics and progressive deep scanning for security reviews.
 */

import { SECURITY_PATTERNS } from "./security-patterns.js";

type Complexity = "minimal" | "partial" | "full";

export interface TriageResult {
	shouldScan: boolean;
	skipReason?: string;
	fileTypes: string[];
	estimatedComplexity: Complexity;
}

export interface PatternMatch {
	file: string;
	line: number;
	pattern: string;
	patternId: string;
	severity: "critical" | "high" | "medium" | "low";
	context: string;
}

interface SecurityFinding {
	id: string;
	patternId: string;
	patternName: string;
	severity: "critical" | "high" | "medium" | "low";
	file: string;
	line: number;
	description: string;
	remediation: string;
	blocking: boolean;
	rfcRefs: string[];
}

export interface ClassifiedFindings {
	blockingIssues: SecurityFinding[];
	nonBlockingIssues: SecurityFinding[];
	summary: {
		total: number;
		critical: number;
		high: number;
		medium: number;
		low: number;
	};
	maxBlockingReached: boolean;
}

// File patterns for fast-exit
const NON_CODE_PATTERNS =
	/\.(md|txt|json|yml|yaml|toml|ini|cfg|conf|config|lock)$/i;
const TEST_PATTERNS = /\.test\.|\.spec\.|__tests__|__mocks__/i;
const CSS_PATTERNS = /\.css$|\.scss$|\.less$|\.sass$/i;
const CONFIG_PATTERNS =
	/^\.?(env|gitignore|dockerignore|prettier|eslint|biome)/i;

// Files that should get full scan based on path
const FULL_SCAN_PATHS = [
	"/auth",
	"/login",
	"/oauth",
	"/jwt",
	"/token",
	"/session",
	"/password",
	"/crypto",
	"/encrypt",
	"/middleware",
	"/permission",
	"middleware",
	".env",
];

const MAX_BLOCKING_ISSUES = 3;

/**
 * Step 1: Diff Scan - Determine if scan is needed and at what depth
 */
export function step1DiffScan(changedFiles: string[]): TriageResult {
	// Empty file list = full scan
	if (!changedFiles || changedFiles.length === 0) {
		return {
			shouldScan: true,
			fileTypes: [],
			estimatedComplexity: "full",
		};
	}

	const fileTypes: string[] = [];

	let hasSecuritySensitive = false;
	let hasCodeFiles = false;

	for (const file of changedFiles) {
		const fileName = file.toLowerCase();

		// Check if security-sensitive
		for (const pattern of FULL_SCAN_PATHS) {
			if (fileName.includes(pattern.toLowerCase())) {
				hasSecuritySensitive = true;
			}
		}

		// Categorize file types
		if (NON_CODE_PATTERNS.test(file)) {
			fileTypes.push("non-code");
		} else if (TEST_PATTERNS.test(file)) {
			fileTypes.push("test");
		} else if (CSS_PATTERNS.test(file)) {
			fileTypes.push("css");
		} else if (CONFIG_PATTERNS.test(file)) {
			fileTypes.push("config");
		} else {
			fileTypes.push("code");
			hasCodeFiles = true;
		}
	}

	// Fast-exit: only non-code files
	const allNonCode = changedFiles.every((f) => NON_CODE_PATTERNS.test(f));
	if (allNonCode) {
		return {
			shouldScan: true,
			skipReason:
				"Only documentation/config files changed - minimal security review needed",
			fileTypes,
			estimatedComplexity: "minimal",
		};
	}

	// Fast-exit: only test files
	const allTests = changedFiles.every((f) => TEST_PATTERNS.test(f));
	if (allTests) {
		return {
			shouldScan: true,
			skipReason:
				"Only test files changed - no security review required for tests",
			fileTypes,
			estimatedComplexity: "minimal",
		};
	}

	// Fast-exit: only CSS/styling
	const allCSS = changedFiles.every((f) => CSS_PATTERNS.test(f));
	if (allCSS) {
		return {
			shouldScan: true,
			skipReason:
				"Only CSS/styling files changed - no security implications",
			fileTypes,
			estimatedComplexity: "minimal",
		};
	}

	// Full scan: security-sensitive files present
	if (hasSecuritySensitive) {
		return {
			shouldScan: true,
			fileTypes,
			estimatedComplexity: "full",
		};
	}

	// Partial scan: code files but no security-sensitive files
	if (hasCodeFiles) {
		return {
			shouldScan: true,
			fileTypes,
			estimatedComplexity: "partial",
		};
	}

	// Default: full scan
	return {
		shouldScan: true,
		fileTypes,
		estimatedComplexity: "full",
	};
}

/**
 * Step 2: Pattern Grep - Search for security patterns
 *
 * Note: This function describes the grep pattern structure.
 * Actual grep execution happens via sandbox tools.
 */
export function getPatternGrepList(): Array<{
	pattern: string;
	patternId: string;
	severity: "critical" | "high" | "medium" | "low";
}> {
	return SECURITY_PATTERNS.flatMap((p) =>
		p.grepPatterns.map((grepPattern) => ({
			pattern: grepPattern,
			patternId: p.id,
			severity: p.severity,
		})),
	);
}

/**
 * Step 3: Deep Review - Classify findings and apply constraints
 */
export function step3DeepReview(
	matches: PatternMatch[],
	_codeContext?: string,
): ClassifiedFindings {
	// Deduplicate matches by file:line
	const uniqueMatches = deduplicateMatches(matches);

	// Convert matches to findings
	const findings: SecurityFinding[] = uniqueMatches.map((match) => {
		const pattern = SECURITY_PATTERNS.find((p) => p.id === match.patternId);
		const category = pattern?.category || "unknown";
		const isBlocking = isBlockingFinding(match.severity, category);

		return {
			id: `${match.patternId}-${match.file}-${match.line}`,
			patternId: match.patternId,
			patternName: pattern?.name || match.patternId,
			severity: match.severity,
			file: match.file,
			line: match.line,
			description:
				pattern?.description || `Security pattern: ${match.patternId}`,
			remediation:
				pattern?.remediation || "Review and fix security issue",
			blocking: isBlocking,
			rfcRefs: pattern?.rfcRefs || [],
		};
	});

	// Sort by severity
	findings.sort((a, b) => {
		const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
		return severityOrder[a.severity] - severityOrder[b.severity];
	});

	// Separate blocking and non-blocking
	const blockingIssues = findings.filter((f) => f.blocking);
	const nonBlockingIssues = findings.filter((f) => !f.blocking);

	// Enforce max blocking issues constraint
	let maxBlockingReached = false;
	if (blockingIssues.length > MAX_BLOCKING_ISSUES) {
		maxBlockingReached = true;
		// Keep only top 3 blocking issues
		blockingIssues.splice(MAX_BLOCKING_ISSUES);
	}

	// Count by severity
	const summary = {
		total: findings.length,
		critical: findings.filter((f) => f.severity === "critical").length,
		high: findings.filter((f) => f.severity === "high").length,
		medium: findings.filter((f) => f.severity === "medium").length,
		low: findings.filter((f) => f.severity === "low").length,
	};

	return {
		blockingIssues,
		nonBlockingIssues,
		summary,
		maxBlockingReached,
	};
}

/**
 * Determine if a finding should be blocking based on severity and category
 *
 * Rules:
 * - CRITICAL severity → always BLOCKING
 * - HIGH severity in auth/crypto/authorization categories → BLOCKING
 * - MEDIUM severity in injection/input validation categories → BLOCKING
 * - All others → NON_BLOCKING
 */
function isBlockingFinding(
	severity: "critical" | "high" | "medium" | "low",
	category: string,
): boolean {
	// CRITICAL is always blocking
	if (severity === "critical") {
		return true;
	}

	// HIGH severity is blocking for security-sensitive categories
	if (severity === "high") {
		const highBlockingCategories = [
			"authentication",
			"authorization",
			"cryptography",
			"secrets",
		];
		return highBlockingCategories.some((cat) =>
			category.toLowerCase().includes(cat),
		);
	}

	// MEDIUM severity is blocking for injection and input validation
	if (severity === "medium") {
		const mediumBlockingCategories = ["injection", "input validation"];
		return mediumBlockingCategories.some((cat) =>
			category.toLowerCase().includes(cat),
		);
	}

	// LOW severity is never blocking
	return false;
}

/**
 * Deduplicate overlapping matches at the same location
 */
function deduplicateMatches(matches: PatternMatch[]): PatternMatch[] {
	const seen = new Set<string>();
	return matches.filter((match) => {
		const key = `${match.file}:${match.line}:${match.patternId}`;
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
}

/**
 * Format findings for display
 */
export function formatFindings(classified: ClassifiedFindings): string {
	const lines: string[] = [];

	lines.push("## Security Review Results\n");

	if (classified.summary.total === 0) {
		lines.push("✅ **No security issues found**\n");
		return lines.join("\n");
	}

	lines.push(`**Summary:** ${classified.summary.total} issue(s) found\n`);
	lines.push(`- 🔴 Critical: ${classified.summary.critical}`);
	lines.push(`- 🟠 High: ${classified.summary.high}`);
	lines.push(`- 🟡 Medium: ${classified.summary.medium}`);
	lines.push(`- 🟢 Low: ${classified.summary.low}\n`);

	if (classified.maxBlockingReached) {
		lines.push(
			`⚠️ **Note:** Showing top ${MAX_BLOCKING_ISSUES} blocking issues.\n`,
		);
	}

	if (classified.blockingIssues.length > 0) {
		lines.push("## 🚨 Blocking Issues\n");
		lines.push("These issues **must be resolved** before proceeding:\n");
		for (const issue of classified.blockingIssues) {
			lines.push(`### ${issue.patternName} (${issue.severity})`);
			lines.push(`**File:** ${issue.file}:${issue.line}`);
			lines.push(`**Description:** ${issue.description}`);
			lines.push(`**Remediation:** ${issue.remediation}`);
			if (issue.rfcRefs.length > 0) {
				lines.push(`**References:** ${issue.rfcRefs.join(", ")}`);
			}
			lines.push("");
		}
	}

	if (classified.nonBlockingIssues.length > 0) {
		lines.push("## ⚠️ Non-Blocking Issues\n");
		lines.push(
			"These issues are **advisory** - consider fixing but not blocking:\n",
		);
		for (const issue of classified.nonBlockingIssues) {
			lines.push(`### ${issue.patternName} (${issue.severity})`);
			lines.push(`**File:** ${issue.file}:${issue.line}`);
			lines.push(`**Remediation:** ${issue.remediation}`);
			lines.push("");
		}
	}

	return lines.join("\n");
}
