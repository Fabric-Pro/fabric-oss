/**
 * Design System Markdown Document Prompt Configuration
 *
 * The complete Fabric-owned SYSTEM prompt is seeded inline in
 * `packages/database/prisma/seed-prompts-only.ts` under
 * `design_system_template`.
 * This configuration keeps the structured generator and validation metadata
 * aligned with that source prompt.
 */

import type { DocumentPromptConfig } from "../types";

export const DESIGN_SYSTEM_PROMPT: DocumentPromptConfig = {
	id: "design_system",
	name: "Design System (design.md)",
	persona:
		"You are a senior design-systems architect. Create or update a complete design.md from only the supplied project evidence. Preserve useful assets, links, code, Mermaid diagrams, and source references. Never guess: mark unsupported values as TBD and surface contradictions or missing decisions in Design Gaps and Open Questions.",
	sections: [
		{
			name: "Visual Theme & Atmosphere",
			required: true,
			guidance:
				"Summarize the intended visual character, product personality, and interaction feel, grounded in available evidence.",
		},
		{
			name: "Design Token Overview",
			required: true,
			guidance:
				"Document the token strategy, naming conventions, sources, and how consumers should use tokens rather than raw values.",
		},
		{
			name: "Color Palette & Roles",
			required: true,
			guidance:
				"Cover primary, accent, semantic, neutral, surface, and border roles with states and accessibility notes. Use TBD for unknown values.",
		},
		{
			name: "Typography Rules",
			required: true,
			guidance:
				"Define font families, hierarchy, scale, weights, line heights, and usage principles from the evidence.",
		},
		{
			name: "Component Styling",
			required: true,
			guidance:
				"Describe anatomy, variants, sizes, and interaction states for buttons, containers, forms, navigation, links, and badges.",
		},
		{
			name: "Layout Principles",
			required: true,
			guidance:
				"Define spacing, grids, containers, section patterns, whitespace, radius, and border scales.",
		},
		{
			name: "Depth & Elevation",
			required: true,
			guidance:
				"Document shadows, opacity, and layering or z-index conventions.",
		},
		{
			name: "Accessibility & Inclusive Design",
			required: true,
			guidance:
				"Cover contrast, keyboard navigation, focus, reduced motion, touch targets, and readable content.",
		},
		{
			name: "Do’s and Don’ts",
			required: true,
			guidance:
				"Give evidence-based consistency rules and explicitly prohibited patterns.",
		},
		{
			name: "Responsive Behavior",
			required: true,
			guidance:
				"Document breakpoints and responsive behavior for layout, navigation, grids, typography, spacing, and buttons.",
		},
		{
			name: "Component Anatomy Visuals",
			required: true,
			guidance:
				"Preserve or create Markdown/Mermaid visuals where supported by context; do not invent unsupported component details.",
		},
		{
			name: "Implementation Notes",
			required: true,
			guidance:
				"Capture token/CSS guidance, component implementation notes, and engineering constraints with code examples when available.",
		},
		{
			name: "Agent Prompt Guide",
			required: true,
			guidance:
				"Provide concise rules that help future agents apply the design system consistently.",
		},
		{
			name: "Design Gaps",
			required: true,
			guidance:
				"List missing, conflicting, or incomplete design decisions without silently resolving them.",
		},
		{
			name: "Open Questions",
			required: true,
			guidance:
				"List the decisions required to replace TBD values or resolve conflicts, with owners when known.",
		},
		{
			name: "Assets / Source References",
			required: true,
			guidance:
				"Preserve and index relevant assets, URLs, repository paths, screenshots, and other evidence.",
		},
	],
	qualityChecklist: [
		"The output is one complete Markdown document and follows the required section order.",
		"Unsupported values are marked TBD; no colors, measurements, fonts, breakpoints, or component rules are guessed.",
		"Conflicts and missing decisions appear in Design Gaps or Open Questions.",
		"Assets, links, source references, code samples, and Mermaid diagrams from the context are preserved where relevant.",
		"Tokens, component states, responsive rules, implementation notes, and accessibility guidance are internally consistent.",
	],
	antiPatterns: [
		"Inventing design values to make the document appear complete.",
		"Silently choosing one side of conflicting source material.",
		"Dropping useful source references, assets, code examples, or diagrams.",
		"Returning commentary, summaries, or multiple artifacts instead of the full Markdown document.",
	],
};
