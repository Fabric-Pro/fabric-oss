/**
 * Feature Prompt Constants
 *
 * Centralized constants for feature document generation prompts.
 * These constants prevent duplication and ensure consistency.
 */

/**
 * Forbidden section titles that must NOT appear in feature documents
 */
export const USER_STORY_FORBIDDEN_SECTIONS = [
	// Template/Format sections
	"Feature Format Template",
	"Feature Format",
	"Template",
	"Acceptance Criteria Patterns",
	"Acceptance Criteria Template",
	"Feature Sizing Guidelines",
	"Effort and Complexity Guidelines",
	"Example Features",
	"Example Feature 1, 2, 3",
	"Sample Features",
	// Meta-documentation sections
	"Epic Overview",
	"User Personas",
	"User Personas and Goals",
	"Personas",
	"INVEST Validation",
	"Definition of Ready",
	"Definition of Ready (DoR)",
	"Definition of Done",
	"Definition of Done (DoD)",
	"Technical Considerations",
	"Analytics Requirements",
	"Summary",
	"Conclusion",
	"Overview",
	"Project Overview",
	"Introduction",
	"Goals",
	"Primary Need",
	"Success Metrics",
] as const;

/**
 * Forbidden section patterns (for partial matching)
 */
export const USER_STORY_FORBIDDEN_PATTERNS = [
	"Template",
	"Format Template",
	"Patterns",
	"Guidelines",
	"Examples",
	"Example Feature",
	"Sample Features",
	"Persona",
	"INVEST",
	"DoR",
	"DoD",
	"Overview",
	"Introduction",
] as const;

/**
 * Format forbidden sections as a markdown list for prompts
 */
export function formatForbiddenSections(): string {
	return USER_STORY_FORBIDDEN_SECTIONS.map(
		(section) => `❌ "${section}"`,
	).join("\n");
}

/**
 * Format forbidden patterns as a markdown list for prompts
 */
export function formatForbiddenPatterns(): string {
	return USER_STORY_FORBIDDEN_PATTERNS.map(
		(pattern) => `- "${pattern}"`,
	).join("\n");
}

/**
 * Core feature generation requirements
 */
export const USER_STORY_REQUIREMENTS = {
	minStories: 15,
	maxStories: 30,
	storyIdFormat: "F-001, F-002, F-003, etc.",
	epicIdFormat: "EPIC-001, EPIC-002, etc.",
	featureIdFormat: "FEAT-001, FEAT-002, etc.",
	requiredStoryFields: [
		"Story ID",
		"Story statement",
		"Acceptance criteria",
		"Notes / Links",
		"Release Notes",
	],
	hierarchy: "Epic → Feature → Feature Item",
} as const;
