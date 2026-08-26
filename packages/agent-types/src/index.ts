/**
 * @repo/agent-types
 *
 * Framework-agnostic type definitions for agents.
 * These types work with agents written in TypeScript, Python, C#, or any other language
 * that communicates via AG-UI protocol.
 */

export type {
	DecisionConflictFinding,
	DecisionPrecheckResult,
} from "./decision-precheck";
export {
	countDistinctDecisions,
	extractDecisionPrecheck,
} from "./decision-precheck";

/**
 * Supported document types (single source of truth)
 */
export type DocumentType =
	| "general" // Free-form document
	| "business_case" // Business Case (decision/funding artifact)
	| "prd" // Product Requirements Document
	| "proposal" // Software Development Proposal
	| "architecture" // Technical Architecture Document
	| "technical_spec" // Technical Specification
	| "user_story" // Feature
	| "api_spec" // API Specification
	| "qa_strategy" // QA Strategy (Testing Overview)
	| "srs"; // Software Requirements Specification

/**
 * Document type metadata
 */
export interface DocumentTypeMetadata {
	id: DocumentType;
	name: string;
	description: string;
	sections: string[];
	icon?: string;
}

/**
 * Document type configurations
 */
export const DOCUMENT_TYPES: Record<DocumentType, DocumentTypeMetadata> = {
	general: {
		id: "general",
		name: "General Document",
		description: "Free-form document with no specific structure",
		sections: [],
		icon: "📄",
	},
	business_case: {
		id: "business_case",
		name: "Business Case",
		description:
			"Decision-oriented business case for funding/approval, with options analysis and a clear recommendation",
		sections: [
			"Executive Summary",
			"Context & Case for Change",
			"Options Considered",
			"Recommended Option",
			"Scope at a Business-Case Level",
			"Value Hypothesis & Success Metrics",
			"Risks, Constraints, and Mitigations",
			"Delivery Approach",
			"Open Questions",
			"Recommendation & Next Step",
		],
		icon: "📊",
	},
	prd: {
		id: "prd",
		name: "Product Requirements Document (PRD)",
		description:
			"Structured document for product requirements with sections for overview, goals, features, success metrics, and timeline",
		sections: [
			"Overview",
			"Goals",
			"Features",
			"Success Metrics",
			"Timeline",
		],
		icon: "📋",
	},
	proposal: {
		id: "proposal",
		name: "Software Development Proposal",
		description:
			"Structured proposal document with sections for executive summary, project scope, timeline, budget, team, and deliverables",
		sections: [
			"Executive Summary",
			"Project Scope",
			"Timeline",
			"Budget",
			"Team",
			"Deliverables",
		],
		icon: "💼",
	},
	architecture: {
		id: "architecture",
		name: "Technical Architecture Document",
		description:
			"Structured architecture document with sections for system overview, architecture diagram, components, data flow, technology stack, and security considerations",
		sections: [
			"System Overview",
			"Architecture Diagram",
			"Components",
			"Data Flow",
			"Technology Stack",
			"Security Considerations",
		],
		icon: "🏗️",
	},
	technical_spec: {
		id: "technical_spec",
		name: "Technical Specification",
		description:
			"Detailed technical requirements and implementation details with sections for requirements, constraints, design, and testing",
		sections: [
			"Requirements",
			"Constraints",
			"Design Details",
			"Implementation Plan",
			"Testing Strategy",
			"Deployment",
		],
		icon: "🔧",
	},
	user_story: {
		id: "user_story",
		name: "Feature",
		description:
			"User-focused narrative with sections for personas, scenarios, acceptance criteria, and dependencies",
		sections: [
			"User Persona",
			"Story Description",
			"Acceptance Criteria",
			"Dependencies",
			"Effort Estimate",
		],
		icon: "👥",
	},
	api_spec: {
		id: "api_spec",
		name: "API Specification",
		description:
			"API documentation with sections for endpoints, authentication, request/response formats, and error handling",
		sections: [
			"Overview",
			"Authentication",
			"Endpoints",
			"Request/Response Formats",
			"Error Handling",
			"Rate Limiting",
		],
		icon: "🔌",
	},
	qa_strategy: {
		id: "qa_strategy",
		name: "QA Strategy",
		description:
			"Project-level QA strategy document covering test scope, types, tools, environments, and automated regression approach",
		sections: [
			"Testing Overview & Objectives",
			"Scope of Testing",
			"Test Types & Approach",
			"Environments & Test Data",
			"Tools & Frameworks",
			"Roles, Responsibilities & Ramp-up Phases",
			"Automated Regression Strategy",
			"Security Testing",
			"Performance Testing",
			"Accessibility Compliance",
			"Coverage Gaps & Open Items",
		],
		icon: "🧪",
	},
	srs: {
		id: "srs",
		name: "Software Requirements Specification (SRS)",
		description:
			"Formal requirements baseline covering scope, functional and non-functional requirements, external interfaces, constraints, and verifiable acceptance criteria",
		sections: [
			"Introduction & Purpose",
			"Scope",
			"Definitions, Acronyms & References",
			"Overall Description",
			"Functional Requirements",
			"External Interface Requirements",
			"Non-Functional Requirements",
			"Constraints & Assumptions",
			"Acceptance Criteria & Verification",
			"Open Issues & TBDs",
		],
		icon: "📑",
	},
};

/**
 * Project context structure
 */
export interface ProjectContext {
	name: string;
	description?: string;
	goals?: string;
	techStack: string[];
	features: string[];
	projectTypes?: string[];
	repositoryUrl?: string;
	repositoryOwner?: string;
	repositoryName?: string;
	defaultBranch?: string;
}

/**
 * Framework-agnostic base agent state
 * This interface represents the minimum state that all agents must support
 */
export interface BaseAgentState {
	/** The document content in markdown format */
	document?: string;

	/** Optional section heading to focus on in the UI */
	focusAnchor?: string;

	/** Type of document being generated */
	documentType: DocumentType;

	/** Error message if agent execution failed */
	error?: string;

	/** Number of retry attempts */
	retryCount: number;

	/** Messages exchanged with the agent (framework-agnostic) */
	messages: any[];
}

/**
 * Extended state for project-scoped agents
 */
export interface ProjectAgentState extends BaseAgentState {
	/** Project metadata for context */
	projectContext: ProjectContext;

	/** RAG-retrieved contexts from project knowledge base */
	ragContexts: string[];
}

/**
 * PRD (Product Requirements Document) Structure
 */
export interface PRDStructure {
	overview: string;
	goals: string;
	userStories: string;
	features: string;
	successMetrics: string;
	timeline: string;
}

/**
 * Proposal (Software Development Proposal) Structure
 */
export interface ProposalStructure {
	executiveSummary: string;
	projectScope: string;
	timeline: string;
	budget: string;
	team: string;
	deliverables: string;
}

/**
 * Architecture (Technical Architecture Document) Structure
 */
export interface ArchitectureStructure {
	systemOverview: string;
	architectureDiagram: string;
	components: string;
	dataFlow: string;
	technologyStack: string;
	securityConsiderations: string;
}

/**
 * Convert database document type (uppercase) to agent document type (lowercase)
 * Handles the case mismatch between Prisma enum and TypeScript type
 */
export function normalizeDocumentType(databaseType: string): DocumentType {
	// Convert to lowercase
	const normalized = databaseType.toLowerCase() as DocumentType;

	// Validate that it's a known type
	if (normalized in DOCUMENT_TYPES) {
		return normalized;
	}

	// Fallback to general if unknown
	console.warn(
		`[normalizeDocumentType] Unknown document type: ${databaseType} (normalized: ${normalized}), defaulting to 'general'`,
	);
	return "general";
}

/**
 * Get example prompt for a specific document type
 */
export function getExamplePromptForDocumentType(
	documentType: DocumentType,
): string {
	const examples: Record<DocumentType, string> = {
		general: "Write a blog post about the benefits of TypeScript",
		business_case:
			"Create a business case for adding AI-generated business case documents to our product",
		prd: "Create a PRD for a mobile app that helps users track their daily water intake",
		proposal:
			"Write a proposal for developing a customer relationship management (CRM) system",
		architecture:
			"Create an architecture document for a microservices-based e-commerce platform",
		technical_spec:
			"Write a technical specification for implementing user authentication with OAuth 2.0",
		user_story:
			"Create a feature that allows users to save their favorite items",
		api_spec:
			"Document the REST API for a task management system including CRUD operations",
		qa_strategy:
			"Create a QA strategy for a new e-commerce platform covering test scope, tools, environments, and automated regression approach",
		srs: "Write a software requirements specification for a patient appointment booking system, covering scope, functional and non-functional requirements, external interfaces, and acceptance criteria",
	};

	return examples[documentType];
}
