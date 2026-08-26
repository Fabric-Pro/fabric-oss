/**
 * Type definitions for the modular prompt system
 */

import type { DocumentType, ProjectContext } from "@repo/agent-types";

/**
 * Quality tier for document generation
 * - draft: Quick outline with placeholder content
 * - standard: Complete, professional document
 * - comprehensive: Enterprise-grade with deep analysis
 */
export type QualityTier = "draft" | "standard" | "comprehensive";

/**
 * Project attributes that trigger conditional sections
 */
interface ProjectAttributes {
	/** Project type (mobile, web, api, data, ai/ml, ecommerce, iot) */
	projectType?: string;
	/** Architecture pattern (microservices, monolith, serverless, event-driven) */
	architecturePattern?: string;
	/** Tech stack details (react, vue, angular, node, python, java, etc.) */
	techStack?: string[];
	/** Deployment target (cloud, on-premise, hybrid, edge) */
	deploymentTarget?: string;
	/** Cloud provider (aws, azure, gcp, multi-cloud) */
	cloudProvider?: string;
	/** API style (rest, graphql, grpc, websocket) */
	apiStyle?: string;
	/** Industry (enterprise, startup, government, healthcare, fintech) */
	industry?: string;
	/** Development methodology (scrum, kanban, safe, waterfall) */
	methodology?: string;
	/** Target platform (ios, android, web, desktop, embedded) */
	platform?: string[];
	/** Has mobile app */
	hasMobileApp?: boolean;
	/** Has web app */
	hasWebApp?: boolean;
	/** Has API */
	hasAPI?: boolean;
	/** Uses AI/ML */
	usesAI?: boolean;
	/** Is B2B */
	isB2B?: boolean;
	/** Is B2C */
	isB2C?: boolean;
	/** Requires compliance (gdpr, hipaa, pci-dss, sox) */
	compliance?: string[];
}

/**
 * Condition function to determine if a section should be included
 */
type SectionCondition = (attributes: ProjectAttributes) => boolean;

/**
 * Section definition for a document type
 */
export interface DocumentSection {
	/** Section name (used as heading) */
	name: string;
	/** Whether this section is required */
	required: boolean;
	/** Semantic group name for flexible matching (optional) */
	semanticGroup?: string;
	/** Alternative section names accepted in evaluation (optional) */
	alternatives?: string[];
	/** Detailed guidance for writing this section */
	guidance: string;
	/** Example content for this section */
	example?: string;
}

/**
 * Conditional section that's included based on project attributes
 */
interface ConditionalSection extends Omit<DocumentSection, "required"> {
	/** Required is always false for conditional sections */
	required: false;
	/** Condition function or simple attribute check */
	condition: SectionCondition | string;
	/** Human-readable description of when this section is included */
	trigger: string;
	/** Priority for ordering (higher = earlier in document) */
	priority?: number;
}

/**
 * Configuration for a document type prompt
 */
export interface DocumentPromptConfig {
	/** Document type identifier */
	id: DocumentType;
	/** Human-readable name */
	name: string;
	/** Expert persona description */
	persona: string;
	/** Document sections with guidance */
	sections: DocumentSection[];
	/** Conditional sections based on project attributes */
	conditionalSections?: ConditionalSection[];
	/** Quality checklist items */
	qualityChecklist: string[];
	/** Anti-patterns to avoid */
	antiPatterns: string[];
	/** Example snippets */
	examples?: Record<string, string>;
	/** Additional context-specific instructions */
	additionalInstructions?: string;
}

/**
 * Options for building a system prompt
 */
export interface BuildSystemPromptOptions {
	/** Type of document to generate */
	documentType: DocumentType;
	/** Project context information */
	projectContext: ProjectContext;
	/** Retrieved RAG contexts */
	ragContexts: string[];
	/** Existing document content (for edits) */
	existingDocument?: string;
	/** Whether CopilotKit actions are available */
	hasCopilotKitActions?: boolean;
	/** Quality tier for generation */
	qualityTier?: QualityTier;
	/** Custom prompt override (from Prompt Library) */
	customPrompt?: string;
}

/**
 * Retrieved context with metadata
 */
export interface FormattedContext {
	/** Context content */
	content: string;
	/** Source filename if available */
	filename?: string;
	/** Context type */
	type?: string;
	/** Relevance score */
	score?: number;
}

/**
 * Result of building a system prompt
 */
export interface BuiltPrompt {
	/** The complete system prompt */
	prompt: string;
	/** Document type used */
	documentType: DocumentType;
	/** Quality tier applied */
	qualityTier: QualityTier;
	/** Whether custom prompt was used */
	usedCustomPrompt: boolean;
}
