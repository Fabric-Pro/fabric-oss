/**
 * Centralised prompt builders for the Atlas feature.
 *
 * Every AI prompt string the feature emits lives here: the module-describe
 * prompt, the file-describe prompt, the business-derivation prompt, and the
 * graph-grounded chat system prompt. They were previously inlined in
 * `describe.ts`, `business.ts`, and `chat.ts`; collecting them in one module
 * makes the wording reviewable in a single place and keeps the behaviour
 * identical (the callers import these builders back).
 *
 * FUTURE: these are the natural candidates for runtime-editable system-prompt
 * bindings (the same `Prompt`/`PromptVersion` mechanism the agents use). When
 * that lands, each builder below becomes the *default* body for a named prompt
 * key resolved from the DB. Intentionally NOT wired to the prompt table now —
 * this module only centralises the literals so the migration is a drop-in.
 */

import type { GraphMode } from "./types";

// ── Smart-analysis categories ────────────────────────────────────────────────

/**
 * The 7 well-known categories the AI tags each module/capability with (it may
 * also return a short custom lowercase keyword when none fit). Rendered into the
 * describe + business prompts so the model classifies consistently.
 */
const CATEGORY_GUIDANCE: { key: string; definition: string }[] = [
	{
		key: "ai",
		definition:
			"AI/LLM features. Signals: model orchestration or prompt building, agents/tools, embeddings or vector search, RAG, text/image generation, inference calls.",
	},
	{
		key: "integration",
		definition:
			"Connectors to third-party/external services. Signals: REST/GraphQL clients for outside APIs, OAuth flows, webhooks, two-way sync with systems like GitHub, Slack, Stripe, or a PM tool.",
	},
	{
		key: "security",
		definition:
			"Trust, access, and protection of data. Signals: authentication/login, authorization/permissions/roles, secrets or key management, encryption, multi-tenant isolation, audit, compliance.",
	},
	{
		key: "infra",
		definition:
			"Build, deploy, and runtime plumbing. Signals: CI/CD, bundlers/build config, framework bootstrap and wiring, container/runtime setup, background workers and the queue runtime, schema/migration tooling.",
	},
	{
		key: "data",
		definition:
			"Modelling and persisting data. Signals: database schema/ORM/queries, object or file storage, caches, data pipelines/ETL, search indexing, analytics aggregation.",
	},
	{
		key: "experience",
		definition:
			"What the end user sees and touches. Signals: UI pages/screens/components, design system, routing/navigation, forms, client-side state, copy/content, docs surfaced to users.",
	},
	{
		key: "ops",
		definition:
			"Running and operating the product. Signals: observability/logging/metrics/tracing, alerting, billing/usage metering, feature flags and config, scheduled/cron jobs, internal admin tooling.",
	},
];

/**
 * Tie-breaking rules so the SAME concern lands in the SAME category every time.
 * Read top-to-bottom: the FIRST rule that fits wins. A module can touch several
 * areas (e.g. an authenticated API route that reads the database) — these rules
 * force a single best-fit by the module's PRIMARY responsibility, not by the
 * incidental libraries it imports.
 */
const CATEGORY_TIE_BREAKERS: string[] = [
	"auth, login, permissions, roles, tenancy/isolation, secrets, or encryption → security (even if it is also an API route or reads the database).",
	"calls an LLM, builds prompts, runs an agent, or computes embeddings → ai (even if it also persists results or calls an external API).",
	"connects to an outside service (OAuth, webhooks, third-party SDK/API, sync) → integration (unless its core job is auth, in which case security).",
	"defines the DB schema, runs queries/migrations, or owns storage/cache/search/analytics → data.",
	"is build/deploy/runtime/framework wiring or the worker/queue runtime itself → infra (the JOBS a worker runs are categorised by what they do, not infra).",
	"renders UI, pages, components, navigation, forms, or user-facing content → experience.",
	"is billing, feature flags, app config, observability/logging, scheduling, or admin tooling → ops.",
	"When two still fit, prefer the more specific business concern (security/ai/integration/data) over the more generic plumbing concern (infra/ops/experience).",
];

/** One line per category, for embedding in a prompt's instructions. */
function renderCategoryGuidance(): string {
	const cats = CATEGORY_GUIDANCE.map((c) => `  - ${c.key}: ${c.definition}`);
	const ties = CATEGORY_TIE_BREAKERS.map((t) => `  - ${t}`);
	return [
		...cats,
		"  Tie-breakers (apply the FIRST that fits; categorise by PRIMARY responsibility, not incidental imports):",
		...ties,
	].join("\n");
}

// ── Describe: modules ────────────────────────────────────────────────────────

/** A user's authoritative override notes for a node, fed as high-priority context. */
export interface UserNotePrompt {
	description?: string | null;
	category?: string | null;
}

/** One module entry as rendered into the batch describe prompt. */
export interface ModulePromptEntry {
	label: string;
	path: string | null;
	language: string | null;
	fileCount: number;
	loc: number;
	dependsOn: string[];
	dependedOnBy: string[];
	sampleFiles: { label: string; preview: string | null }[];
	/** User-provided authoritative notes (B4) — present only on default (non-fresh) runs. */
	userNote?: UserNotePrompt | null;
}

export interface ModulePromptOptions {
	maxSampleFiles: number;
	maxSamplePreviewChars: number;
}

/**
 * Render a user's authoritative override note as a clearly-delimited, high-
 * priority instruction block (B4) so the model respects and builds on it rather
 * than contradicting it. No-op when there is no note.
 */
function appendUserNote(lines: string[], note?: UserNotePrompt | null): void {
	const description = note?.description?.trim();
	const category = note?.category?.trim();
	if (!description && !category) {
		return;
	}
	lines.push(
		"AUTHORITATIVE USER NOTES (the team wrote these about this module — they OUTRANK the code preview; reflect and build on them, and never contradict them):",
	);
	if (description) {
		lines.push(
			`  • description: ${description} (your descriptions must be consistent with this; expand on it with grounded specifics from the preview rather than restating or overriding it)`,
		);
	}
	if (category) {
		lines.push(
			`  • category: ${category} (keep this exact category unless it is clearly, factually wrong)`,
		);
	}
}

/**
 * Batch "describe these modules" prompt. The model returns
 * `{ descriptions: [{ technical, business, category }] }` in the SAME ORDER as
 * `modules`.
 */
export function buildModuleDescribePrompt(
	modules: ModulePromptEntry[],
	options: ModulePromptOptions,
): string {
	const lines: string[] = [
		"You are a senior software engineer and product analyst. For EACH numbered module below, write two descriptions and assign one category.",
		"Ground every claim in the supplied path, dependency lists, and code preview. Read the preview: name the concrete things the module actually does, not what its folder name suggests.",
		"- technical: 2-4 tight sentences for a developer. Cover (a) what the module is responsible for, (b) the key things it does / the main logic, (c) the notable exported types, functions, classes, or routes you can see in the preview, and (d) how it collaborates with the rest of the system (lean on the 'Depends on' / 'Used by' lists). Use precise engineering terms.",
		"- business: 1-2 sentences in plain, non-technical language for a product owner — the user-facing capability or business value this area supports. If it is pure internal plumbing with no direct user value, say so plainly.",
		"- category: the single best-fit key from the list below (or a short custom lowercase keyword ONLY if none fit). Pick exactly ONE — the best fit, applying the tie-breakers:",
		renderCategoryGuidance(),
		"Rules:",
		"- Be specific and concrete; every sentence must add information a reader could not guess from the module name alone.",
		"- Stay strictly within the provided context. Do NOT invent features, endpoints, dependencies, or behaviour the preview does not show. If the preview is thin, describe only what is visible and keep it short rather than padding.",
		"- BANNED openers and filler: do not start with or include vague phrases like 'This module contains code that…', 'Handles various…', 'A collection of…', 'Responsible for managing…', and do not merely restate the file path or label as the description.",
		"Return { descriptions: [{ technical, business, category }] } in the SAME ORDER as the modules.",
		"",
	];
	modules.forEach((m, i) => {
		lines.push(`### Module ${i + 1}: ${m.label}`);
		if (m.path) {
			lines.push(`Path: ${m.path}`);
		}
		lines.push(
			`Files: ${m.fileCount}, ~${m.loc} LOC${m.language ? `, primarily ${m.language}` : ""}`,
		);
		if (m.dependsOn.length) {
			lines.push(`Depends on: ${m.dependsOn.slice(0, 12).join(", ")}`);
		}
		if (m.dependedOnBy.length) {
			lines.push(`Used by: ${m.dependedOnBy.slice(0, 12).join(", ")}`);
		}
		appendUserNote(lines, m.userNote);
		const samples = m.sampleFiles.slice(0, options.maxSampleFiles);
		if (samples.length) {
			lines.push("Representative files:");
			for (const s of samples) {
				lines.push(`- ${s.label}`);
				if (s.preview) {
					lines.push("```");
					lines.push(
						s.preview.slice(0, options.maxSamplePreviewChars),
					);
					lines.push("```");
				}
			}
		}
		lines.push("");
	});
	return lines.join("\n");
}

// ── Describe: single file / module on demand ─────────────────────────────────

export interface FilePromptEntry {
	path: string;
	language: string | null;
	preview: string | null;
}

export interface FilePromptOptions {
	maxPreviewChars: number;
	/** Optional live instructions the user typed in the "Describe with AI" box. */
	instructions?: string | null;
}

/**
 * Single-file describe prompt. When `instructions` are present they are appended
 * as an explicit, clearly-delimited block so the model treats them as
 * additional guidance without overriding the grounding rule.
 */
export function buildFileDescribePrompt(
	file: FilePromptEntry,
	options: FilePromptOptions,
): string {
	const lines: string[] = [
		"Describe this source file for two audiences and assign one category. Ground every claim in the code shown below — name the concrete things the file actually does.",
		"- technical: 2-4 tight sentences for a developer — what the file is responsible for, its key logic, the notable exports (types, functions, classes, routes) visible in the code, and how it collaborates with the rest of the system. Use precise engineering terms.",
		"- business: 1 sentence in plain language — the user-facing capability or business value it supports (say plainly if it is pure internal plumbing).",
		"- category: the single best-fit key — pick exactly ONE, applying the tie-breakers (or a short custom lowercase keyword ONLY if none fit):",
		renderCategoryGuidance(),
		"Be specific and concrete; do NOT invent behaviour the code does not show, restate the path, or use filler like 'This file contains code that…'. If the snippet is thin, describe only what is visible and keep it brief.",
	];
	const trimmed = options.instructions?.trim();
	if (trimmed) {
		lines.push(
			`Additional user instructions (treat as authoritative guidance; reflect them, but stay grounded in the code): ${trimmed}`,
		);
	}
	lines.push(
		`File: ${file.path}${file.language ? ` (${file.language})` : ""}`,
		"```",
		(file.preview ?? "").slice(0, options.maxPreviewChars),
		"```",
	);
	return lines.join("\n");
}

// ── Business derivation ──────────────────────────────────────────────────────

export interface BusinessModulePromptEntry {
	label: string;
	path: string | null;
	business: string | null;
	/** Short excerpt of attached documentation (README etc.) for this module. */
	doc?: string | null;
	/** Authoritative user note (B4) for this module — weighed as ground truth. */
	userNote?: string | null;
}

/** How many characters of a module's attached docs to fold into the prompt. */
const BUSINESS_DOC_EXCERPT_CHARS = 280;

/**
 * "Group these modules into business capabilities" prompt. The model returns
 * capabilities (name + description + covered module indices) plus a few
 * capability-to-capability relations. When a module has attached documentation
 * (README/markdown), a short excerpt is folded in so the business grouping
 * reflects the human-written docs, not just code structure.
 */
export function buildBusinessDerivationPrompt(
	modules: BusinessModulePromptEntry[],
): string {
	const lines = [
		"You are a product analyst. Group the following code modules into 4-12 BUSINESS CAPABILITIES — coherent, user-facing or value-delivering areas of the product, NOT technical layers.",
		"A capability is something a stakeholder would recognise as a thing the product DOES for its users (e.g. 'Invoicing & payments', 'AI feature drafting', 'Team access control') — not a tech layer like 'utilities', 'database', or 'API'. Group by shared business purpose, not by folder or framework.",
		"For each capability provide:",
		"- name: a short, product-level, human-readable name (Title Case, no file paths or framework jargon).",
		"- description: 1-2 plain-language sentences saying what the capability DELIVERS to users and, briefly, which modules realise it (reference them by their labels).",
		"- moduleIndices: the indices of the modules it covers.",
		"- category: the single best-fit key from this list — pick exactly ONE, applying the tie-breakers (or a short custom lowercase keyword ONLY if none fit):",
		renderCategoryGuidance(),
		"Then list a few relations between capabilities (which depends on or feeds into which), referencing capabilities by name — use these to show how value flows through the product.",
		"Assign every module index to exactly one capability where reasonable; prefer a small number of meaningful capabilities over many thin ones, but do not force unrelated modules together.",
		"When a module includes a documentation excerpt or AUTHORITATIVE USER NOTE, weigh it heavily and let it drive the naming — it is the human-written description of what that area is for, and it outranks the code structure.",
		"Stay grounded in the supplied module descriptions and docs; do not invent capabilities the modules do not support.",
		"",
		"Modules:",
	];
	modules.forEach((m, i) => {
		lines.push(
			`${i}. ${m.label}${m.path ? ` (${m.path})` : ""}${m.business ? ` — ${m.business}` : ""}`,
		);
		const userNote = m.userNote?.replace(/\s+/g, " ").trim();
		if (userNote) {
			lines.push(
				`   AUTHORITATIVE USER NOTE: ${userNote.slice(0, BUSINESS_DOC_EXCERPT_CHARS)}`,
			);
		}
		const doc = m.doc?.replace(/\s+/g, " ").trim();
		if (doc) {
			lines.push(`   docs: ${doc.slice(0, BUSINESS_DOC_EXCERPT_CHARS)}`);
		}
	});
	return lines.join("\n");
}

// ── Graph-grounded chat ──────────────────────────────────────────────────────

export interface ChatPromptHeaderInput {
	repositoryName: string | null;
	projectName: string | null;
	mode: GraphMode;
}

/**
 * The leading lines of the chat system prompt. ONE merged "Atlas Assistant"
 * persona serves both graph views: full engineering precision (terminology,
 * responsibilities, data flow, dependencies — the former technical persona's
 * quality floor) enriched with plain-language business value (tying each code
 * area to the capability it serves via the COVERS map the caller injects).
 *
 * `mode` remains a parameter for exactly two canvas-focus aspects:
 *  - which node family is referenced by EXACT label for the linkifier (the UI
 *    scans the reply for those labels and turns them into clickable chips that
 *    focus nodes on the ACTIVE canvas — modules/files in TECHNICAL,
 *    capabilities in BUSINESS; the other family must never become a link), and
 *  - the primary section header the caller appends the node list under.
 */
export function buildChatSystemPromptHeader(
	input: ChatPromptHeaderInput,
): string[] {
	const repo = `the repository "${input.repositoryName ?? "this repository"}"${
		input.projectName ? ` in project "${input.projectName}"` : ""
	}`;

	const linkInstruction =
		input.mode === "BUSINESS"
			? "When you mention one of the business capabilities, write its EXACT label exactly as shown — the interface turns those into clickable links that open it in the map. You may discuss the underlying code modules freely (including technical detail), but do NOT write module names as exact labels — they are not on this map and must never become links. Where the context provides documentation, fold it into your answer."
			: "When you reference one of the modules or files, write its EXACT label exactly as shown — the interface turns those into clickable links that open that node in the graph. You may discuss the business capabilities freely, but do NOT write capability names as exact labels — they are not in this graph and must never become links.";

	return [
		`You are Atlas Assistant — a precise, helpful guide to ${repo} for everyone on the team, from software engineers to product stakeholders.`,
		"You have the TECHNICAL dependency graph (modules and files), the product's BUSINESS capabilities, and a map of which code each capability covers (all below) — so you can explain how the code is structured AND what user-facing value each part delivers, in the same answer.",
		"Use accurate engineering terminology; be specific about responsibilities, data flow, and dependencies — and tie each code area to the user-facing capability it serves, explaining its business value in plain language alongside the technical detail.",
		"Lead with a direct answer in the first sentence, then support it. Synthesise across the modules, their dependencies, and the capabilities they back to explain how data and control flow through the system: connect the relevant pieces into a clear path or short narrative instead of just listing them or asking the user to narrow the question down.",
		"Refer to every node by its EXACT name as shown in the context, and only to nodes that actually appear there — never invent or guess a module, file, capability, dependency, or relationship that is not listed.",
		"For dependency and impact questions ('what depends on X', 'what calls Y', 'what would break if I change Z'), reason concretely over the relationship lists: trace the edges in the relevant direction, name the specific upstream/downstream nodes you find, and call out the blast radius. Distinguish direct neighbours from transitive ones, and base it ONLY on the relationships given.",
		"Some descriptions reflect notes the team has edited; treat the descriptions in the context as the effective, authoritative meaning of each node and answer in line with them.",
		"Stay grounded in the context below — don't invent APIs, capabilities, or behaviour it doesn't support — but DO reason over it to give a genuinely useful answer. If the answer depends on something that is NOT in the analysed graph (a module, dependency, or detail that simply is not listed), say so plainly rather than guessing, and point to the nearest relevant nodes. Only decline entirely when the question is unrelated to this codebase.",
		"Be confident and concise. Skip filler disclaimers and apologies; just give the most helpful answer the context supports.",
		linkInstruction,
		"",
		input.mode === "BUSINESS" ? "## Business capabilities" : "## Modules",
	];
}
