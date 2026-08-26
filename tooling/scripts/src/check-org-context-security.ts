#!/usr/bin/env tsx
/**
 * Security Check: Organization Context Access Patterns
 *
 * This script checks for unsafe patterns that can cause data leakage between
 * organization and personal contexts.
 *
 * Run: pnpm tsx tooling/scripts/src/check-org-context-security.ts
 *
 * The script will:
 * 1. Find any direct usage of `activeOrganization?.id` or `activeOrganization?.slug`
 * 2. Report violations that could cause security issues
 * 3. Exit with code 1 if violations are found
 *
 * Safe alternative: Use `useOrganizationContext()` from
 * `@saas/organizations/hooks/use-organization-context`
 */

import { execSync } from "node:child_process";
import * as path from "node:path";

const UNSAFE_PATTERNS = [
	{
		pattern: "activeOrganization\\?\\.id",
		description: "Direct access to activeOrganization?.id",
		fix: "Use useOrganizationContext().organizationId instead",
	},
	{
		pattern: "activeOrganization\\?\\.slug",
		description: "Direct access to activeOrganization?.slug",
		fix: "Use useOrganizationContext().organizationSlug instead",
	},
];

// Files that are allowed to use these patterns (the hook implementation itself)
const ALLOWED_FILES = [
	"use-organization-context.ts",
	"active-organization-context.tsx",
	"use-active-organization.ts",
];

interface Violation {
	file: string;
	line: number;
	pattern: string;
	description: string;
	fix: string;
}

function findViolations(): Violation[] {
	const violations: Violation[] = [];
	const webAppPath = path.join(process.cwd(), "apps/web");

	for (const { pattern, description, fix } of UNSAFE_PATTERNS) {
		try {
			// Use grep to find violations
			const result = execSync(
				`grep -rn "${pattern}" "${webAppPath}" --include="*.ts" --include="*.tsx" 2>/dev/null || true`,
				{ encoding: "utf-8" },
			);

			if (result.trim()) {
				const lines = result.trim().split("\n");
				for (const line of lines) {
					// Parse grep output: file:lineNumber:content
					const match = line.match(/^(.+?):(\d+):(.*)$/);
					if (match) {
						const [, filePath, lineNum] = match;
						const fileName = path.basename(filePath);

						// Skip allowed files
						if (ALLOWED_FILES.includes(fileName)) {
							continue;
						}

						violations.push({
							file: filePath,
							line: Number.parseInt(lineNum, 10),
							pattern,
							description,
							fix,
						});
					}
				}
			}
		} catch {
			// grep returns non-zero if no matches, which is fine
		}
	}

	return violations;
}

function main() {
	console.log("🔒 Security Check: Organization Context Access Patterns\n");
	console.log(
		"Checking for unsafe patterns that can cause data leakage...\n",
	);

	const violations = findViolations();

	if (violations.length === 0) {
		console.log("✅ No security violations found!\n");
		console.log(
			"All organization context access is using the safe useOrganizationContext() hook.",
		);
		process.exit(0);
	}

	console.log(`❌ Found ${violations.length} security violation(s):\n`);

	for (const violation of violations) {
		console.log(`  📁 ${violation.file}:${violation.line}`);
		console.log(`     Pattern: ${violation.description}`);
		console.log(`     Fix: ${violation.fix}\n`);
	}

	console.log("─".repeat(60));
	console.log(
		"\n⚠️  SECURITY ISSUE: These patterns can leak organization data",
	);
	console.log("   to personal pages when users switch contexts.\n");
	console.log("   The safe pattern is to use:\n");
	console.log(
		'   import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";',
	);
	console.log(
		"   const { organizationId, organizationSlug } = useOrganizationContext();\n",
	);

	process.exit(1);
}

main();
