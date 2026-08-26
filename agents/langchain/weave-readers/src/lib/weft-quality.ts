/**
 * Weft Quality Checks
 *
 * Quality review checks for code review, plan review, and implementation verification.
 */

export type ReviewMode = "PLAN" | "WORK";

/**
 * Quality check result
 */
export interface QualityCheck {
	id: string;
	name: string;
	description: string;
	severity: "critical" | "high" | "medium" | "low";
	file?: string;
	line?: number;
	context?: string;
	message: string;
	suggestion?: string;
}

/**
 * Quality report
 */
export interface QualityReport {
	mode: ReviewMode;
	checks: QualityCheck[];
	summary: {
		total: number;
		critical: number;
		high: number;
		medium: number;
		low: number;
	};
	verdict: "APPROVE" | "NEEDS_CHANGES" | "REJECT";
	recommendation: string;
}

/**
 * Check for stub code, TODOs, and placeholders
 */
export function checkStubTodoPlaceholder(
	content: string,
	file?: string,
): QualityCheck[] {
	const checks: QualityCheck[] = [];
	const lines = content.split("\n");

	// Common placeholder/stub patterns
	const stubPatterns = [
		{
			regex: /throw\s+new\s+Error\s*\(\s*['"]TODO/i,
			id: "stub-throw",
			name: "Unimplemented throw",
			severity: "high" as const,
		},
		{
			regex: /return\s+null\s*;?\s*(\/\/|\/\*)?.*TODO/i,
			id: "stub-return-null",
			name: "Stub returning null",
			severity: "medium" as const,
		},
		{
			regex: /\/\/\s*TODO:?\s*$/im,
			id: "empty-todo",
			name: "Empty TODO comment",
			severity: "low" as const,
		},
		{
			regex: /\/\/\s*(FIXME|HACK|XXX)\s*$/im,
			id: "empty-fixme",
			name: "Empty FIXME/HACK comment",
			severity: "medium" as const,
		},
		{
			regex: /console\.(log|debug)\s*\(\s*['"]/i,
			id: "console-log",
			name: "Debug console.log",
			severity: "low" as const,
		},
		{
			regex: /console\.(warn|error)\s*\(\s*(['"]Debug|Debug)/i,
			id: "console-debug-warn",
			name: "Debug console.warn/error",
			severity: "medium" as const,
		},
	];

	// Check for stub function bodies
	const stubBodyPatterns = [
		{
			regex: /{\s*}\s*;?\s*$/,
			id: "empty-function",
			name: "Empty function body",
			severity: "high" as const,
		},
		{
			regex: /{\s*throw.*}\s*;?\s*$/,
			id: "throw-function",
			name: "Function that only throws",
			severity: "medium" as const,
		},
		{
			regex: /async\s+\w+\s*\([^)]*\)\s*=>\s*{\s*}\s*;?\s*$/,
			id: "empty-async-arrow",
			name: "Empty async arrow function",
			severity: "medium" as const,
		},
	];

	// Check for placeholder content
	const placeholderPatterns = [
		{
			regex: /^\s*['"`]\s*PLACEHOLDER\s*['"`]\s*;?\s*$/im,
			id: "placeholder-string",
			name: "Placeholder string literal",
			severity: "medium" as const,
		},
		{
			regex: /^\s*\/\/\s*https?:\/\/placeholder/i,
			id: "placeholder-url",
			name: "Placeholder URL",
			severity: "low" as const,
		},
		{
			regex: /example\.(com|org|net)/i,
			id: "placeholder-domain",
			name: "Example domain",
			severity: "low" as const,
		},
	];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const lineNum = i + 1;

		for (const pattern of stubPatterns) {
			if (pattern.regex.test(line)) {
				checks.push({
					id: pattern.id,
					name: pattern.name,
					description: `Found: ${line.trim()}`,
					severity: pattern.severity,
					file,
					line: lineNum,
					context: line.trim(),
					message: `${pattern.name} found`,
					suggestion:
						"Implement the actual logic or remove if not needed",
				});
			}
		}

		for (const pattern of stubBodyPatterns) {
			if (pattern.regex.test(line)) {
				checks.push({
					id: pattern.id,
					name: pattern.name,
					description: "Empty or stub implementation",
					severity: pattern.severity,
					file,
					line: lineNum,
					context: line.trim(),
					message: `${pattern.name} detected`,
					suggestion: "Fill in the actual implementation",
				});
			}
		}

		for (const pattern of placeholderPatterns) {
			if (pattern.regex.test(line)) {
				checks.push({
					id: pattern.id,
					name: pattern.name,
					description: "Placeholder content",
					severity: pattern.severity,
					file,
					line: lineNum,
					context: line.trim(),
					message: `${pattern.name} found`,
					suggestion: "Replace with actual content",
				});
			}
		}
	}

	return checks;
}

/**
 * Detect fake or ineffective tests
 */
export function detectFakeTests(
	content: string,
	file?: string,
): QualityCheck[] {
	const checks: QualityCheck[] = [];
	const lines = content.split("\n");

	// Patterns that indicate fake/weak tests
	const fakeTestPatterns = [
		{
			regex: /^\s*(it|test|describe)\s*\([^)]*\)\s*,\s*\(\s*\)\s*=>\s*{\s*}\s*\)/,
			id: "empty-test-body",
			name: "Empty test body",
			severity: "critical" as const,
			suggestion: "Add actual test assertions",
		},
		{
			regex: /^\s*(it|test)\s*\([^)]*\)\s*,\s*\(\s*\)\s*=>\s*{\s*assert\.(true|false|ok)\s*\(\s*true\s*\)/,
			id: "always-pass-test",
			name: "Always-pass assertion",
			severity: "high" as const,
			suggestion: "Test actual conditions, not just true",
		},
		{
			regex: /^\s*(it|test)\s*\([^)]*\)\s*,\s*\(\s*\)\s*=>\s*{\s*}\s*;?\s*$/,
			id: "empty-test-function",
			name: "Empty test function",
			severity: "critical" as const,
			suggestion: "Add test implementation",
		},
		{
			regex: /\btodo\s*\(\s*\)/i,
			id: "todo-in-test",
			name: "Unimplemented test (todo)",
			severity: "medium" as const,
			suggestion: "Implement the test or remove if not needed",
		},
		{
			regex: /skip\s*\(\s*\)/i,
			id: "skipped-test",
			name: "Skipped test",
			severity: "low" as const,
			suggestion: "Unskip test or remove if not applicable",
		},
	];

	// Check for missing assertions
	const testFunctionRegex =
		/(?:it|test|describe)\s*\([^)]*\)\s*,\s*(?:\([^)]*\)\s*=>|[a-zA-Z_]\w*)\s*{([^}]*)}/g;
	let match: RegExpExecArray | null;
	while (true) {
		match = testFunctionRegex.exec(content);
		if (match === null) {
			break;
		}
		const body = match[1];
		if (
			!body.includes("assert") &&
			!body.includes("expect") &&
			!body.includes("should")
		) {
			const lineNum = content
				.substring(0, match.index)
				.split("\n").length;
			checks.push({
				id: "missing-assertion",
				name: "Test missing assertions",
				description: "Test body does not contain assertions",
				severity: "high" as const,
				file,
				line: lineNum,
				message: "Test has no assertions",
				suggestion: "Add proper assertions to verify expected behavior",
			});
		}
	}

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const lineNum = i + 1;

		for (const pattern of fakeTestPatterns) {
			if (pattern.regex.test(line)) {
				checks.push({
					id: pattern.id,
					name: pattern.name,
					description: "Weak or fake test pattern",
					severity: pattern.severity,
					file,
					line: lineNum,
					context: line.trim(),
					message: `${pattern.name} detected`,
					suggestion: pattern.suggestion,
				});
			}
		}
	}

	return checks;
}

/**
 * Check for scope creep in implementation vs spec
 */
export function checkScopeCreep(
	implementation: string,
	spec: string,
): QualityCheck[] {
	const checks: QualityCheck[] = [];

	// Extract key terms from spec
	const specTerms = extractKeyTerms(spec);
	const implTerms = extractKeyTerms(implementation);

	// Find terms in spec but not in implementation (missing features)
	const missingTerms = specTerms.filter(
		(term) => term.length > 4 && !implTerms.includes(term),
	);

	// Find terms in implementation but not in spec (creep)
	const extraTerms = implTerms.filter(
		(term) => term.length > 4 && !specTerms.includes(term),
	);

	if (missingTerms.length > 0) {
		checks.push({
			id: "missing-features",
			name: "Missing features from spec",
			description: "Some spec requirements not found in implementation",
			severity: "high",
			message: `Potentially missing: ${missingTerms.slice(0, 5).join(", ")}${missingTerms.length > 5 ? "..." : ""}`,
			suggestion: "Verify all spec requirements are implemented",
		});
	}

	if (extraTerms.length > implTerms.length * 0.5) {
		checks.push({
			id: "scope-creep",
			name: "Potential scope creep",
			description: "Implementation has many terms not in spec",
			severity: "medium",
			message:
				"Implementation may have extra features not in original spec",
			suggestion: "Review if all implementation features are intentional",
		});
	}

	return checks;
}

/**
 * Extract key terms from text
 */
function extractKeyTerms(text: string): string[] {
	// Remove common words and extract significant terms
	const commonWords = new Set([
		"the",
		"a",
		"an",
		"and",
		"or",
		"but",
		"in",
		"on",
		"at",
		"to",
		"for",
		"of",
		"with",
		"by",
		"from",
		"as",
		"is",
		"was",
		"are",
		"were",
		"been",
		"be",
		"have",
		"has",
		"had",
		"do",
		"does",
		"did",
		"will",
		"would",
		"could",
		"should",
		"may",
		"might",
		"must",
		"shall",
		"can",
		"need",
		"this",
		"that",
		"these",
		"those",
		"it",
		"its",
		"they",
		"them",
		"function",
		"class",
		"interface",
		"type",
		"const",
		"let",
		"var",
		"if",
		"else",
		"when",
		"then",
		"return",
		"true",
		"false",
		"null",
		"undefined",
		"async",
		"await",
		"import",
		"export",
		"from",
		"require",
	]);

	// Split on non-word characters and filter
	const words = text
		.split(/[\s\n\r\t,;:.()[\]{}<>!?@#$%^&*+=\\-_'"`~/]+/)
		.map((w) => w.toLowerCase())
		.filter((w) => w.length > 3 && !commonWords.has(w));

	return [...new Set(words)];
}

/**
 * Generate overall quality verdict
 */
export function generateVerdict(
	mode: ReviewMode,
	checks: QualityCheck[],
): { verdict: QualityReport["verdict"]; recommendation: string } {
	const criticalCount = checks.filter(
		(c) => c.severity === "critical",
	).length;
	const highCount = checks.filter((c) => c.severity === "high").length;
	const totalIssues = checks.length;

	if (mode === "PLAN") {
		// For plans, be more lenient
		if (criticalCount > 0) {
			return {
				verdict: "NEEDS_CHANGES",
				recommendation:
					"Plan has critical gaps. Address before proceeding.",
			};
		}
		if (highCount > 2) {
			return {
				verdict: "NEEDS_CHANGES",
				recommendation:
					"Plan has significant gaps. Refine before implementation.",
			};
		}
		return {
			verdict: "APPROVE",
			recommendation: "Plan looks solid. Ready for implementation.",
		};
	}

	// For WORK mode (implementation review)
	if (criticalCount > 0) {
		return {
			verdict: "REJECT",
			recommendation: "Critical issues found. Must fix before approval.",
		};
	}
	if (highCount > 0) {
		return {
			verdict: "NEEDS_CHANGES",
			recommendation: "High severity issues found. Address these issues.",
		};
	}
	if (totalIssues > 5) {
		return {
			verdict: "NEEDS_CHANGES",
			recommendation: "Too many minor issues. Clean up before approval.",
		};
	}
	return {
		verdict: "APPROVE",
		recommendation: "Implementation looks good. Approved.",
	};
}

/**
 * Format quality report for display
 */
export function formatQualityReport(report: QualityReport): string {
	const lines: string[] = [];

	lines.push(`## Quality Review (${report.mode} mode)\n`);

	// Verdict banner
	const verdictEmoji =
		report.verdict === "APPROVE"
			? "✅"
			: report.verdict === "NEEDS_CHANGES"
				? "⚠️"
				: "❌";
	lines.push(`${verdictEmoji} **${report.verdict}**\n`);
	lines.push(`${report.recommendation}\n`);

	// Summary
	lines.push("**Summary:**");
	lines.push(`- Total issues: ${report.summary.total}`);
	if (report.summary.critical > 0) {
		lines.push(`- 🔴 Critical: ${report.summary.critical}`);
	}
	if (report.summary.high > 0) {
		lines.push(`- 🟠 High: ${report.summary.high}`);
	}
	if (report.summary.medium > 0) {
		lines.push(`- 🟡 Medium: ${report.summary.medium}`);
	}
	if (report.summary.low > 0) {
		lines.push(`- 🟢 Low: ${report.summary.low}`);
	}
	lines.push("");

	// Issues by severity
	const sortedChecks = [...report.checks].sort((a, b) => {
		const order = { critical: 0, high: 1, medium: 2, low: 3 };
		return order[a.severity] - order[b.severity];
	});

	if (sortedChecks.length > 0) {
		lines.push("## Issues Found\n");
		for (const check of sortedChecks) {
			const emoji =
				check.severity === "critical"
					? "🚨"
					: check.severity === "high"
						? "🔴"
						: check.severity === "medium"
							? "🟡"
							: "🟢";

			lines.push(`${emoji} **${check.name}** (${check.severity})`);
			if (check.file) {
				lines.push(
					`   File: ${check.file}${check.line ? `:${check.line}` : ""}`,
				);
			}
			lines.push(`   ${check.message}`);
			if (check.suggestion) {
				lines.push(`   💡 ${check.suggestion}`);
			}
			lines.push("");
		}
	}

	return lines.join("\n");
}

/**
 * Run all quality checks on content
 */
export function runQualityChecks(
	content: string,
	mode: ReviewMode,
	file?: string,
): QualityReport {
	const allChecks: QualityCheck[] = [];

	// Run all check types
	allChecks.push(...checkStubTodoPlaceholder(content, file));
	allChecks.push(...detectFakeTests(content, file));

	// Calculate summary
	const summary = {
		total: allChecks.length,
		critical: allChecks.filter((c) => c.severity === "critical").length,
		high: allChecks.filter((c) => c.severity === "high").length,
		medium: allChecks.filter((c) => c.severity === "medium").length,
		low: allChecks.filter((c) => c.severity === "low").length,
	};

	const { verdict, recommendation } = generateVerdict(mode, allChecks);

	return {
		mode,
		checks: allChecks,
		summary,
		verdict,
		recommendation,
	};
}
