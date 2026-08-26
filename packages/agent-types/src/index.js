/**
 * @repo/agent-types
 *
 * Framework-agnostic type definitions for agents.
 * These types work with agents written in TypeScript, Python, C#, or any other language
 * that communicates via AG-UI protocol.
 */
/**
 * Document type configurations
 */
export const DOCUMENT_TYPES = {
	general: {
		id: "general",
		name: "General Document",
		description: "Free-form document with no specific structure",
		sections: [],
		icon: "📄",
	},
	prd: {
		id: "prd",
		name: "Product Requirements Document (PRD)",
		description:
			"Structured document for product requirements with sections for overview, goals, user stories, features, success metrics, and timeline",
		sections: [
			"Overview",
			"Goals",
			"User Stories",
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
		name: "User Story",
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
};
/**
 * Convert database document type (uppercase) to agent document type (lowercase)
 * Handles the case mismatch between Prisma enum and TypeScript type
 */
export function normalizeDocumentType(databaseType) {
	// Convert to lowercase
	const normalized = databaseType.toLowerCase();
	// Validate that it's a known type using Object.hasOwn for explicit check
	if (Object.hasOwn(DOCUMENT_TYPES, normalized)) {
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
export function getExamplePromptForDocumentType(documentType) {
	const examples = {
		general: "Write a blog post about the benefits of TypeScript",
		prd: "Create a PRD for a mobile app that helps users track their daily water intake",
		proposal:
			"Write a proposal for developing a customer relationship management (CRM) system",
		architecture:
			"Create an architecture document for a microservices-based e-commerce platform",
		technical_spec:
			"Write a technical specification for implementing user authentication with OAuth 2.0",
		user_story:
			"Create a user story for a feature that allows users to save their favorite items",
		api_spec:
			"Document the REST API for a task management system including CRUD operations",
	};
	return examples[documentType];
}
//# sourceMappingURL=index.js.map
