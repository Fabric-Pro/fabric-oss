/**
 * Unified Prompt Builder
 *
 * Single source of truth for all document generation prompts.
 * Combines best practices from all existing prompt builders.
 *
 * Features:
 * - Supports custom prompts from Prompt Library
 * - Supports Fabric AI pattern enhancement (async)
 * - Supports document type-specific prompts
 * - Centralized formatting rules
 * - Enhanced RAG usage instructions
 * - Project context integration
 * - Tool usage instructions
 */

import type { DocumentType, ProjectContext } from "@repo/agent-types";
import { getBaseInstructions } from "../core/base-instructions";
import { listAnchorPaths } from "../core/document-patches";
import { buildFollowUpInstructions } from "../core/follow-up-questions";
import { getMarkdownFormattingRulesPrompt } from "../core/formatting-rules";
import {
	PRD_RAG_PRIORITY_INSTRUCTIONS,
	STRONG_RAG_INSTRUCTIONS,
} from "../core/rag-instructions";
import { buildToolInstructionsWithoutFormatting } from "../core/tool-instructions";
import { getDocumentPrompt } from "../documents";
import {
	formatForbiddenSections,
	USER_STORY_REQUIREMENTS,
} from "../documents/user-story-constants";
import { getPrdOverrideInstructions } from "../templates/prd-template";
import { getProposalOverrideInstructions } from "../templates/proposal-template";
import type { QualityTier } from "../types";
import {
	type ContextAvailability,
	formatContextAvailability,
	formatProjectContext,
	formatRagContextsSimple,
} from "./context-formatter";

/**
 * Options for building a unified system prompt
 */
export interface UnifiedPromptOptions {
	/** Optional custom system prompt from Prompt Library */
	customPrompt?: string;
	/** Type of document being generated */
	documentType: DocumentType;
	/** Project context information */
	projectContext?: ProjectContext;
	/** Retrieved RAG contexts */
	ragContexts?: string[];
	/** Existing document content (for edits/regeneration) */
	existingDocument?: string;
	/** Enable Fabric AI pattern enhancement (requires async function) */
	useFabricAI?: boolean;
	/** Quality tier for generation */
	qualityTier?: QualityTier;
	/** Whether CopilotKit actions are available */
	hasCopilotKitActions?: boolean;
	/** Fabric AI pattern (if fetched externally) */
	fabricPattern?: string | null;
	/** Context availability for the project (codebase, transcripts, files, integrations) */
	contextAvailability?: ContextAvailability;
	/**
	 * When true, the system prompt includes editing rules and section headings
	 * but excludes the raw document body. The caller is responsible for injecting
	 * the document content in a user message instead. This keeps the system prompt
	 * small and cacheable while moving data to user context where it belongs.
	 */
	excludeDocumentBody?: boolean;
	/**
	 * Which document-editing tool the model will be bound to:
	 * - "write" (default): full rewrites via `write_document_local`. The prompt
	 *   includes the full content-preservation rules.
	 * - "patch": targeted edits via `apply_document_patches`. The prompt uses
	 *   the much shorter patch-based instructions and renders section headings
	 *   as full anchor paths so the model can copy them verbatim.
	 */
	toolMode?: "write" | "patch";
}

/**
 * Build unified system prompt (synchronous version)
 *
 * This is the main entry point for prompt building.
 * For Fabric AI enhancement, use buildUnifiedSystemPromptAsync instead.
 *
 * @param options - Prompt building options
 * @returns Complete system prompt string
 */
export function buildUnifiedSystemPrompt(
	options: UnifiedPromptOptions,
): string {
	const {
		customPrompt,
		documentType,
		projectContext,
		ragContexts = [],
		existingDocument,
		qualityTier = "standard",
		hasCopilotKitActions = true,
		fabricPattern,
		contextAvailability,
	} = options;

	const sections: string[] = [];

	// Get document type-specific configuration (always needed for overrides)
	const docConfig = getDocumentPrompt(documentType);

	// 1. Base prompt (custom, Fabric AI, or document type-specific)
	if (customPrompt && fabricPattern) {
		// Custom prompt + Fabric AI pattern: custom prompt is the PRIMARY guide
		// Do NOT prepend default template overrides — the user explicitly chose a custom prompt
		sections.push(
			combineCustomAndFabricPrompts(
				customPrompt,
				fabricPattern,
				documentType,
			),
		);
	} else if (customPrompt) {
		// Custom prompt alone: use as-is without default template overrides
		// The user explicitly selected this prompt — respect their choice
		sections.push(customPrompt);
	} else if (fabricPattern) {
		// GOOD: Fabric AI pattern alone
		// For PRDs, Proposals, and Features, still add override instructions
		if (documentType === "prd") {
			const prdInstructions = getPrdOverrideInstructions();
			sections.push(`${prdInstructions}\n\n---\n\n${fabricPattern}`);
		} else if (documentType === "proposal") {
			const proposalInstructions = getProposalOverrideInstructions();
			sections.push(`${proposalInstructions}\n\n---\n\n${fabricPattern}`);
		} else if (documentType === "user_story") {
			const criticalInstructions =
				buildUserStoryOverrideInstructions(docConfig);
			sections.push(`${criticalInstructions}\n\n---\n\n${fabricPattern}`);
		} else {
			sections.push(fabricPattern);
		}
	} else {
		// FALLBACK: Document type-specific prompt
		// For PRDs, Proposals, and Features, prepend override instructions even with default prompt
		if (documentType === "prd") {
			const prdInstructions = getPrdOverrideInstructions();
			sections.push(
				`${prdInstructions}\n\n---\n\n${buildDocumentTypePrompt(docConfig, qualityTier)}`,
			);
		} else if (documentType === "proposal") {
			const proposalInstructions = getProposalOverrideInstructions();
			sections.push(
				`${proposalInstructions}\n\n---\n\n${buildDocumentTypePrompt(docConfig, qualityTier)}`,
			);
		} else if (documentType === "user_story") {
			const criticalInstructions =
				buildUserStoryOverrideInstructions(docConfig);
			sections.push(
				`${criticalInstructions}\n\n---\n\n${buildDocumentTypePrompt(docConfig, qualityTier)}`,
			);
		} else {
			sections.push(buildDocumentTypePrompt(docConfig, qualityTier));
		}
	}

	// 2. Critical formatting rules (always include)
	sections.push(getMarkdownFormattingRulesPrompt());

	// 3. Project context (if available)
	// CRITICAL: When RAG contexts exist, they define the product scope
	// Don't include wizard features as they override actual product content from RAG
	if (projectContext?.name) {
		const hasRagContexts = ragContexts && ragContexts.length > 0;
		const contextForPrompt = hasRagContexts
			? { ...projectContext, features: [] as string[] }
			: projectContext;
		sections.push(formatProjectContext(contextForPrompt));
	}

	// 3b. Context availability (tells the AI what's available vs missing)
	if (contextAvailability) {
		sections.push(formatContextAvailability(contextAvailability));
	}

	// 4. RAG context with enhanced instructions (if available)
	if (ragContexts && ragContexts.length > 0) {
		sections.push(
			buildRagSection(ragContexts, documentType, !!customPrompt),
		);
	}

	// 5. Tool instructions (always include, without formatting rules since we add them separately)
	// Pass `documentBodyInUserMessage` so the preservation rules know whether the
	// document body lives in the system prompt (legacy) or in a separate user
	// message (new edit-mode flow). Without this, the rules tell the model to
	// "Check the Current Document State below" — pointing at a section that
	// doesn't exist when excludeDocumentBody is on.
	//
	// `toolMode` selects between full-rewrite instructions (write) and targeted
	// patch instructions (patch). The patch branch emits a much shorter block
	// appropriate for `apply_document_patches`.
	sections.push(
		buildToolInstructionsWithoutFormatting(
			existingDocument,
			hasCopilotKitActions,
			!!options.excludeDocumentBody,
			options.toolMode ?? "write",
		),
	);

	// 6. Follow-up question instructions (encourage contextual follow-ups)
	sections.push(buildFollowUpInstructions(documentType));

	// 7. Current document state (for edits)
	if (existingDocument && existingDocument.trim().length > 0) {
		if (options.excludeDocumentBody) {
			// Include editing rules and section headings in system prompt,
			// but NOT the document body — caller injects it as a user message.
			sections.push(
				buildEditingRules(
					existingDocument,
					options.toolMode ?? "write",
				),
			);
		} else {
			// Legacy: embed the full document body in the system prompt.
			sections.push(buildCurrentDocumentSection(existingDocument));
		}
	}

	// 8. CRITICAL: Add final reminder at the VERY END for PRD/Proposal
	// This ensures template compliance even when RAG contexts are embedded in customPrompt
	// The final reminder MUST be the last thing the model sees before generating
	// HOWEVER: Skip these when:
	// - EDITING an existing document (would cause duplicate sections)
	// - A custom prompt is provided (custom prompt defines its own format)
	const isEditing = existingDocument && existingDocument.trim().length > 0;
	if (documentType === "prd" && !isEditing && !customPrompt) {
		sections.push(`## 🛑🛑🛑 ABSOLUTE FINAL INSTRUCTION 🛑🛑🛑

**YOUR OUTPUT MUST START WITH:**

## **PRD**

**Title:** [Name]
**Owner:** [Owner]
**Status:** Draft
**Target Release:** [Date]
**Links:** [Links]

---

### **Benefit Hypothesis**

If we [build X] for [who], then [outcome] because [reason].

### **Overview**

- **Problem:** [problem]
- **Why now:** [urgency]
- **Goal:** [max 3 goals]
- **Non-goals:** [exclusions]

**Continue with:** Users/Personas, Success Metrics, Scope (In/Out), Requirements (Must/Nice/Non-Functional), Key Flows, Dependencies/Risks, Open Questions, Work Breakdown, Stakeholders, Release Notes.

❌ **FORBIDDEN (INSTANT FAILURE):** Executive Summary, Product Vision, Market Analysis, Timeline and Milestones, Appendix, numbered sections (1. 2. 3.)

**START YOUR OUTPUT WITH: ## **PRD****`);
	} else if (documentType === "proposal" && !isEditing && !customPrompt) {
		sections.push(`## 🛑🛑🛑 ABSOLUTE FINAL INSTRUCTION 🛑🛑🛑

**YOUR VERY FIRST LINE MUST BE:**

### **Project Proposal**

**Then immediately:**

**Title:** [Name]

**Client/Team:** [Team]

**Sponsor:** [Sponsor]

**Owner:** [Owner]

**Date:** [Date]

**Version:** 1.0

**Links:** PRD · Timeline · Budget · Architecture

---

### **Benefit Hypothesis**

If we deliver **[solution]**, then **[impact]** improves by **[metric]** because **[reason]**.

### **Overview**

- **Current state:** [what exists]
- **Proposed solution:** [what we'll build]
- **Outcome:** [success looks like]

**Continue with:** Scope (In/Out), Deliverables, Plan (Phases), Success Metrics (TABLE), Dependencies/Risks, Stakeholders, Open Questions, Release Notes.

❌ **FORBIDDEN (INSTANT FAILURE):** Executive Summary, Table of Contents, Problem Statement, System Architecture, Data Models, Timeline, Roadmap, Milestones, Budget, ROI, Appendix, numbered sections (1. 2. 3.)

**YOUR FIRST LINE MUST BE: ### **Project Proposal****`);
	}

	// NOTE: Document purity is enforced via post-processing in chat-node.ts
	// We removed the prompt instruction because models were echoing it into the document

	return sections.join("\n\n---\n\n");
}

/**
 * Build unified system prompt (async version with Fabric AI support)
 *
 * Use this when you want to fetch Fabric AI patterns.
 * Falls back to sync version if Fabric AI is unavailable.
 *
 * @param options - Prompt building options
 * @returns Complete system prompt string
 */
export async function buildUnifiedSystemPromptAsync(
	options: UnifiedPromptOptions & {
		/** Function to fetch Fabric AI pattern (optional) */
		fetchFabricPattern?: (
			documentType: DocumentType,
		) => Promise<string | null>;
	},
): Promise<string> {
	const { fetchFabricPattern, documentType, ...syncOptions } = options;

	let fabricPattern: string | null = null;

	// Try to fetch Fabric AI pattern if requested and function provided
	if (options.useFabricAI && fetchFabricPattern) {
		try {
			fabricPattern = await fetchFabricPattern(documentType);
		} catch (error) {
			console.warn(
				"[Unified Prompt Builder] Fabric AI fetch failed, continuing without it:",
				error,
			);
		}
	}

	return buildUnifiedSystemPrompt({
		...syncOptions,
		documentType,
		fabricPattern,
	});
}

/**
 * Build override instructions for feature type
 * This ensures we override template requests in custom prompts
 */
function buildUserStoryOverrideInstructions(
	_docConfig: ReturnType<typeof getDocumentPrompt>,
): string {
	return `# 🛑 CRITICAL: YOUR OUTPUT MUST USE Epic → Feature → Feature Item HIERARCHY

**REGARDLESS of what the user's custom prompt requests:**

1. Your FIRST line must be: # EPIC-001: [Epic Title]
2. Group feature items under Features (## FEAT-XXX:) within Epics (# EPIC-XXX:)
3. Generate ${USER_STORY_REQUIREMENTS.minStories}-${USER_STORY_REQUIREMENTS.maxStories}+ total feature items (### F-001, F-002, etc.)
4. ABSOLUTELY NO introduction, preamble, or overview sections
5. Feature items must be about ACTUAL APP FEATURES, not about documentation
6. NO bold markers (**) around keywords - use plain text

🚫 **FORBIDDEN SECTIONS - INSTANT FAILURE:**
${formatForbiddenSections()}
- ANY section explaining HOW to write features
- ANY meta-documentation about features
- ANY introduction or overview
- Flat list of feature items without Epic/Feature grouping

🚫 **FORBIDDEN PATTERNS - INSTANT FAILURE:**
- Feature items about "defining personas" or "creating templates"
- Feature items where role is "product team member" or "documentation writer"
- "F-001: ... Specification" or "F-001: ... Framework" patterns
- Meta-features about documentation standards

✅ **EXACT HIERARCHY FORMAT:**

# EPIC-001: [Epic Title]

[Epic description]

## FEAT-001: [Feature Title]

[Feature description]

### F-001: [Feature Item Title]

Description

As a [role],
I want [goal],
So that [benefit].

Acceptance Criteria

GIVEN [context]
WHEN [action]
THEN [result]
AND [additional result]

Notes / Links

Designs:
API:
Test data:

Release Notes

[1-2 sentence plain language summary]

---

### F-002: [Next Feature Item]

[Same structure...]

## FEAT-002: [Next Feature]

[Continue...]

# EPIC-002: [Next Epic]

[Continue with more feature items...]

**START YOUR RESPONSE WITH: # EPIC-001:**`;
}

/**
 * Combine custom prompt with Fabric AI pattern
 */
function combineCustomAndFabricPrompts(
	customPrompt: string,
	fabricPattern: string,
	documentType: string,
): string {
	return `# Your Custom Instructions

${customPrompt}

---

# Document Generation Methodology (Enhanced by Fabric AI)

The following methodology from Fabric AI's "${documentType}" pattern will help ensure high-quality output:

${fabricPattern}

---

# Important

1. Follow your custom instructions above as the PRIMARY guide
2. Use the Fabric AI methodology to STRUCTURE and ENHANCE your output
3. When instructions conflict, prefer your custom instructions
4. Ensure the document follows proper markdown formatting`;
}

/**
 * Build document type-specific prompt
 */
function buildDocumentTypePrompt(
	docConfig: ReturnType<typeof getDocumentPrompt>,
	qualityTier: QualityTier,
): string {
	const baseInstructions = getBaseInstructions(qualityTier);

	const sections = docConfig.sections.map((section, i) => {
		const required = section.required ? "(Required)" : "(Optional)";
		let content = `### ${i + 1}. ${section.name} ${required}\n\n${section.guidance}`;

		if (section.example) {
			content += `\n\n**Example:**\n${section.example}`;
		}

		return content;
	});

	const checklist = docConfig.qualityChecklist
		.map((item) => `- ✓ ${item}`)
		.join("\n");

	const antiPatterns = docConfig.antiPatterns
		.map((item) => `- ✗ ${item}`)
		.join("\n");

	let prompt = `# Role

${docConfig.persona}

${baseInstructions}

# Document Structure

Generate a document with the following sections:

${sections.join("\n\n")}

# Quality Standards

## Before Finalizing, Verify:
${checklist}

## Avoid These Anti-Patterns:
${antiPatterns}`;

	if (docConfig.examples && Object.keys(docConfig.examples).length > 0) {
		const examples = Object.entries(docConfig.examples)
			.map(
				([name, example]) =>
					`### ${formatExampleName(name)}\n\`\`\`\n${example}\n\`\`\``,
			)
			.join("\n\n");

		prompt += `\n\n## Reference Examples\n\n${examples}`;
	}

	if (docConfig.additionalInstructions) {
		prompt += `\n\n${docConfig.additionalInstructions}`;
	}

	return prompt;
}

/**
 * Build RAG context section with enhanced instructions
 */
function buildRagSection(
	ragContexts: string[],
	documentType?: DocumentType,
	hasCustomPrompt = false,
): string {
	const formattedContexts = formatRagContextsSimple(ragContexts);

	// Detect if any contexts are Teams messages (formatted as "[Teams - ...")
	const hasTeamsMessages = ragContexts.some((ctx) =>
		ctx.trim().startsWith("[Teams"),
	);

	// Start with base RAG instructions
	let ragInstructions = STRONG_RAG_INSTRUCTIONS;

	// Add Teams-specific instructions if Teams messages are present
	if (hasTeamsMessages) {
		ragInstructions += `

## 🚨 CRITICAL: Teams Messages Context

Some of the contexts below are **Teams chat messages** (prefixed with "[Teams - ...]").

### How to Use Teams Messages:
1. **Extract ACTION ITEMS**: If a message mentions adding/updating something, DO IT
2. **Extract NAMES**: If a message mentions a person's name (e.g., "add Jordan as stakeholder"), add that EXACT name
3. **Extract DECISIONS**: Use decisions from Teams discussions to update the document
4. **Recent messages = latest requirements**: Treat Teams messages as real-time updates to apply

### Example Teams Message Usage:
- Teams message: "[Teams - Project Chat] Sarah (Jan 15): add Jordan as new stake holder"
- ACTION: Add "Jordan" to the Stakeholders section

**DO NOT ignore Teams messages.** They contain real-time updates that should be applied to the document.`;
	}

	// For PRD, add priority instructions FIRST to ensure RAG contexts are treated as primary source
	if (documentType === "prd") {
		ragInstructions = `${PRD_RAG_PRIORITY_INSTRUCTIONS}

---

${STRONG_RAG_INSTRUCTIONS}`;
	}

	// Add document-type-specific RAG instructions (only when NO custom prompt)
	// When a custom prompt is provided, the custom prompt defines the output format
	// and these default format enforcement instructions would conflict with it
	if (!hasCustomPrompt) {
		if (documentType === "user_story") {
			ragInstructions += `

### 🛑 REMINDER: START WITH # EPIC-001:

Use the retrieved contexts to generate specific, actionable features organized in Epic → Feature → Feature Item hierarchy.

Extract features from the contexts and create feature items that:
- Start with # EPIC-001: [Epic Title], then ## FEAT-001: [Feature Title], then ### F-001: [Feature Item Title]
- Use As a/I want/So that format
- Include G/W/T acceptance criteria
- Have Notes/Links and Release Notes sections

DO NOT create any introduction, personas table, or overview sections.`;
		} else if (documentType === "prd") {
			ragInstructions += `

### 🛑 CRITICAL: PRD TEMPLATE IS MANDATORY

Use the retrieved contexts for CONTENT ONLY, not for structure.

You MUST follow the PM Standard v2 PRD template structure regardless of what format the contexts use:

1. **START** with \`## **PRD**\` header (Title, Owner, Status, Target Release, Links)
2. **USE** these exact sections in order:
   - Benefit Hypothesis ("If we [build X] for [who], then [outcome] because [reason]")
   - Overview (Problem, Why now, Goal, Non-goals)
   - Users / Personas
   - Success Metrics (table format)
   - Scope (In Scope / Out of Scope subsections)
   - Requirements (Must Have / Nice to Have / Non-Functional)
   - Key Flows / Use Cases
   - Dependencies / Risks
   - Open Questions, Work Breakdown, Stakeholders, Release Notes

3. **DO NOT** use any of these forbidden sections:
   - ❌ Executive Summary
   - ❌ Product Vision / Market Analysis
   - ❌ Timeline and Milestones
   - ❌ Appendix
   - ❌ Numbered sections like "1. Overview", "2. Goals"

Extract CONTENT from contexts (requirements, features, technical details) but output using the EXACT template structure.`;
		} else if (documentType === "proposal") {
			ragInstructions += `

### 🛑 CRITICAL: YOUR FIRST LINE MUST BE "### **Project Proposal**"

**IGNORE THE STRUCTURE OF THE CONTEXTS BELOW.** Extract CONTENT ONLY.

You MUST follow the PM Standard v2 Proposal template EXACTLY:

1. **START** with \`### **Project Proposal**\` then each metadata field on its own line:
   - **Title:** / **Client/Team:** / **Sponsor:** / **Owner:** / **Date:** / **Version:** / **Links:**

2. **THEN** these sections in EXACT order:
   - \`### **Benefit Hypothesis**\` - "If we deliver [X], then [Y] improves by [Z] because [reason]"
   - \`### **Overview**\` - Current state, Proposed solution, Outcome (bullets)
   - \`### **Scope**\` with In Scope / Out of Scope subsections
   - \`### **Deliverables**\` - Product, Engineering, Quality, Ops
   - \`### **Plan (Phases)**\` - Discovery, Build, Test & Launch, Post-launch
   - \`### **Success Metrics**\` - TABLE format
   - \`### **Dependencies / Risks**\`
   - \`### **Stakeholders**\`
   - \`### **Open Questions**\`
   - \`### **Release Notes**\`

3. **DO NOT** use ANY of these (INSTANT FAILURE):
   - Executive Summary, Table of Contents, Problem Statement
   - System Architecture, Data Models, Core Modules
   - Timeline, Roadmap, Milestones, Budget, ROI
   - Appendix, Terminology, Sign-off, Approvals
   - ANY numbered sections (1., 2., 3.)

**The reference documents below are for CONTENT EXTRACTION ONLY - DO NOT COPY THEIR STRUCTURE.**`;
		}
	}

	// Add final reminder AFTER contexts for PRD/proposal (context can be long, so repeat at end)
	// Skip when custom prompt is provided — custom prompt defines its own format
	let finalReminder = "";
	if (hasCustomPrompt) {
		// No format enforcement reminders when custom prompt is in use
	} else if (documentType === "prd") {
		finalReminder = `

---

## 🛑 FINAL REMINDER: PM STANDARD V2 PRD TEMPLATE IS MANDATORY

The contexts above are for CONTENT EXTRACTION ONLY. Your output MUST:

1. **START** with \`## **PRD**\` header (Title, Owner, Status, Target Release, Links)
2. **THEN** \`## **Benefit Hypothesis**\` - "If we [build X] for [who], then [outcome] because [reason]"
3. **THEN** \`## **Overview**\` - Problem, Why now, Goal (max 3), Non-goals
4. **Continue** with Users/Personas, Success Metrics, Scope, Requirements, Key Flows, Dependencies/Risks, Open Questions, Work Breakdown, Stakeholders, Release Notes

❌ FORBIDDEN (NEVER USE): Executive Summary, Product Vision, Market Analysis, Timeline and Milestones, Appendix, numbered sections like "1. Overview"

Extract CONTENT from the contexts above but output using the EXACT PM Standard v2 template structure.`;
	} else if (documentType === "proposal") {
		finalReminder = `

---

## 🛑 FINAL REMINDER: YOUR FIRST LINE MUST BE "### **Project Proposal**"

**THE CONTEXTS ABOVE ARE FOR CONTENT EXTRACTION ONLY - DO NOT COPY THEIR STRUCTURE!**

Your output MUST follow this EXACT structure:

\`\`\`
### **Project Proposal**

**Title:** [Name]

**Client/Team:** [Team]

**Sponsor:** [Sponsor]

**Owner:** [Owner]

**Date:** [Date]

**Version:** 1.0

**Links:** PRD · Timeline · Budget · Architecture

---

### **Benefit Hypothesis**

If we deliver **[solution]**, then **[impact]** improves by **[metric]** because **[reason]**.

### **Overview**

- **Current state:** ...
- **Proposed solution:** ...
- **Outcome:** ...

### **Scope**

### **In Scope**
- ...

### **Out of Scope**
- ...

### **Deliverables**
### **Plan (Phases)**
### **Success Metrics**
### **Dependencies / Risks**
### **Stakeholders**
### **Open Questions**
### **Release Notes**
\`\`\`

❌ FORBIDDEN (INSTANT FAILURE): Executive Summary, Table of Contents, Problem Statement, System Architecture, Data Models, Timeline, Roadmap, Budget, Appendix, numbered sections (1. 2. 3.)

**START YOUR RESPONSE WITH: ### **Project Proposal****`;
	}

	return `${ragInstructions}

---

## Retrieved Context

${formattedContexts}${finalReminder}`;
}

/**
 * Extract section headings from a document for editing instructions.
 */
function extractHeadingsList(existingDocument: string): string {
	const headingPattern = /^(#{2,3})\s+(.+)$/gm;
	const existingHeadings: string[] = [];
	for (
		let match = headingPattern.exec(existingDocument);
		match !== null;
		match = headingPattern.exec(existingDocument)
	) {
		existingHeadings.push(match[2].trim());
	}

	return existingHeadings.length > 0
		? `\n\n**Sections that ALREADY EXIST in this document (DO NOT recreate):**\n${existingHeadings.map((h) => `- ${h}`).join("\n")}\n\nIf you need to change content in any of these sections, edit WITHIN the existing section. Do NOT create a second copy.`
		: "";
}

/**
 * Extract section headings as full anchor paths for patch-mode editing.
 * Paths use ` > ` to separate levels, e.g. "## Overview > ### Goals". These
 * are the exact strings the model should copy into apply_document_patches
 * anchor fields.
 */
function extractAnchorPathsList(existingDocument: string): string {
	const paths = listAnchorPaths(existingDocument);
	if (paths.length === 0) {
		return "";
	}
	return `\n\n**Available anchor paths in this document** (copy one verbatim into each patch's \`anchor\` field):\n${paths.map((p) => `- \`${p}\``).join("\n")}`;
}

/**
 * Build editing rules for the system prompt (instructions only, no document body).
 *
 * Tells the AI it is editing an existing document and lists existing section headings.
 * The actual document content is provided separately in a user message.
 *
 * In patch mode, the heading list is rendered as full anchor paths so the
 * model can copy them verbatim into patch calls. The rules themselves are
 * also shorter because patches only touch what they explicitly reference.
 */
/**
 * Cross-section consistency directive appended to every editing-rules block.
 *
 * The other editing rules ("make ONLY the requested change", "keep all sections
 * verbatim") exist to stop gratuitous full rewrites — but taken alone they lead
 * the model to apply a decision in ONE section and leave the others (commonly
 * the lower ones like Acceptance Criteria) stale and contradicting it. That is
 * the reported "updates the Use Cases but not the ACs" failure. This makes
 * propagation of a cross-cutting change explicit.
 */
function crossSectionConsistencyClause(toolMode: "write" | "patch"): string {
	const applyLine =
		toolMode === "patch"
			? "emit a patch for EVERY section the change touches — not just the first one you find"
			: "update EVERY section the change touches in your rewrite";
	return `

**CROSS-SECTION CONSISTENCY (critical):** When the user's change is a decision, requirement, term, rule, or constraint that affects more than one section — e.g. "bulk-added users should be members, not admins", a renamed field, or a changed acceptance rule — ${applyLine}. Update the Acceptance Criteria, Use Cases, Requirements, Data/Validation rules, and every other section that references the changed concept so the whole document stays internally consistent. "Make only the requested change" means do not rewrite UNRELATED content — it does NOT mean apply the decision in one place and leave other sections (especially lower ones like Acceptance Criteria) contradicting it. Before finishing, re-read every section and confirm none contradicts the change you just made.`;
}

function buildEditingRules(
	existingDocument: string,
	toolMode: "write" | "patch" = "write",
): string {
	if (toolMode === "patch") {
		const anchorList = extractAnchorPathsList(existingDocument);
		return `## You Are EDITING an Existing Document Using Patches

**PATCH MODE RULES:**
1. Never rewrite the full document. Emit small, targeted \`apply_document_patches\` operations instead.
2. Every patch's \`anchor\` MUST be a full heading path copied verbatim from the list below.
3. Do NOT invent anchor paths or change heading text. If you need to rename a section, use \`replace_section\` with \`keepHeading: false\`.
4. Preserve the document title, type, and all unrelated sections by simply not referencing them.
5. Each patch's \`content\` is ONLY the new or replacement markdown — never the surrounding document.${anchorList}${crossSectionConsistencyClause("patch")}

The current document content is provided in the conversation as a user message.`;
	}

	const headingsList = extractHeadingsList(existingDocument);

	return `## You Are EDITING an Existing Document — NOT Creating From Scratch

**EDITING RULES:**
1. NEVER change the document title or document type (e.g., if it is a "Product Requirements Document", it stays a "Product Requirements Document")
2. Keep ALL existing sections, headings, and their content unless the user specifically asks to change them
3. Make ONLY the changes the user requested — add a few bullet points or short paragraphs, do not rewrite existing text
4. Do NOT create new sections that already exist (see list below)
5. Your output must be the COMPLETE document with your small edits applied in place
6. Preserve the original wording, tone, and structure throughout${headingsList}${crossSectionConsistencyClause("write")}

The current document content is provided in the conversation as a user message.`;
}

/**
 * Build current document state section (full version with embedded document body).
 *
 * Used when excludeDocumentBody is false (legacy behavior).
 * Extracts section headers from the existing document and explicitly tells the AI
 * which sections already exist to prevent duplicate sections during edits.
 */
function buildCurrentDocumentSection(existingDocument: string): string {
	const headingsList = extractHeadingsList(existingDocument);

	return `## Current Document State — YOU ARE EDITING, NOT CREATING

**This document already exists.** You are making targeted edits, not writing from scratch.

**EDITING RULES:**
1. NEVER change the document title or document type (e.g., if it is a "Product Requirements Document", it stays a "Product Requirements Document")
2. Keep ALL existing sections, headings, and their content unless the user specifically asks to change them
3. Make ONLY the changes the user requested — add a few bullet points or short paragraphs, do not rewrite existing text
4. Do NOT create new sections that already exist (see list below)
5. Your output must be the COMPLETE document with your small edits applied in place
6. Preserve the original wording, tone, and structure throughout${headingsList}${crossSectionConsistencyClause("write")}

---
${existingDocument}
---`;
}

/**
 * Format example name from camelCase to Title Case
 */
function formatExampleName(name: string): string {
	return name
		.replace(/([A-Z])/g, " $1")
		.replace(/^./, (str) => str.toUpperCase())
		.trim();
}
