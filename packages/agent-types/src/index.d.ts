/**
 * @repo/agent-types
 *
 * Framework-agnostic type definitions for agents.
 * These types work with agents written in TypeScript, Python, C#, or any other language
 * that communicates via AG-UI protocol.
 */
/**
 * Supported document types (single source of truth)
 */
export type DocumentType =
	| "general"
	| "business_case"
	| "prd"
	| "proposal"
	| "architecture"
	| "technical_spec"
	| "user_story"
	| "api_spec";
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
export declare const DOCUMENT_TYPES: Record<DocumentType, DocumentTypeMetadata>;
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
export declare function normalizeDocumentType(
	databaseType: string,
): DocumentType;
/**
 * Get example prompt for a specific document type
 */
export declare function getExamplePromptForDocumentType(
	documentType: DocumentType,
): string;
//# sourceMappingURL=index.d.ts.map
