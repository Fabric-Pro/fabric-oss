/**
 * RAG Instructions
 *
 * Instructions for using retrieved context from the project's knowledge base.
 */

/**
 * Instructions for using retrieved context
 */
export const RAG_USAGE_INSTRUCTIONS = `## Using Retrieved Context

Reference context from the project's knowledge base is provided below.
Use this information to create a more accurate and consistent document.

### How to Use Context:

1. **Integrate Relevant Details**
   - Weave specific information from context where it applies
   - Use exact terminology, names, and specifications from context
   - Reference specific decisions, requirements, or constraints mentioned

2. **Maintain Consistency**
   - Do NOT contradict facts established in prior documents
   - Use the same terminology and naming conventions
   - Align with architectural decisions already made
   - Respect constraints and requirements already documented

3. **Expand, Don't Repeat**
   - Use context to inform NEW content, not just copy it
   - Build upon existing information with additional detail
   - Fill gaps that context doesn't cover using your expertise

4. **Handle Conflicts**
   - If context seems outdated, prefer more recent information
   - If context is contradictory, note the discrepancy
   - Make reasonable judgment calls and document assumptions

5. **Cite When Relevant**
   - When referencing specific context, you may note the source
   - This helps maintain traceability in documentation`;

/**
 * Enhanced RAG usage instructions with explicit requirements
 * This version is more forceful and includes verification checklist
 */
export const STRONG_RAG_INSTRUCTIONS = `## CRITICAL: Reference Context Usage

Use the provided reference contexts for CONTENT (facts, requirements, details) but NOT for document STRUCTURE.

### Requirements:
1. **Follow the template structure** - The document template/format is MANDATORY. Never copy the structure from contexts.
2. **Extract content from contexts** - Use facts, requirements, and details from contexts
3. **Use exact terminology** from contexts when applicable (project names, technical terms, feature names)
4. **Cite contexts** when making specific claims or referencing decisions
5. **Do NOT make up information** that contradicts the provided contexts
6. **Content from contexts, structure from template** - If context has a different document format, IGNORE its format

### Citation Format:
When referencing a context, use one of these formats:
- "According to Reference [N]..."
- "As noted in the project context..."
- "Based on the provided context..."
- "As specified in Reference [N]..."

### Verification Checklist:
Before finalizing your document, verify:
- [ ] At least 3 contexts are directly referenced or cited
- [ ] Technical terms match the terminology used in contexts
- [ ] Project-specific names, features, and decisions are accurately reflected
- [ ] No contradictions with information provided in contexts
- [ ] Specific details come from contexts, not general knowledge
- [ ] Context information is integrated naturally, not just copied verbatim

### Examples of Good Context Usage:

**Good**: "According to Reference 1, the project uses PostgreSQL for data persistence. The architecture document (Reference 2) specifies that we should use connection pooling to handle high concurrency."

**Good**: "As noted in the project context, the authentication system uses OAuth 2.0 with JWT tokens. This aligns with the security requirements mentioned in Reference 3."

**Bad**: "The system uses a database for storage." (Too generic, doesn't reference context)

**Bad**: "We should use PostgreSQL." (Doesn't cite where this comes from)

### Anti-Patterns to Avoid:
- ✗ Ignoring context and using only general knowledge
- ✗ Contradicting information provided in contexts
- ✗ Using different terminology than what's in contexts
- ✗ Making up specific details that aren't in contexts
- ✗ Copying context verbatim without integration`;

/**
 * PRD-specific RAG instructions that prioritize reference documents as the PRIMARY source
 * for defining product scope, features, and requirements.
 */
export const PRD_RAG_PRIORITY_INSTRUCTIONS = `## 🚨 CRITICAL: REFERENCE DOCUMENTS DEFINE THE PRODUCT SCOPE

**The reference documents below are your PRIMARY source for understanding what this product should include.**

### Hierarchy of Information Sources:
1. **PRIMARY: Reference Documents (RAG Contexts)** - These define the product vision, features, capabilities, and requirements
2. **SECONDARY: Project Metadata** - Project name, tech stack, and listed features provide additional context
3. **TERTIARY: Your Knowledge** - Fill gaps only when reference documents don't cover something

### What You MUST Do:
1. **READ ALL REFERENCE DOCUMENTS THOROUGHLY** before writing anything
2. **EXTRACT ALL FEATURES** mentioned in the reference documents - not just some, ALL of them
3. **The PRD must cover the product described in the references**, not just the features listed in project metadata
4. **If reference documents describe features X, Y, Z but project metadata only lists A, B** → Include X, Y, Z, A, B in the PRD
5. **Every major capability from reference documents should appear in your PRD**

### Common Mistake to AVOID:
❌ **WRONG**: Writing a PRD only about "User Registration, Login, Dark Mode" because those are in project features, while IGNORING "AI Recommendations, Loyalty Program, Kitchen Display System" from reference documents.

✅ **CORRECT**: Writing a PRD that covers ALL capabilities from reference documents (AI Recommendations, Loyalty, Kitchen Display, etc.) PLUS any additional features from project metadata.

### Before Submitting, Verify:
- [ ] Did I read ALL reference documents?
- [ ] Does my PRD include ALL major features/capabilities mentioned in the references?
- [ ] Am I covering the FULL product scope from the references, not just project metadata?
- [ ] Have I extracted specific details (metrics, user flows, technical specs) from references?`;

/**
 * Format retrieved contexts for the prompt
 *
 * @param contexts - Array of context content strings
 * @param options - Formatting options
 * @returns Formatted context section
 */
export function formatRagContexts(
	contexts: string[],
	options?: {
		/** Include source metadata if available */
		includeMetadata?: boolean;
		/** Maximum contexts to include */
		maxContexts?: number;
	},
): string {
	if (!contexts || contexts.length === 0) {
		return "";
	}

	const { maxContexts = 10 } = options || {};
	const contextsToUse = contexts.slice(0, maxContexts);

	const formattedContexts = contextsToUse.map((ctx, i) => {
		return `### Reference ${i + 1}
${ctx}`;
	});

	return `${RAG_USAGE_INSTRUCTIONS}

---

## Retrieved Context

${formattedContexts.join("\n\n")}`;
}

/**
 * Format contexts with metadata (filename, type, score)
 */
export interface ContextWithMetadata {
	content: string;
	filename?: string;
	type?: string;
	score?: number;
}

export function formatRagContextsWithMetadata(
	contexts: ContextWithMetadata[],
): string {
	if (!contexts || contexts.length === 0) {
		return "";
	}

	const formattedContexts = contexts.map((ctx, i) => {
		const source = ctx.filename || `Context ${i + 1}`;
		const typeInfo = ctx.type ? ` (${ctx.type})` : "";
		const scoreInfo =
			ctx.score !== undefined
				? ` - Relevance: ${(ctx.score * 100).toFixed(0)}%`
				: "";

		return `### ${source}${typeInfo}${scoreInfo}
${ctx.content}`;
	});

	return `${RAG_USAGE_INSTRUCTIONS}

---

## Retrieved Context

${formattedContexts.join("\n\n")}`;
}
