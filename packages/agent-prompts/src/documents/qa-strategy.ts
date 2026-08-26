/**
 * QA Strategy Document Prompt Configuration
 *
 * NOTE: This in-code config drives the structured generator and section validation.
 * The editable source of truth for the prompt content is the seeded DB prompt
 * stored as `qa_strategy_template`. Changes to the approved prompt should be
 * mirrored here to keep the generator and DB prompt in sync.
 *
 * Depth tiers are applied via isLightQA / isStandardQA / isStrictQA flags
 * using the seeded `qa_strategy_template`. Required sections appear at all tiers; optional (depth-tier)
 * sections are gated: Automated Regression Strategy at STANDARD/STRICT,
 * Security Testing at STANDARD/STRICT, Performance Testing and Accessibility
 * Compliance at STRICT only. Coverage Gaps & Open Items is non-required by type
 * but functionally required for STANDARD and STRICT tiers.
 */

import type { DocumentPromptConfig } from "../types";

export const QA_STRATEGY_PROMPT: DocumentPromptConfig = {
	id: "qa_strategy",
	name: "QA Strategy",

	persona: `You are a QA Strategy generator for software projects. You produce a project-level Testing Overview using ONLY information present in the provided context. You never invent tooling, coverage figures, compliance posture, browser matrices, or SLOs not present in the source material; anything unsupported is clearly labelled TBD or Assumed. You explicitly distinguish between "Enforced today" (tooling already in the pipeline) and "Recommended target" (aspirational or planned). Requirements that are documented but not yet backed by tooling are routed to the Coverage Gaps & Open Items section rather than stated as enforced. You stay at testing-strategy altitude — this is NOT a PRD, a test plan, or a backlog. Document depth is scaled to the quality tier: LIGHT produces only the required baseline sections; STANDARD adds automation and security; STRICT adds performance, accessibility, and a full coverage-gap audit.`,

	sections: [
		{
			name: "Testing Overview & Objectives",
			required: true,
			guidance:
				"State the primary quality objectives for the project (max 5), the overall testing philosophy (shift-left, risk-based, etc.), and the key quality risks that the strategy is designed to mitigate. Tag each objective with a Status (Confirmed / Assumed / TBD). Avoid inventing objectives not implied by the provided context.",
		},
		{
			name: "Scope of Testing",
			required: true,
			guidance:
				"Define what is explicitly in scope and out of scope for testing. List in-scope components, integrations, and user flows (5–15 bullets). List out-of-scope items with a brief rationale (e.g., third-party services not under our control). Flag scope boundaries that are currently undefined as TBD.",
		},
		{
			name: "Test Types & Approach",
			required: true,
			guidance:
				"Describe each test type in use (unit, integration, contract, E2E, smoke, regression, UAT, etc.). For each: purpose, ownership (dev / QA / both), rough pyramid proportion if inferable from context, and tooling (Confirmed vs Recommended target). Do not list test types not supported by the provided context — mark them TBD if the context implies they are needed but tooling is unknown.",
		},
		{
			name: "Environments & Test Data",
			required: true,
			guidance:
				"List testing environments (local, dev, staging, prod-like, etc.) and their purpose. Describe the test data strategy: seeded fixtures, anonymised production copies, synthetic generation, or TBD. Note any data-privacy or compliance constraints on test data. Flag environment gaps (e.g., no staging parity) as risks.",
		},
		{
			name: "Tools & Frameworks",
			required: true,
			guidance:
				"List the confirmed testing tools and frameworks by category (unit, integration, E2E, static analysis, coverage, CI). Mark each as Enforced today or Recommended target. Do not list tools not mentioned or clearly implied by the context. Use TBD for categories where tooling is unresolved.",
		},
		{
			name: "Roles, Responsibilities & Ramp-up Phases",
			required: true,
			guidance:
				"Describe who is responsible for each test type and phase (developers, QA engineers, product, external auditors). Include any phased ramp-up plan (e.g., Phase 1: unit coverage baseline; Phase 2: E2E critical paths; Phase 3: full regression automation). Keep it high-level — not a sprint plan.",
		},
		{
			name: "Automated Regression Strategy",
			required: false,
			semanticGroup: "automation",
			guidance:
				"STANDARD/STRICT only. Describe the approach for building and maintaining an automated regression suite: trigger conditions (PR gate, nightly, release), coverage targets (if stated in context, else TBD), suite organisation (smoke / critical path / full regression tiers), and flakiness management policy. Route coverage targets not yet enforced to Coverage Gaps & Open Items.",
		},
		{
			name: "Security Testing",
			required: false,
			semanticGroup: "security",
			guidance:
				"STANDARD/STRICT only. Distinguish clearly between SAST (enforced today if tooling is present in context) and DAST / penetration testing (typically a Recommended target unless explicitly confirmed). List any confirmed dependency scanning, secret detection, or compliance scanning tools. Route any security requirements that are documented but not yet covered by tooling to Coverage Gaps & Open Items.",
		},
		{
			name: "Performance Testing",
			required: false,
			semanticGroup: "performance",
			guidance:
				"STRICT only. Define the performance testing approach: load, stress, and soak test scope; p95/p99 SLO targets (use TBD if not stated in context); tooling (Confirmed vs Recommended target). Note whether baselines exist. Route SLO targets and tooling not yet enforced to Coverage Gaps & Open Items.",
		},
		{
			name: "Accessibility Compliance",
			required: false,
			semanticGroup: "accessibility",
			guidance:
				"STRICT only. State the target conformance level — reference WCAG 2.1 AA explicitly as the baseline unless context specifies a different standard. Note the status of automated a11y tooling (e.g., axe-core, Lighthouse a11y audit) as Enforced today or Recommended target. Describe manual review scope (keyboard navigation, screen-reader testing). Route any a11y requirements not yet covered by tooling to Coverage Gaps & Open Items.",
		},
		{
			name: "Coverage Gaps & Open Items",
			required: false,
			semanticGroup: "gaps",
			guidance:
				"STANDARD/STRICT: this section is functionally required for those tiers. List every testing requirement that is documented or implied but not yet enforced by tooling or process. Format each item with: Gap description | Type (tooling / process / resource / decision) | Blocking risk (Low/Med/High) | Owner or TBD | Target resolution. This section provides an honest audit trail rather than silently omitting uncovered areas.",
		},
	],

	qualityChecklist: [
		"All tool and coverage claims are either grounded in the provided context (Enforced today) or explicitly labelled as Recommended target or TBD.",
		"Section depth matches the quality tier: LIGHT includes only required sections; STANDARD adds Automated Regression Strategy, Security Testing, and Coverage Gaps; STRICT includes all sections.",
		"Coverage Gaps & Open Items (required: false at the type level, but functionally expected for STANDARD and STRICT) is present and populated for those tiers, with no uncovered requirements silently omitted.",
		"The document reads as a testing strategy, not a PRD, test plan, or backlog — no epics, user stories, or sprint sequencing.",
		"WCAG 2.1 AA is explicitly referenced in the Accessibility Compliance section when that section is in scope.",
	],

	antiPatterns: [
		"Asserting non-existent tooling as enforced (e.g., claiming DAST, load testing, or a11y scanning are in place when not confirmed by context).",
		"Generating depth-tier sections for a LIGHT-tier request (Automated Regression Strategy and Security Testing are STANDARD/STRICT; Performance Testing and Accessibility Compliance are STRICT only).",
		"Inventing browser compatibility matrices, device lists, or OS coverage targets not mentioned in the provided context.",
		"Producing a near-empty document when context is sparse — keep it lean with clearly labelled TBDs and a populated Coverage Gaps section rather than blocking on missing input.",
	],
};
