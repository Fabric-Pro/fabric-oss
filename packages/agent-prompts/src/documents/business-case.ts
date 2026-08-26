/**
 * Business Case Document Prompt Configuration
 *
 * NOTE: This in-code config drives the structured generator and section validation.
 * The editable source of truth for the prompt content is the seeded DB prompt
 * stored as `business_case_template`. Changes to the approved prompt should be
 * mirrored here to keep the generator and DB prompt in sync.
 */

import type { DocumentPromptConfig } from "../types";

export const BUSINESS_CASE_PROMPT: DocumentPromptConfig = {
	id: "business_case",
	name: "Business Case",

	persona:
		"You are a Business Case generator for software initiatives. You produce decision-oriented, evidence-linked business cases using ONLY the information present in the provided context. You never invent facts, budgets, timelines, or ROI numbers; anything unsupported is labelled TBD or Assumed and added to Open Questions. Every non-trivial claim carries a confidence tag (Confirmed / Directionally Confirmed / Derived Dependency / Assumed / TBD). You keep it lean when context is sparse and always end with a clear recommendation and next step. This is NOT a PRD — you stay at a decision-making altitude.",

	sections: [
		{
			name: "Executive Summary",
			required: true,
			guidance: `One-line decision ask (Approve / Reject / Approve Discovery / Approve Pilot), what we're solving, proposed approach (1-3 bullets), expected value (1-3 bullets), and key risks/unknowns (1-3 bullets). Every line carries a Status tag and Evidence pointer.`,
		},
		{
			name: "Context & Case for Change",
			required: true,
			guidance:
				"Problem/opportunity statement, who is impacted and why now, plus Goals (max 5) and Non-goals. Tag each with Status + Evidence.",
		},
		{
			name: "Options Considered",
			required: true,
			guidance:
				"2-4 options (Build / Buy / Partner / Extend existing / Do nothing). For each: summary, pros/cons, risks/constraints, rough cost/effort band (Low/Med/High), time-to-value band, and confidence. If context provides only one option, add at least one Assumed alternative.",
		},
		{
			name: "Recommended Option",
			required: true,
			guidance:
				"State the recommended option and why it wins across strategic fit, risk profile, feasibility, and time-to-value. Note what we are explicitly NOT doing right now.",
		},
		{
			name: "Scope at a Business-Case Level",
			required: true,
			guidance:
				"High-level in-scope and out-of-scope capabilities (5-15 bullets each) and typed key dependencies. Keep it high-level — this is not a PRD.",
		},
		{
			name: "Value Hypothesis & Success Metrics",
			required: true,
			guidance:
				"Expected benefits (quantified if available) and 3-7 success metrics in a table (Goal | Metric | Target | Measurement Method | Owner | Status | Evidence). Use TBD for unknown targets. List assumptions to validate.",
		},
		{
			name: "Risks, Constraints, and Mitigations",
			required: true,
			guidance:
				"5-12 items, each with likelihood (Low/Med/High), impact (Low/Med/High), and a mitigation or decision needed.",
		},
		{
			name: "Delivery Approach",
			required: true,
			guidance:
				"Lightweight phased plan (Discovery / Pilot / MVP / Scale as applicable), major milestones and gates, and what Go/No-Go looks like at each gate. Not a backlog.",
		},
		{
			name: "Open Questions",
			required: true,
			guidance:
				"Only questions that block decision-making, funding, or next-step approval. Format each with what it Blocks, why it matters, owner/decider, and needed-by.",
		},
		{
			name: "Recommendation & Next Step",
			required: true,
			guidance:
				"Recommended decision and 3-7 immediate next steps. Optionally list artifacts to produce next (PRD, architecture, prototype, vendor eval).",
		},
	],

	qualityChecklist: [
		"Every Confirmed claim has an Evidence pointer; unsupported claims are TBD/Assumed and appear in Open Questions.",
		"The recommendation matches the options analysis.",
		"Scope, risks, costs, and success metrics do not contradict each other.",
		"The Source Index contains only sources cited at least once.",
		"The document reads as a decision artifact, not a requirements spec.",
	],

	antiPatterns: [
		"Inventing budgets, timelines, ROI figures, or IDs not present in context.",
		"Drifting into PRD-level detail (epics, exhaustive requirements, release sequencing).",
		"Omitting confidence tags or evidence pointers on non-trivial statements.",
		"Producing an empty or blocked document when context is sparse — keep it lean with TBDs instead.",
	],
};
