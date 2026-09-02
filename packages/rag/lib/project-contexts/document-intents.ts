/**
 * Document Retrieval Intent Queries
 *
 * Enterprise-grade intent queries for RAG retrieval, optimized per document type.
 * These queries are designed to maximize retrieval accuracy by covering all relevant
 * information domains for each document type.
 *
 * Used by both:
 * - Temporal activities (generation/regeneration path)
 * - API procedures (chat edit path)
 */

/**
 * Intent queries keyed by normalized document type (lowercase).
 *
 * Each query is designed to retrieve contexts that would typically appear in enterprise
 * documents, ensuring comprehensive coverage of all relevant information.
 */
export const DOCUMENT_RETRIEVAL_INTENTS: Record<string, string> = {
	prd: "What are the product vision, strategic objectives, market analysis, competitive landscape, user personas, user segmentation, detailed functional requirements, non-functional requirements, critical user journeys, user workflows, business requirements, technical constraints, scalability requirements, security requirements, performance requirements, accessibility requirements, compliance requirements, regulatory requirements, integration requirements, success metrics, key performance indicators, acceptance criteria, timeline, milestones, risk assessment, dependencies, stakeholder requirements, analytics requirements, tracking requirements, and feature specifications defined for this project?",
	business_case:
		"What are the business problem and opportunity, decision drivers, strategic rationale, business objectives and goals, options considered, build vs buy vs partner alternatives, cost estimates, investment and effort, expected benefits, value hypothesis, ROI and financial considerations, funding requirements, budget, success metrics, key performance indicators, risks, constraints, assumptions, dependencies, stakeholders, sponsors, decision criteria, go/no-go gates, delivery phases, timelines, market and competitive context, and the recommendation for this project?",
	design_system:
		"What are the approved brand guidelines, visual identity, design principles, color tokens and usage roles, typography families and scales, spacing and layout rules, grid and container behavior, border radius and elevation tokens, component styles and interaction states, responsive breakpoints and behavior, accessibility requirements, motion guidance, screenshots, design files, logo assets, CSS variables, theme tokens, frontend component implementations, design-team decisions, conflicts, open design questions, and source references for this project?",
	architecture:
		"What are the system architecture diagrams, component architecture, data architecture, infrastructure architecture, network architecture, security architecture, deployment architecture, scalability architecture, high availability design, disaster recovery plans, load balancing strategies, caching strategies, database design, database schemas, API design, microservices boundaries, service mesh configuration, container orchestration, CI/CD pipelines, monitoring strategies, observability setup, performance optimization techniques, technology stack decisions, third-party integrations, compliance standards, security standards, scalability patterns, distributed systems design, event-driven architecture, message queue configuration, API gateway setup, service discovery, configuration management, secrets management, logging strategies, error handling patterns, and infrastructure as code definitions for this project?",
	api_spec:
		"What are the REST API endpoints, GraphQL API endpoints, request schemas, response schemas, data contracts, authentication methods, authorization mechanisms, rate limiting policies, error handling standards, error response formats, versioning strategies, pagination strategies, filtering mechanisms, sorting mechanisms, webhook definitions, SDK specifications, client library requirements, testing strategies, API documentation standards, OpenAPI specifications, Swagger documentation, GraphQL schemas, RESTful principles, API gateway configuration, CORS policies, data validation rules, serialization formats, content negotiation, HTTP methods, status codes, request headers, response headers, query parameters, path parameters, request bodies, response bodies, security schemes, OAuth configuration, API keys, JWT tokens, and third-party integration interfaces for this project?",
	user_story:
		"What are the user personas, user segmentation, user research findings, user goals, user tasks, user pain points, user journeys, user flows, feature descriptions, 'As a user, I want to...' statements, 'So that...' statements, acceptance criteria, edge cases, wireframes, mockups, user interface requirements, user experience requirements, interaction patterns, user feedback, usability requirements, accessibility requirements, user testing results, story mapping, epic breakdown, sprint planning details, story dependencies, story priorities, story estimates, story acceptance tests, definition of done, user scenarios, use cases, and feature acceptance criteria for this project?",
	technical_spec:
		"What are the low-level implementation details, data models, database schemas, entity relationships, data structures, algorithms, design patterns, code architecture, class diagrams, sequence diagrams, state diagrams, library dependencies, framework choices, package requirements, code-level constraints, performance requirements, memory constraints, CPU constraints, storage constraints, network constraints, security implementation details, encryption methods, hashing algorithms, authentication implementation, authorization logic, error handling implementation, logging implementation, testing strategies, unit test requirements, integration test requirements, end-to-end test requirements, code review standards, coding standards, code style guides, documentation requirements, API implementation details, service implementation details, data processing logic, business logic, validation rules, transformation rules, error recovery mechanisms, retry strategies, circuit breaker patterns, bulkhead patterns, timeout configurations, connection pooling, transaction management, caching implementation, indexing strategies, query optimization, and deployment procedures for this project?",
	default:
		"What are the key technical, business, and functional details relevant to generating a document for this project? This includes project requirements, technical specifications, business objectives, user needs, system constraints, implementation details, architecture decisions, API designs, data models, security considerations, performance requirements, scalability needs, integration points, testing strategies, deployment procedures, compliance requirements, success metrics, timelines, dependencies, risk factors, stakeholder needs, and any other relevant project information?",
};

/**
 * Normalize documentType for intent lookup
 *
 * Converts various document type formats to lowercase canonical format for lookup in DOCUMENT_RETRIEVAL_INTENTS.
 * Handles:
 * - Title case: "Product Requirements Document (PRD)" -> "prd"
 * - Uppercase: "PRD", "USER_STORY" -> "prd", "user_story"
 * - Lowercase: "prd", "user_story" -> "prd", "user_story" (already canonical)
 */
export function normalizeDocumentTypeForIntent(documentType: string): string {
	const normalized = documentType.toLowerCase().trim();

	const titleCaseToCanonical: Record<string, string> = {
		"product requirements document (prd)": "prd",
		"product requirements document": "prd",
		"technical architecture": "architecture",
		"api specification": "api_spec",
		"user stories": "user_story",
		"user story": "user_story",
		"technical specification": "technical_spec",
	};

	if (titleCaseToCanonical[normalized]) {
		return titleCaseToCanonical[normalized];
	}

	return normalized;
}

/**
 * Build the full RAG search query for a document type.
 *
 * Combines the enterprise-grade intent query with an optional user prompt
 * to maximize retrieval accuracy.
 */
export function buildDocumentRetrievalQuery(
	documentType: string,
	userPrompt?: string,
): string {
	const normalizedType = normalizeDocumentTypeForIntent(documentType);
	const baseIntent =
		DOCUMENT_RETRIEVAL_INTENTS[normalizedType] ||
		DOCUMENT_RETRIEVAL_INTENTS.default?.replace(
			"generating a document",
			`generating a ${documentType}`,
		) ||
		`What are the key technical, business, and functional details relevant to generating a ${documentType} for this project?`;

	let query = baseIntent;

	if (userPrompt && userPrompt.trim().length > 0) {
		query += `\n\nAdditional specific project constraints and instructions: ${userPrompt}`;
	}

	return query;
}
