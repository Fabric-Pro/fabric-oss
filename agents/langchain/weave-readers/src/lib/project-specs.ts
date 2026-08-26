/**
 * Project-Specific Security Specs
 *
 * Loads and validates project-specific security configurations from .weave/specs.json
 */

import { z } from "zod";
import type { SandboxClient } from "./sandbox-client.js";

/**
 * Load project specs from sandbox
 * Attempts to read .weave/specs.json from sandbox root
 */
export async function loadProjectSpecs(
	sandbox: SandboxClient,
): Promise<ProjectSpecs | null> {
	try {
		const content = await sandbox.readFile(".weave/specs.json");
		if (!content || content.trim().length === 0) {
			return null;
		}
		return parseProjectSpecs(content);
	} catch {
		// File doesn't exist or can't be read
		return null;
	}
}

/**
 * Project-specific security specs schema
 */
export const ProjectSpecsSchema = z.object({
	customPatterns: z
		.array(
			z.object({
				id: z.string(),
				name: z.string(),
				severity: z.enum(["critical", "high", "medium", "low"]),
				grepPatterns: z.array(z.string()),
				filePatterns: z.array(z.string()).optional(),
				description: z.string(),
				remediation: z.string(),
				category: z.string().optional(),
				rfcRefs: z.array(z.string()).optional(),
			}),
		)
		.optional()
		.default([]),
	disabledPatterns: z.array(z.string()).optional().default([]),
	extraSpecs: z.array(z.string()).optional().default([]),
	minSeverity: z.enum(["critical", "high", "medium", "low"]).optional(),
	enabledCategories: z.array(z.string()).optional(),
	disabledCategories: z.array(z.string()).optional(),
});

export type ProjectSpecs = z.infer<typeof ProjectSpecsSchema>;

/**
 * Load project specs from JSON string
 */
export function parseProjectSpecs(json: string): ProjectSpecs | null {
	try {
		const parsed = JSON.parse(json);
		return ProjectSpecsSchema.parse(parsed);
	} catch {
		return null;
	}
}

/**
 * Validate project specs and return validation result
 */
export function validateProjectSpecs(
	json: string,
): { valid: true; specs: ProjectSpecs } | { valid: false; error: string } {
	try {
		const parsed = JSON.parse(json);
		const specs = ProjectSpecsSchema.parse(parsed);
		return { valid: true, specs };
	} catch (error) {
		if (error instanceof z.ZodError) {
			const issues = error.issues
				.map((i) => `${i.path.join(".")}: ${i.message}`)
				.join(", ");
			return { valid: false, error: `Validation failed: ${issues}` };
		}
		return { valid: false, error: `Invalid JSON: ${error}` };
	}
}

/**
 * Merge project specs with default security patterns
 */
export function mergeWithDefaults(
	projectSpecs: ProjectSpecs,
	defaultPatterns: Array<{
		id: string;
		name: string;
		severity: "critical" | "high" | "medium" | "low";
		grepPatterns: string[];
		filePatterns?: string[];
		description: string;
		remediation: string;
		category?: string;
		rfcRefs?: string[];
	}>,
): typeof defaultPatterns {
	let patterns = [...defaultPatterns];

	// Remove disabled patterns
	const disabledPatterns = projectSpecs.disabledPatterns ?? [];
	if (disabledPatterns.length > 0) {
		const disabledSet = new Set(disabledPatterns);
		patterns = patterns.filter((p) => !disabledSet.has(p.id));
	}

	// Add custom patterns
	const customPatterns = projectSpecs.customPatterns ?? [];
	if (customPatterns.length > 0) {
		const customAsDefault = customPatterns.map((cp) => ({
			id: cp.id,
			name: cp.name,
			severity: cp.severity,
			grepPatterns: cp.grepPatterns,
			filePatterns: cp.filePatterns,
			description: cp.description,
			remediation: cp.remediation,
			category: cp.category,
			rfcRefs: cp.rfcRefs,
		}));
		patterns = [...patterns, ...customAsDefault];
	}

	// Filter by enabled/disabled categories
	const enabledCategories = projectSpecs.enabledCategories ?? [];
	const disabledCategories = projectSpecs.disabledCategories ?? [];
	if (enabledCategories.length > 0) {
		const enabledSet = new Set(enabledCategories);
		patterns = patterns.filter(
			(p) => !p.category || enabledSet.has(p.category),
		);
	}
	if (disabledCategories.length > 0) {
		const disabledCatSet = new Set(disabledCategories);
		patterns = patterns.filter(
			(p) => !p.category || !disabledCatSet.has(p.category),
		);
	}

	// Filter by minSeverity
	if (projectSpecs.minSeverity) {
		const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
		const minLevel = severityOrder[projectSpecs.minSeverity];
		patterns = patterns.filter(
			(p) => severityOrder[p.severity] <= minLevel,
		);
	}

	return patterns;
}

/**
 * Format project specs as markdown for display
 */
export function formatProjectSpecsDisplay(specs: ProjectSpecs): string {
	const lines: string[] = [];

	lines.push("## Project Security Configuration\n");

	if (specs.customPatterns.length > 0) {
		lines.push(`**Custom Patterns:** ${specs.customPatterns.length}`);
		for (const p of specs.customPatterns) {
			lines.push(`  - ${p.name} (${p.severity})`);
		}
	}

	if (specs.disabledPatterns.length > 0) {
		lines.push(
			`\n**Disabled Patterns:** ${specs.disabledPatterns.join(", ")}`,
		);
	}

	if (specs.extraSpecs.length > 0) {
		lines.push(`\n**Extra Specs:** ${specs.extraSpecs.join(", ")}`);
	}

	if (specs.minSeverity) {
		lines.push(`\n**Minimum Severity:** ${specs.minSeverity}`);
	}

	const displayEnabledCats = specs.enabledCategories ?? [];
	const displayDisabledCats = specs.disabledCategories ?? [];
	if (displayEnabledCats.length > 0 || displayDisabledCats.length > 0) {
		lines.push("\n**Categories:**");
		if (displayEnabledCats.length > 0) {
			lines.push(`  Enabled: ${displayEnabledCats.join(", ")}`);
		}
		if (displayDisabledCats.length > 0) {
			lines.push(`  Disabled: ${displayDisabledCats.join(", ")}`);
		}
	}

	return lines.join("\n");
}
