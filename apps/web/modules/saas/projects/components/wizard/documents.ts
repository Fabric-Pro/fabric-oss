export type ProjectDocumentType =
	| "GENERAL"
	| "BUSINESS_CASE"
	| "PRD"
	| "PROPOSAL"
	| "ARCHITECTURE"
	| "TECHNICAL_SPEC"
	| "USER_STORY"
	| "API_SPEC";

/**
 * Document generation tiers: PRD/Proposal first, Technical docs second, Features last.
 * Higher tiers require at least one prerequisite (OR) to be selected or exist.
 */

export const DOCUMENT_TIERS: Record<
	string,
	{ tier: number; prerequisites: string[] }
> = {
	PRD: { tier: 1, prerequisites: [] },
	BUSINESS_CASE: { tier: 1, prerequisites: [] },
	PROPOSAL: { tier: 1, prerequisites: [] },
	ARCHITECTURE: { tier: 2, prerequisites: ["PRD", "PROPOSAL"] },
	TECHNICAL_SPEC: { tier: 2, prerequisites: ["PRD", "PROPOSAL"] },
	API_SPEC: { tier: 2, prerequisites: ["PRD", "PROPOSAL"] },
	USER_STORY: {
		tier: 3,
		prerequisites: ["ARCHITECTURE", "TECHNICAL_SPEC", "API_SPEC"],
	},
	GENERAL: { tier: 1, prerequisites: [] },
};

function getDocumentPrerequisites(type: string): string[] {
	return DOCUMENT_TIERS[type]?.prerequisites ?? [];
}

/**
 * Returns true if the document type can be selected given the set of satisfied types
 * (selected or existing). Prerequisites are OR: at least one must be satisfied.
 */
export function isDocumentAvailable(
	type: string,
	satisfiedTypes: Set<string>,
): boolean {
	const config = DOCUMENT_TIERS[type];
	if (!config || config.prerequisites.length === 0) {
		return true;
	}
	return config.prerequisites.some((p) => satisfiedTypes.has(p));
}

/** Returns the prerequisite hint for unavailable docs (e.g. "Generate PRD or Proposal first") */
export function getPrerequisiteHint(type: string): string {
	const prereqs = getDocumentPrerequisites(type);
	if (prereqs.length === 0) {
		return "";
	}
	const names: Record<string, string> = {
		PRD: "PRD",
		BUSINESS_CASE: "Business Case",
		PROPOSAL: "Proposal",
		ARCHITECTURE: "Architecture",
		TECHNICAL_SPEC: "Technical Spec",
		API_SPEC: "API Spec",
		USER_STORY: "Features",
	};
	const label = prereqs.map((p) => names[p] ?? p).join(" or ");
	return `Generate ${label} first`;
}

export type Recommendation = {
	type: ProjectDocumentType;
	title: string;
	description: string;
	suggestedPrompt?: string;
	score?: number;
};

export type DocumentSelection = {
	type: ProjectDocumentType;
	title: string;
	description: string;
	prompt: string;
	selected: boolean;
	promptId?: string; // NEW: Optional custom prompt ID from Prompt Library
};

export const DEFAULT_DOCUMENT_META: Record<
	ProjectDocumentType,
	{ title: string; description: string; defaultPrompt: string }
> = {
	BUSINESS_CASE: {
		title: "Business Case",
		description:
			"Decision ask, options considered, recommendation, value, and risks",
		defaultPrompt: "",
	},
	PRD: {
		title: "Product Requirements Document",
		description:
			"Benefit hypothesis, requirements, success metrics, and key flows",
		defaultPrompt: "",
	},
	PROPOSAL: {
		title: "Project Proposal",
		description:
			"Benefit hypothesis, scope, deliverables, phases, and success metrics",
		defaultPrompt: "",
	},
	ARCHITECTURE: {
		title: "Technical Architecture",
		description: "System design, components, data flow, and infrastructure",
		defaultPrompt: "",
	},
	TECHNICAL_SPEC: {
		title: "Technical Specification",
		description:
			"Detailed technical requirements and implementation details",
		defaultPrompt: "",
	},
	USER_STORY: {
		title: "Features",
		description:
			"Actionable features with acceptance criteria in Given/When/Then format",
		defaultPrompt: "",
	},
	API_SPEC: {
		title: "API Specification",
		description:
			"API endpoints, request/response formats, and authentication",
		defaultPrompt: "",
	},
	GENERAL: {
		title: "General Document",
		description: "General notes or documentation",
		defaultPrompt: "",
	},
};

export function makePreloadedDocs(
	selected: ProjectDocumentType[],
): DocumentSelection[] {
	const selectedSet = new Set(selected);
	return Array.from(selectedSet).map((type) => {
		const meta = DEFAULT_DOCUMENT_META[type];
		return {
			type,
			title: meta.title,
			description: meta.description,
			prompt: meta.defaultPrompt,
			selected: true,
		} satisfies DocumentSelection;
	});
}

export function mergeSelectedWithRecommendations(
	selected: ProjectDocumentType[],
	recs: Recommendation[],
): DocumentSelection[] {
	const selectedSet = new Set(selected);
	const recByType = new Map(recs.map((r) => [r.type, r] as const));

	if (selectedSet.size > 0) {
		// User made explicit selections in Step 4 - only show those documents
		// Enhanced with recommendation metadata (title, description, prompt) when available
		const selectedDocs: DocumentSelection[] = Array.from(selectedSet).map(
			(type) => {
				const rec = recByType.get(type);
				const meta = DEFAULT_DOCUMENT_META[type];
				return {
					type,
					title: rec?.title ?? meta.title,
					description: rec?.description ?? meta.description,
					prompt: "",
					selected: true,
				} satisfies DocumentSelection;
			},
		);

		// Don't add extra documents - respect user's explicit Step 4 selection
		return selectedDocs;
	}

	// No documents selected - return empty array
	// User can generate documents later from the project page
	return [];
}
