/**
 * Semantic section groups for flexible document evaluation.
 *
 * These groupings allow evaluators to match headings by meaning rather than
 * exact phrasing (e.g., "Executive Summary" vs "Overview").
 *
 * PRD FORMAT (PM Standard v2) - Primary section groups:
 * - benefit_hypothesis: If we [build X] for [who], then [outcome] improves
 * - overview: Problem, Why Now, Goal, Non-goals
 * - users: Primary, Secondary, Internal users
 * - goals: Success Metrics with Goal/Metric table
 * - scope: In Scope, Out of Scope
 * - requirements: Must Have, Nice to Have, Non-Functional
 * - key_flows: Happy path, Edge cases, Failure/recovery
 * - risks: Dependencies, Risks with mitigation
 * - work_breakdown: Epics, Features, Stories, Spikes
 * - stakeholders: All roles involved
 * - release_notes: What shipped, who it helps, limits
 */

export const SECTION_SEMANTIC_GROUPS: Record<string, string[]> = {
	metadata: [
		"document metadata",
		"document control",
		"metadata",
		"version",
		"document information",
		"version control",
		"revision history",
		"change log",
		"document header",
		"prd",
		"prd header",
		"title",
		"owner",
		"status",
		"target release",
		"links",
	],
	// PRD FORMAT: Benefit Hypothesis section
	benefit_hypothesis: [
		"benefit hypothesis",
		"hypothesis",
		"value hypothesis",
		"expected outcome",
		"value proposition",
		"if we build",
		"if then because",
	],
	summary: [
		"executive summary",
		"overview",
		"introduction",
		"summary",
		"abstract",
		"tldr",
		"at a glance",
		"system overview",
		"problem",
		"why now",
		"goal",
		"non-goals",
		"non goals",
		"problem statement",
	],
	vision: [
		"product vision",
		"vision statement",
		"strategic alignment",
		"product principles",
		"vision",
		"strategy",
		"project overview",
		"overview",
		"introduction",
		"about",
		"problem statement",
		"mission",
	],
	stakeholders: [
		"stakeholder analysis",
		"stakeholder concerns",
		"stakeholder matrix",
		"stakeholder concerns matrix",
		"raci matrix",
		"raci",
		"authority matrix",
		"stakeholders",
		"system context",
		"context",
		"actors",
		"external systems",
	],
	goals: [
		"goals",
		"objectives",
		"success metrics",
		"kpis",
		"key performance indicators",
		"targets",
		"outcomes",
		"success criteria",
		"goals & success metrics",
		"goals and success metrics",
		"release criteria",
		"goals and objectives",
		"primary goals",
		"business goals",
		"product goals",
		"metrics",
	],
	requirements: [
		"requirements",
		"functional requirements",
		"non-functional requirements",
		"features",
		"functionality",
		"capabilities",
		"specifications",
		"specs",
		"user requirements",
		"system requirements",
		"features and requirements",
		"core features",
		"product features",
		"deliverables",
		"must have",
		"nice to have",
		"should have",
		"could have",
		"wont have",
		"performance",
		"security privacy",
		"reliability",
	],
	// PRD FORMAT: Scope section with In Scope / Out of Scope
	scope: [
		"scope",
		"project scope",
		"in scope",
		"out of scope",
		"not in scope",
		"boundaries",
		"scope boundaries",
		"what we will build",
		"what we wont build",
		"included",
		"excluded",
	],
	// PRD FORMAT: Key Flows / Use Cases
	key_flows: [
		"key flows",
		"use cases",
		"user flows",
		"happy path",
		"edge cases",
		"failure",
		"recovery",
		"failure recovery",
		"error handling",
		"scenarios",
		"user scenarios",
		"flow diagrams",
		"user journeys",
	],
	users: [
		"user personas",
		"personas",
		"user stories",
		"users",
		"target audience",
		"stakeholders",
		"actors",
		"user profiles",
		"intended audience",
		"epic overview",
		"story map",
		"epics",
		"stories",
		"backlog",
		"product backlog",
		"user flows",
		"story format",
		"story template",
		"format template",
	],
	technical: [
		"technical",
		"architecture",
		"system design",
		"technical design",
		"implementation",
		"technical constraints",
		"technical requirements",
		"system components",
		"component architecture",
		"design details",
		"high-level architecture",
		"high level architecture",
		"technology stack",
		"tech stack",
		"stack",
		"components",
	],
	quality_attributes: [
		"quality attributes",
		"performance",
		"reliability",
		"scalability",
		"maintainability",
		"portability",
		"usability",
		"iso 25010",
		"non-functional",
		"scalability & performance",
		"scalability and performance",
		"architecture principles",
		"design principles",
		"principles",
	],
	cross_cutting: [
		"cross-cutting concerns",
		"logging",
		"monitoring",
		"observability",
		"caching",
		"error handling",
		"configuration",
	],
	data: [
		"data model",
		"data architecture",
		"database",
		"database schema",
		"data design",
		"data flow",
		"entities",
		"erd",
		"data dictionary",
		"resource model",
	],
	api: [
		"api",
		"api design",
		"api spec",
		"api specification",
		"endpoints",
		"api endpoints",
		"rest api",
		"graphql",
		"api reference",
		"api metadata",
		"design principles",
		"common patterns",
		"error handling",
		"error codes",
		"errors",
		"responses",
		"request",
		"response",
		"resources",
		"methods",
		"http",
	],
	timeline: [
		"timeline",
		"milestones",
		"schedule",
		"roadmap",
		"phases",
		"timeline & milestones",
		"project plan",
		"delivery schedule",
		"wbs",
		"work breakdown structure",
		"timeline and milestones",
		"project timeline",
		"project schedule",
		"budget",
		"budget considerations",
		"cost",
		"pricing",
		"estimates",
	],
	security: [
		"security",
		"security architecture",
		"authentication",
		"authorization",
		"access control",
		"security requirements",
		"security considerations",
		"auth",
		"oauth",
		"jwt",
		"tokens",
		"api keys",
		"credentials",
		"permissions",
	],
	testing: [
		"testing",
		"testing strategy",
		"test plan",
		"test cases",
		"qa",
		"quality assurance",
		"validation",
		"verification",
		"quality assurance plan",
		"unit testing",
		"integration testing",
		"e2e testing",
		"end-to-end testing",
		"test coverage",
	],
	acceptance: [
		"acceptance criteria",
		"ac",
		"criteria",
		"definition of done",
		"dod",
		"done criteria",
		"completion criteria",
		"definition of ready",
		"dor",
		"invest validation",
		"invest",
		"story sizing",
		"sizing guidelines",
		"effort guidelines",
		"story points",
		"estimation",
		"story estimation",
		"ready criteria",
	],
	governance: [
		"governance",
		"project governance",
		"decision making",
		"change control",
		"communication plan",
		"escalation",
		"raci",
	],
	configuration: [
		"configuration",
		"configuration management",
		"environment variables",
		"feature flags",
		"secrets management",
		"deployment",
		"deployment strategy",
		"deploy",
		"ci/cd",
		"cicd",
		"continuous integration",
		"continuous deployment",
		"infrastructure",
		"hosting",
		"environments",
	],
	operations: [
		"operations",
		"operational runbook",
		"runbook",
		"troubleshooting",
		"monitoring",
		"incident response",
		"maintenance",
		"monitoring and maintenance",
		"observability",
		"logging",
		"alerts",
		"alerting",
		"sre",
		"site reliability",
		"devops",
	],
	glossary: [
		"glossary",
		"definitions",
		"terminology",
		"terms",
		"acronyms",
		"glossary & definitions",
	],
	deprecation: [
		"deprecation",
		"deprecation policy",
		"sunset",
		"migration",
		"changelog",
		"versioning",
	],
	// PRD FORMAT: Work Breakdown
	work_breakdown: [
		"work breakdown",
		"work breakdown structure",
		"wbs",
		"epics",
		"features",
		"stories",
		"tasks",
		"spikes",
		"backlog",
		"deliverables breakdown",
		"implementation breakdown",
		"development phases",
	],
	// PRD FORMAT: Stakeholders (PM standard format)
	stakeholders_prd: [
		"stakeholders",
		"business sponsor",
		"pm po",
		"product owner",
		"engineering",
		"design",
		"qa",
		"data analytics",
		"security compliance",
		"support ops",
		"team",
		"roles",
		"responsible parties",
	],
	// PRD FORMAT: Release Notes
	release_notes: [
		"release notes",
		"release summary",
		"what shipped",
		"changelog",
		"release announcement",
		"launch notes",
		"ship notes",
	],
	// EVAL_VERSION 3: New industry-standard section groups
	risks: [
		"risks",
		"risk assessment",
		"risk mitigation",
		"risk matrix",
		"constraints",
		"assumptions",
		"dependencies",
		"risk management",
		"risk analysis",
		"dependencies risks",
		"dependencies and risks",
	],
	compliance: [
		"compliance",
		"regulatory",
		"legal requirements",
		"gdpr",
		"hipaa",
		"pci",
		"soc2",
		"soc 2",
		"iso 27001",
		"regulatory compliance",
		"data privacy",
	],
	migration: [
		"migration",
		"migration strategy",
		"data migration",
		"rollback",
		"backwards compatibility",
		"rollback plan",
		"cutover plan",
		"migration path",
	],
	performance: [
		"performance",
		"performance requirements",
		"latency",
		"throughput",
		"benchmarks",
		"load testing",
		"capacity planning",
		"scalability requirements",
		"response time",
		"sla",
		"service level agreement",
		"rate limiting",
		"rate limits",
		"throttling",
		"quotas",
		"limits",
	],
	mobile: [
		"mobile",
		"ios",
		"android",
		"responsive",
		"offline",
		"push notifications",
		"app store",
		"mobile requirements",
		"platform specific",
		"device compatibility",
	],
	ai_ml: [
		"model",
		"training",
		"inference",
		"ml pipeline",
		"feature store",
		"model serving",
		"mlops",
		"machine learning",
		"artificial intelligence",
		"model performance",
		"training data",
	],
};

export function normalizeSectionName(name: string): string {
	return name
		.toLowerCase()
		.replace(/&/g, "and")
		.replace(/[^a-z0-9\s]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

export function sectionMatchesGroup(
	sectionName: string,
	groupName: string,
): boolean {
	const variants = SECTION_SEMANTIC_GROUPS[groupName];
	if (!variants) {
		return false;
	}

	const normalized = normalizeSectionName(sectionName);
	return variants.some((variant) => {
		const normalizedVariant = normalizeSectionName(variant);
		return (
			normalized === normalizedVariant ||
			normalized.includes(normalizedVariant) ||
			normalizedVariant.includes(normalized)
		);
	});
}

export function findSectionGroup(sectionName: string): string | null {
	const normalized = normalizeSectionName(sectionName);

	for (const [groupName, variants] of Object.entries(
		SECTION_SEMANTIC_GROUPS,
	)) {
		if (
			variants.some((variant) => {
				const normalizedVariant = normalizeSectionName(variant);
				return (
					normalized === normalizedVariant ||
					normalized.includes(normalizedVariant) ||
					normalizedVariant.includes(normalized)
				);
			})
		) {
			return groupName;
		}
	}

	return null;
}

// EVAL_VERSION 3: Updated with industry standards
// PRD FORMAT (PM Standard v2) updated requirements
export function getRequiredGroupsForDocType(docType: string): string[] {
	const requirements: Record<string, string[]> = {
		prd: [
			"benefit_hypothesis", // If we [build X] for [who], then [outcome] improves
			"summary", // Overview: Problem, Why now, Goal, Non-goals
			"users", // Users/Personas: Primary, Secondary, Internal
			"goals", // Success Metrics: Goal/Metric table
			"scope", // In Scope, Out of Scope
			"requirements", // Must Have, Nice to Have, Non-Functional
			"key_flows", // Happy path, Edge cases, Failure/recovery
			"risks", // Dependencies, Risks with mitigation
			"stakeholders", // All roles involved
		],
		architecture: [
			"summary", // Overview, introduction, system context
			"technical", // Architecture, components, high-level design
			"data", // Data models, data flow, database
			"security", // Security architecture, auth
			"performance", // Scalability, performance, quality attributes
			"configuration", // Deployment, infrastructure
		],
		technical_spec: [
			"summary", // Executive summary or overview
			"technical", // Architecture, system design
			"data", // Data models, database schema
			"api", // API specifications (if applicable)
			"configuration", // Deployment, CI/CD, environments
			"testing", // Testing strategy
		],
		api_spec: [
			"summary", // Overview, introduction
			"api", // Endpoints, resources
			"security", // Authentication, authorization
			"performance", // Rate limits, latency (optional but common)
		],
		user_story: [
			"users", // includes personas, epic overview
			"acceptance", // includes acceptance criteria, DoR, DoD, INVEST
		],
		proposal: [
			"summary", // Executive summary, overview
			"requirements", // Scope, deliverables, objectives
			"timeline", // Timeline, milestones, schedule
		],
		general: ["metadata", "summary"],
	};

	return requirements[docType.toLowerCase()] || requirements.general;
}
