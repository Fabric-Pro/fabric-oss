/**
 * Document Recommendation System
 *
 * Intelligently suggests document types based on project characteristics
 */

type ProjectDocumentType =
	| "GENERAL"
	| "BUSINESS_CASE"
	| "DESIGN_SYSTEM"
	| "PRD"
	| "PROPOSAL"
	| "ARCHITECTURE"
	| "TECHNICAL_SPEC"
	| "USER_STORY"
	| "API_SPEC";

export interface DocumentRecommendation {
	type: ProjectDocumentType;
	title: string;
	description: string;
	icon: string;
	score: number;
	priority: number;
	reason: string;
	matchedTriggers: string[];
	suggestedPrompt: string;
}

interface DocumentTypeConfig {
	title: string;
	description: string;
	icon: string;
	triggers: string[];
	priority: number;
	reason: string;
	promptTemplate: (project: ProjectContext) => string;
}

interface ProjectContext {
	name: string;
	description?: string;
	goals?: string;
	projectTypes?: string[];
	techStack: string[];
	features: string[];
}

/**
 * Document Type Configurations following PM Standard v2 format
 *
 * IMPORTANT: These prompt templates and descriptions MUST align with PM Standard v2.
 * Do NOT mention forbidden sections like:
 * - Executive Summary, Product Vision, Timeline & Milestones, Budget, ROI Analysis, Appendix
 *
 * PRD Template Sections: Benefit Hypothesis, Overview, Users/Personas, Success Metrics, Scope, Requirements, Key Flows, Dependencies/Risks
 * Proposal Template Sections: Header Block, Benefit Hypothesis, Overview, Scope, Deliverables, Plan (Phases), Success Metrics, Dependencies/Risks
 */
const DOCUMENT_TYPE_CONFIGS: Record<ProjectDocumentType, DocumentTypeConfig> = {
	PRD: {
		title: "Product Requirements Document (PRD)",
		description:
			"Benefit hypothesis, requirements, success metrics, and key flows",
		icon: "📋",
		triggers: ["all"], // Always recommend
		priority: 1,
		reason: "Essential for defining product requirements and scope",
		// NOTE: Do NOT include project.features here - when RAG contexts exist, they define the scope
		// The actual generation activity handles feature injection conditionally
		promptTemplate: (project) =>
			`Create a PRD following the PM Standard v2 format for ${project.name}.

Required sections (in order):
1. Header: Title, Owner, Status, Target Release, Links
2. Benefit Hypothesis: "If we [build X] for [who], then [outcome] because [reason]"
3. Overview: Problem, Why now, Goal (max 3), Non-goals
4. Users/Personas, Success Metrics (table), Scope (In/Out)
5. Requirements (Must Have, Nice to Have, Non-Functional)
6. Key Flows, Dependencies/Risks, Open Questions, Stakeholders, Release Notes

DO NOT include: Executive Summary, Product Vision, Timeline & Milestones, Appendix.`,
	},
	BUSINESS_CASE: {
		title: "Business Case",
		description:
			"Decision-oriented case for funding/approval with options analysis and a recommendation",
		icon: "📊",
		triggers: ["all"],
		priority: 1,
		reason: "Frames the decision and funding rationale before a PRD is warranted",
		promptTemplate: (project) =>
			`Create a decision-oriented business case for ${project.name}: state the decision ask, options considered, a recommendation, value hypothesis, risks, and next steps. Use only the available project context and tag confidence on non-trivial claims.`,
	},
	DESIGN_SYSTEM: {
		title: "Design System (design.md)",
		description:
			"Tokens, components, accessibility, responsive behavior, and implementation guidance",
		icon: "🎨",
		triggers: [
			"design system",
			"design-system",
			"design tokens",
			"brand guidelines",
			"component library",
		],
		priority: 2,
		reason: "Establishes reusable visual and interaction rules for user-facing products",
		promptTemplate: (project) =>
			`Create a complete design.md for ${project.name} from the available project evidence. Preserve source references, use TBD for unsupported values, and surface conflicts in Design Gaps and Open Questions.`,
	},
	ARCHITECTURE: {
		title: "Technical Architecture Document",
		description: "System design, components, data flow, and infrastructure",
		icon: "🏗️",
		triggers: [
			"backend",
			"fullstack",
			"microservices",
			"distributed",
			"api",
			"database",
			"cloud",
			"infrastructure",
		],
		priority: 2,
		reason: "Critical for complex technical systems and scalable applications",
		promptTemplate: (project) =>
			`Design a technical architecture document for ${project.name} covering system components, data flow, infrastructure, and technology choices using ${project.techStack.slice(0, 3).join(", ")}.`,
	},
	API_SPEC: {
		title: "API Specification",
		description:
			"API endpoints, request/response formats, and authentication",
		icon: "🔌",
		triggers: [
			"api",
			"backend",
			"rest",
			"graphql",
			"endpoint",
			"microservice",
		],
		priority: 3,
		reason: "Needed for API-driven applications and service integrations",
		promptTemplate: (project) =>
			`Document the API specification for ${project.name} including endpoints, request/response formats, authentication, and error handling.`,
	},
	TECHNICAL_SPEC: {
		title: "Technical Specification",
		description:
			"Detailed technical requirements and implementation details",
		icon: "⚙️",
		triggers: [
			"backend",
			"fullstack",
			"algorithm",
			"data",
			"implementation",
			"technical",
		],
		priority: 4,
		reason: "Detailed technical implementation guide for development teams",
		promptTemplate: (project) =>
			`Create a technical specification for ${project.name} covering implementation details, algorithms, data structures, and technical decisions.`,
	},
	USER_STORY: {
		title: "Features",
		description:
			"Actionable features with acceptance criteria (Given/When/Then)",
		icon: "👤",
		triggers: [
			"frontend",
			"mobile",
			"web",
			"ui",
			"ux",
			"user",
			"interface",
		],
		priority: 5,
		reason: "Generates actionable features with clear acceptance criteria for development",
		// NOTE: Do NOT include project.features here - when RAG contexts exist, they define the scope
		// The actual generation activity handles feature injection conditionally
		promptTemplate: (project) =>
			`Generate 15-25 features for ${project.name} based on the project context and any uploaded reference documents.

Use Epic → Feature → Feature Item hierarchy:
- Start with: # EPIC-001: [Epic Title]
- Then: ## FEAT-001: [Feature Title]
- Then: ### F-001: [Feature Item Title]

Each feature item must have:
- Description (As a/I want/So that)
- Acceptance Criteria (Given/When/Then + AND)
- Notes/Links and Release Notes sections

Focus on ACTUAL APP FEATURES only. No meta-documentation.`,
	},
	PROPOSAL: {
		title: "Project Proposal",
		description:
			"Benefit hypothesis, scope, deliverables, phases, and success metrics",
		icon: "📝",
		triggers: ["proposal", "pitch", "planning", "overview"],
		priority: 6,
		reason: "Useful for project kickoff and stakeholder alignment",
		promptTemplate: (project) =>
			`Create a project proposal following the PM Standard v2 format for ${project.name}.

🚫 CRITICAL: START with this EXACT header block format:

### **Project Proposal**

**Title:** ${project.name}

**Client/Team:** [Client/Team Name]

**Sponsor:** [Sponsor Name]

**Owner:** [Owner Name]

**Date:** [Date]

**Version:** 1.0

**Links:** PRD · Timeline · Budget (if any) · Architecture (if any)

---

THEN include these sections IN ORDER:
1. ### **Benefit Hypothesis** - "If we deliver [solution], then [impact] improves by [metric] because [reason]"
2. ### **Overview** - Current state (what's painful), Proposed solution, Outcome (what success looks like)
3. ### **Scope** - ### **In Scope** and ### **Out of Scope** subsections
4. ### **Deliverables** - Product, Engineering, Quality, Ops categories
5. ### **Plan (Phases)** - Discovery, Build, Test & Launch, Post-launch (each with outputs + decision gate)
6. ### **Success Metrics** - Goal/Metric TABLE format
7. ### **Dependencies / Risks** - Dependencies and Risks with mitigations
8. ### **Stakeholders** - All roles with names
9. ### **Open Questions** - Unresolved items
10. ### **Release Notes** - Plain language summary

❌ FORBIDDEN SECTIONS (DO NOT CREATE):
- Executive Summary
- Strategic Objectives / Value Proposition
- Problem Statement (use Overview instead)
- Technical Architecture (keep in Deliverables)
- Implementation Plan / Timeline / Milestones (use Plan/Phases instead)
- Budget / Cost Estimate / ROI Analysis
- Appendix / Appendices
- Conclusion / Summary / Next Steps
- Assumptions and Dependencies (use Dependencies/Risks)`,
	},
	GENERAL: {
		title: "General Document",
		description: "General notes or documentation",
		icon: "📄",
		triggers: [],
		priority: 7,
		reason: "Flexible document for custom needs",
		promptTemplate: (project) =>
			`Create a comprehensive document about ${project.name}.`,
	},
};

/**
 * Recommend documents based on project characteristics
 */
export function recommendDocuments(
	project: ProjectContext,
): DocumentRecommendation[] {
	const recommendations: DocumentRecommendation[] = [];

	// Create searchable text from project data
	const searchText = `
		${project.projectTypes?.join(" ") || ""}
		${project.description || ""}
		${project.goals || ""}
		${project.techStack.join(" ")}
		${project.features.join(" ")}
	`.toLowerCase();

	// Score each document type
	for (const [docType, config] of Object.entries(DOCUMENT_TYPE_CONFIGS)) {
		let score = 0;
		const matchedTriggers: string[] = [];

		// Check triggers
		for (const trigger of config.triggers) {
			if (trigger === "all") {
				score += 10;
				matchedTriggers.push("Always recommended");
			} else if (searchText.includes(trigger.toLowerCase())) {
				score += 5;
				matchedTriggers.push(trigger);
			}
		}

		// Only include documents with a score > 0
		if (score > 0) {
			recommendations.push({
				type: docType as ProjectDocumentType,
				title: config.title,
				description: config.description,
				icon: config.icon,
				score,
				priority: config.priority,
				reason: config.reason,
				matchedTriggers,
				suggestedPrompt: config.promptTemplate(project),
			});
		}
	}

	// Sort by score (desc), then priority (asc)
	return recommendations.sort(
		(a, b) => b.score - a.score || a.priority - b.priority,
	);
}
