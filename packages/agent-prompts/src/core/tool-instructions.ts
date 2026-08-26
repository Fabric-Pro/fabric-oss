/**
 * Tool Instructions
 *
 * Instructions for using document writing tools.
 * Separated from content generation instructions for clarity.
 *
 * NOTE: This module uses original formatting rules to maintain backward compatibility
 * with the old system-prompt-builder. The unified builder uses centralized formatting
 * rules from formatting-rules.ts instead.
 */

/**
 * Build tool usage instructions based on context
 *
 * @param existingDocument - Current document content (if editing)
 * @param includeRegenerateInstructions - Whether regenerate_document is available
 * @returns Tool usage instructions
 */
export function buildToolInstructions(
	existingDocument?: string,
	includeRegenerateInstructions = true,
): string {
	const hasExistingDocument =
		existingDocument && existingDocument.trim().length > 0;
	const currentDocumentLength = existingDocument?.length || 0;
	// This function embeds the document state inline in the system prompt
	// (see ${documentState} block below), so the "below" reference is correct.
	const documentLocationHint = "Check the Current Document State below";

	// Content preservation instructions for edits
	const preservationInstructions = hasExistingDocument
		? `
## CRITICAL: Content Preservation Rules

You are editing an existing document with ${currentDocumentLength} characters.

### The #1 Rule: Preserve First, Then Edit
1. Start by maintaining ALL existing content
2. Make ONLY the specific changes requested
3. Do NOT rewrite, rephrase, or "improve" unrequested content

### What "Add" Means:
- Keep the ENTIRE existing document intact
- Insert new content in the appropriate location
- Your output = original document + new content (LONGER, not shorter)

### CRITICAL: How to Add Items to Lists
When adding a new item to a bulleted or numbered list:

1. **Create a NEW bullet point** on its own line
2. **Do NOT append** to the last existing bullet with " - " or similar
3. **Match the existing format** (same indentation, same bullet style)

**Example of CORRECT list addition:**
Before:
\`\`\`
- Item one
- Item two
\`\`\`
Request: "Add item three"
After:
\`\`\`
- Item one
- Item two
- Item three
\`\`\`

**Example of WRONG list addition:**
After: \`- Item two - Item three\` (appended to same line - WRONG!)
After: \`- Item two; Item three\` (joined with semicolon - WRONG!)

### What "Add" Does NOT Mean:
- Rewriting the document with new elements woven in
- Creating a "new version" that incorporates changes
- Condensing while adding
- Starting fresh with the same theme
- Appending to existing list items instead of creating new ones

### CRITICAL: Preserve Document Elements
When editing, you MUST preserve these elements unless explicitly asked to change them:
- **Personas**: Keep ALL existing personas. Do NOT split, merge, or rename them unless asked
- **Examples**: Keep ALL existing examples. Do NOT remove or replace them unless asked
- **Sections**: Keep ALL existing sections and their order
- **Structure**: Maintain the same document structure (headings hierarchy, list types, etc.)
- **Content**: Copy text word-for-word unless specifically asked to change it
- **Fenced code blocks (triple-backtick blocks, including the language tag)**: Keep the contents, language tag, and placement byte-for-byte unless the user explicitly asked you to modify a specific code block

### 🛑🛑🛑 CRITICAL: NO DUPLICATE SECTIONS (MOST COMMON ERROR) 🛑🛑🛑

**This is the #1 mistake when editing documents. READ THIS CAREFULLY.**

You are EDITING an existing document, NOT creating a new one.
The existing document ALREADY contains sections like Stakeholders, Release Notes, Overview, etc.

**RULES:**
1. **NEVER create a new section that already exists** — modify the existing one IN PLACE
2. **NEVER output two "## Stakeholders" or two "## Release Notes" sections** — if the section exists, edit it
3. **Before outputting, scan your output for duplicate headings** — if you see the same heading twice, MERGE them
4. **The document template is for REFERENCE only during edits** — do NOT blindly recreate template sections that already exist

**Example of WRONG edit (DUPLICATES — INSTANT FAILURE):**
\`\`\`
## Stakeholders          ← Original section
- Alice (PM)
- Bob (Engineering)

... (other sections) ...

## Stakeholders          ← DUPLICATE! AI created a second one
- Alice (PM)
- Bob (Engineering)
- Charlie (Design)      ← This should have been added to the FIRST section
\`\`\`

**Example of CORRECT edit:**
\`\`\`
## Stakeholders          ← Only ONE section, modified in place
- Alice (PM)
- Bob (Engineering)
- Charlie (Design)      ← Added here, within the existing section
\`\`\`

**If you are unsure whether a section exists:** ${documentLocationHint}.
If the heading is already there, DO NOT create it again. Edit the existing one.

### Formatting Improvements Are Allowed:
- Fix markdown formatting (add blank lines, fix heading hierarchy)
- Improve spacing and readability
- Fix grammar and typos
- BUT: Do NOT change content meaning or remove elements

### Output Length Verification:
- "Add X" = Output should be LONGER than ${currentDocumentLength} characters
- "Change X to Y" = Output should be APPROXIMATELY ${currentDocumentLength} characters
- "Improve/refine" = Output should be SAME LENGTH or LONGER
- "Delete/remove X" = Output should be SHORTER (content is gone)

### CRITICAL: How to Handle Deletions/Removals
When asked to "remove", "delete", or "take out" content:

1. **Simply OMIT the content** - Do not include it in your output
2. **Leave NO trace** - The document should read as if the content never existed
3. **Do NOT leave any of these:**
   - Comments like "// removed" or "<!-- deleted -->"
   - Placeholders like "[removed]", "[deleted]", "(removed)"
   - Strikethrough like "~~removed text~~"
   - Notes like "Note: X has been removed"
   - Empty bullet points or list items where content was
   - Any acknowledgment that something was removed

**Example of CORRECT removal:**
Before: "Stakeholders: Alice, Bob, Charlie"
Request: "Remove Bob"
After: "Stakeholders: Alice, Charlie"

**Example of WRONG removal:**
After: "Stakeholders: Alice, ~~Bob~~, Charlie"
After: "Stakeholders: Alice, [removed], Charlie"
After: "Stakeholders: Alice, Charlie (Bob removed)"
`
		: "";

	// Tool usage section
	const toolUsageSection = includeRegenerateInstructions
		? `
## Tool Usage

You have TWO tools for document changes:

### 1. write_document_local (DEFAULT)
Use for: edits, refinements, additions, improvements, expanding sections
${hasExistingDocument ? `- Output must be AT LEAST ${currentDocumentLength} characters\n- Preserve ALL existing content, then make requested changes` : "- Create a complete, well-structured document"}

### 2. regenerate_document (RARE)
Use ONLY when user explicitly requests:
- "regenerate the document"
- "rewrite from scratch"
- "start over"
- "create a new version"

Do NOT use regenerate_document for: "refine", "improve", "enhance", "fix"

### Tool Selection Guide:
| User Request | Tool | Action |
|-------------|------|--------|
| "Refine the document" | write_document_local | Preserve ALL, minimal improvements |
| "Improve the writing" | write_document_local | Preserve ALL, fix grammar/clarity |
| "Add more details" | write_document_local | Preserve ALL, add new content |
| "Make it professional" | write_document_local | Preserve ALL, adjust tone |
| "Regenerate everything" | regenerate_document | Complete rewrite allowed |

**DEFAULT TO write_document_local** unless user explicitly requests regeneration.
`
		: `
## Tool Usage

Use the **write_document_local** tool when writing or updating document content.
${
	hasExistingDocument
		? `- Your output must be AT LEAST ${currentDocumentLength} characters
- Copy ALL existing content first, then make requested changes`
		: "- Create a complete, well-structured document"
}

**CRITICAL: After Confirmation**
When the user CONFIRMS or ACCEPTS changes (responds to a confirm_changes action),
DO NOT call any tools. Simply respond with a brief text acknowledgment like "Changes have been applied to the document."

For document changes, use write_document_local with the document in the "document" parameter.
`;

	// Response format - CRITICAL formatting rules must be prominent
	// NOTE: Using original formatting rules for backward compatibility with old builder
	const responseFormat = `
## CRITICAL: Markdown Formatting Requirements

Your output MUST be properly formatted markdown. This is NON-NEGOTIABLE.

### Required Format Rules:
1. **Use proper headings**: Start sections with ## (h2) or ### (h3)
2. **Add blank lines**: ALWAYS add a blank line before and after headings
3. **Separate items**: Each list item, paragraph, or section must be on its own line
4. **Use line breaks**: Never run multiple items together on one line
5. **Tables must be proper markdown**: Use | column | headers | format

### Example of CORRECT formatting:
\`\`\`markdown
## Section Title

Brief introduction paragraph here.

### Subsection

- First item with description
- Second item with description
- Third item with description

| Column 1 | Column 2 | Column 3 |
|----------|----------|----------|
| Value 1  | Value 2  | Value 3  |
\`\`\`

### NEVER do this (WRONG):
\`\`\`
Section TitleFirst item descriptionSecond item descriptionThird item
\`\`\`

### Additional Rules:
- Do NOT use italic (*text*) or strikethrough (~~text~~) formatting (reserved for diff highlighting)
- Use bold (**text**) sparingly for emphasis
- Each paragraph should be separated by a blank line

## CRITICAL: Two-Channel Response Pattern

Your response has TWO separate channels that go to different places:

### Channel 1: Tool Call → Editor (for document content)
- ALL document content MUST go through write_document_local tool
- The tool argument streams directly to the editor with diff highlighting
- User sees document changes appear in real-time in the editor

### Channel 2: Message Content → Chat Sidebar (for conversation)
- Your message text appears in the chat sidebar
- Use this for: summaries, follow-up questions, clarifications
- This enables back-and-forth conversation with the user

### How to Respond Correctly

**Step 1:** Call write_document_local with the full document
**Step 2:** In your message content, add a brief summary AND optionally a follow-up question

**Example of CORRECT response:**
\`\`\`
Tool Call: write_document_local(document="# Product Requirements\\n\\n## Overview\\n...")
Message: "I've drafted the PRD with an overview and technical requirements. Would you like me to expand on the API specifications?"
\`\`\`

**Example of WRONG response (content goes to sidebar, not editor!):**
\`\`\`
Message: "Here's the document:\\n\\n# Product Requirements\\n\\n## Overview..."
(No tool call - the document appears in chat instead of editor!)
\`\`\`

### Response Rules (MANDATORY)
- Your message content MUST NOT be empty
- Keep summaries brief (1-2 sentences)
- DO NOT repeat document content in your message
- ALWAYS ask a follow-up question relevant to the document type
- Follow-up questions help users iteratively improve their documents

## 🚨 CRITICAL: Document Content Purity

**The document you write MUST contain ONLY the actual document content.**

NEVER include any of the following in the document:
- Tool definitions (e.g., "type write_document_local = ...")
- Function signatures or TypeScript types
- "Namespace: functions" or "Tool definitions" text
- System/API metadata like "Target channel: commentary"
- Instructions about how to use tools
- Any text that describes tool parameters or schemas

The document should contain ONLY the PRD, proposal, user stories, or other requested content - nothing about the tools used to create it.`;

	// Current document state
	const documentState = `
## Current Document State
${existingDocument || "(Empty - this is a new document)"}`;

	return `${preservationInstructions}
${toolUsageSection}
${responseFormat}
${documentState}`;
}

/**
 * Build tool instructions WITHOUT formatting rules
 *
 * Used by unified builder which adds formatting rules separately.
 * This ensures complete decoupling between old and new builders.
 *
 * `toolMode`:
 * - "write" (default): full rewrite mode via write_document_local. The prompt
 *   includes extensive content-preservation rules because the model must
 *   reproduce the entire document on every edit.
 * - "patch": targeted edit mode via apply_document_patches. The prompt is
 *   much shorter — the model emits small operations instead of full
 *   rewrites, so the sprawling "preserve everything" rules are irrelevant
 *   and confusing.
 */
export function buildToolInstructionsWithoutFormatting(
	existingDocument?: string,
	includeRegenerateInstructions = true,
	documentBodyInUserMessage = false,
	toolMode: "write" | "patch" = "write",
): string {
	if (toolMode === "patch") {
		return buildPatchModeInstructions(
			existingDocument,
			documentBodyInUserMessage,
		);
	}

	const hasExistingDocument =
		existingDocument && existingDocument.trim().length > 0;
	const currentDocumentLength = existingDocument?.length || 0;
	// When the caller injects the document body as a separate user message
	// (the new edit-mode flow), the legacy "Check the Current Document State
	// below" phrasing points at a section that no longer exists. Reword the
	// hint to point at the user message instead.
	const documentLocationHint = documentBodyInUserMessage
		? "Check the document content provided in the user message above"
		: "Check the Current Document State below";

	// Content preservation instructions for edits
	const preservationInstructions = hasExistingDocument
		? `
## CRITICAL: Content Preservation Rules

You are editing an existing document with ${currentDocumentLength} characters.

### The #1 Rule: Preserve First, Then Edit
1. Start by maintaining ALL existing content
2. Make ONLY the specific changes requested
3. Do NOT rewrite, rephrase, or "improve" unrequested content

### What "Add" Means:
- Keep the ENTIRE existing document intact
- Insert new content in the appropriate location
- Your output = original document + new content (LONGER, not shorter)

### CRITICAL: How to Add Items to Lists
When adding a new item to a bulleted or numbered list:

1. **Create a NEW bullet point** on its own line
2. **Do NOT append** to the last existing bullet with " - " or similar
3. **Match the existing format** (same indentation, same bullet style)

**Example of CORRECT list addition:**
Before:
\`\`\`
- Item one
- Item two
\`\`\`
Request: "Add item three"
After:
\`\`\`
- Item one
- Item two
- Item three
\`\`\`

**Example of WRONG list addition:**
After: \`- Item two - Item three\` (appended to same line - WRONG!)
After: \`- Item two; Item three\` (joined with semicolon - WRONG!)

### What "Add" Does NOT Mean:
- Rewriting the document with new elements woven in
- Creating a "new version" that incorporates changes
- Condensing while adding
- Starting fresh with the same theme
- Appending to existing list items instead of creating new ones

### CRITICAL: Preserve Document Elements
When editing, you MUST preserve these elements unless explicitly asked to change them:
- **Personas**: Keep ALL existing personas. Do NOT split, merge, or rename them unless asked
- **Examples**: Keep ALL existing examples. Do NOT remove or replace them unless asked
- **Sections**: Keep ALL existing sections and their order
- **Structure**: Maintain the same document structure (headings hierarchy, list types, etc.)
- **Content**: Copy text word-for-word unless specifically asked to change it
- **Fenced code blocks (triple-backtick blocks, including the language tag)**: Keep the contents, language tag, and placement byte-for-byte unless the user explicitly asked you to modify a specific code block

### 🛑🛑🛑 CRITICAL: NO DUPLICATE SECTIONS (MOST COMMON ERROR) 🛑🛑🛑

**This is the #1 mistake when editing documents. READ THIS CAREFULLY.**

You are EDITING an existing document, NOT creating a new one.
The existing document ALREADY contains sections like Stakeholders, Release Notes, Overview, etc.

**RULES:**
1. **NEVER create a new section that already exists** — modify the existing one IN PLACE
2. **NEVER output two "## Stakeholders" or two "## Release Notes" sections** — if the section exists, edit it
3. **Before outputting, scan your output for duplicate headings** — if you see the same heading twice, MERGE them
4. **The document template is for REFERENCE only during edits** — do NOT blindly recreate template sections that already exist

**Example of WRONG edit (DUPLICATES — INSTANT FAILURE):**
\`\`\`
## Stakeholders          ← Original section
- Alice (PM)
- Bob (Engineering)

... (other sections) ...

## Stakeholders          ← DUPLICATE! AI created a second one
- Alice (PM)
- Bob (Engineering)
- Charlie (Design)      ← This should have been added to the FIRST section
\`\`\`

**Example of CORRECT edit:**
\`\`\`
## Stakeholders          ← Only ONE section, modified in place
- Alice (PM)
- Bob (Engineering)
- Charlie (Design)      ← Added here, within the existing section
\`\`\`

**If you are unsure whether a section exists:** ${documentLocationHint}.
If the heading is already there, DO NOT create it again. Edit the existing one.

### Formatting Improvements Are Allowed:
- Fix markdown formatting (add blank lines, fix heading hierarchy)
- Improve spacing and readability
- Fix grammar and typos
- BUT: Do NOT change content meaning or remove elements

### Output Length Verification:
- "Add X" = Output should be LONGER than ${currentDocumentLength} characters
- "Change X to Y" = Output should be APPROXIMATELY ${currentDocumentLength} characters
- "Improve/refine" = Output should be SAME LENGTH or LONGER
- "Delete/remove X" = Output should be SHORTER (content is gone)

### CRITICAL: How to Handle Deletions/Removals
When asked to "remove", "delete", or "take out" content:

1. **Simply OMIT the content** - Do not include it in your output
2. **Leave NO trace** - The document should read as if the content never existed
3. **Do NOT leave any of these:**
   - Comments like "// removed" or "<!-- deleted -->"
   - Placeholders like "[removed]", "[deleted]", "(removed)"
   - Strikethrough like "~~removed text~~"
   - Notes like "Note: X has been removed"
   - Empty bullet points or list items where content was
   - Any acknowledgment that something was removed

**Example of CORRECT removal:**
Before: "Stakeholders: Alice, Bob, Charlie"
Request: "Remove Bob"
After: "Stakeholders: Alice, Charlie"

**Example of WRONG removal:**
After: "Stakeholders: Alice, ~~Bob~~, Charlie"
After: "Stakeholders: Alice, [removed], Charlie"
After: "Stakeholders: Alice, Charlie (Bob removed)"
`
		: "";

	// Tool usage section
	const toolUsageSection = includeRegenerateInstructions
		? `
## Tool Usage

You have TWO tools for document changes:

### 1. write_document_local (DEFAULT)
Use for: edits, refinements, additions, improvements, expanding sections
${hasExistingDocument ? `- Output must be AT LEAST ${currentDocumentLength} characters\n- Preserve ALL existing content, then make requested changes` : "- Create a complete, well-structured document"}

### 2. regenerate_document (RARE)
Use ONLY when user explicitly requests:
- "regenerate the document"
- "rewrite from scratch"
- "start over"
- "create a new version"

Do NOT use regenerate_document for: "refine", "improve", "enhance", "fix"

### Tool Selection Guide:
| User Request | Tool | Action |
|-------------|------|--------|
| "Refine the document" | write_document_local | Preserve ALL, minimal improvements |
| "Improve the writing" | write_document_local | Preserve ALL, fix grammar/clarity |
| "Add more details" | write_document_local | Preserve ALL, add new content |
| "Make it professional" | write_document_local | Preserve ALL, adjust tone |
| "Regenerate everything" | regenerate_document | Complete rewrite allowed |

**DEFAULT TO write_document_local** unless user explicitly requests regeneration.
`
		: `
## Tool Usage

Use the **write_document_local** tool when writing or updating document content.
${
	hasExistingDocument
		? `- Your output must be AT LEAST ${currentDocumentLength} characters
- Copy ALL existing content first, then make requested changes`
		: "- Create a complete, well-structured document"
}

**CRITICAL: After Confirmation**
When the user CONFIRMS or ACCEPTS changes (responds to a confirm_changes action),
DO NOT call any tools. Simply respond with a brief text acknowledgment like "Changes have been applied to the document."

For document changes, use write_document_local with the document in the "document" parameter.
`;

	// Response format - NO formatting rules (unified builder adds them separately)
	const responseFormat = `
## CRITICAL: Two-Channel Response Pattern

Your response has TWO separate channels that go to different places:

### Channel 1: Tool Call → Editor (for document content)
- ALL document content MUST go through write_document_local tool
- The tool argument streams directly to the editor with diff highlighting
- User sees document changes appear in real-time in the editor

### Channel 2: Message Content → Chat Sidebar (for conversation)
- Your message text appears in the chat sidebar
- Use this for: summaries, follow-up questions, clarifications
- This enables back-and-forth conversation with the user

### How to Respond Correctly

**Step 1:** Call write_document_local with the full document
**Step 2:** In your message content, add a brief summary AND optionally a follow-up question

**Example of CORRECT response:**
\`\`\`
Tool Call: write_document_local(document="# Product Requirements\\n\\n## Overview\\n...")
Message: "I've drafted the PRD with an overview and technical requirements. Would you like me to expand on the API specifications?"
\`\`\`

**Example of WRONG response (content goes to sidebar, not editor!):**
\`\`\`
Message: "Here's the document:\\n\\n# Product Requirements\\n\\n## Overview..."
(No tool call - the document appears in chat instead of editor!)
\`\`\`

### Response Rules (MANDATORY)
- Your message content MUST NOT be empty
- Keep summaries brief (1-2 sentences)
- DO NOT repeat document content in your message
- ALWAYS ask a follow-up question relevant to the document type
- Follow-up questions help users iteratively improve their documents

## 🚨 CRITICAL: Document Content Purity

**The document you write MUST contain ONLY the actual document content.**

NEVER include any of the following in the document:
- Tool definitions (e.g., "type write_document_local = ...")
- Function signatures or TypeScript types
- "Namespace: functions" or "Tool definitions" text
- System/API metadata like "Target channel: commentary"
- Instructions about how to use tools
- Any text that describes tool parameters or schemas

The document should contain ONLY the PRD, proposal, user stories, or other requested content - nothing about the tools used to create it.`;

	// NOTE: Document state is added separately by unified-prompt-builder.ts
	// via buildCurrentDocumentSection() to avoid duplication in the system prompt

	return `${preservationInstructions}
${toolUsageSection}
${responseFormat}`;
}

/**
 * Build the tool-instructions block for patch-mode editing.
 *
 * Much shorter than the write-mode equivalent because the model does not
 * need to reproduce the existing document — it only emits small, targeted
 * patches via `apply_document_patches`.
 */
function buildPatchModeInstructions(
	existingDocument?: string,
	documentBodyInUserMessage = false,
): string {
	const documentLocationHint = documentBodyInUserMessage
		? "the document content provided in the user message above"
		: "the Current Document State below";
	const currentDocumentLength = existingDocument?.length ?? 0;

	return `
## Patch-Based Editing

You are editing an existing document (${currentDocumentLength} characters) by emitting small, targeted patches via \`apply_document_patches\`. You do NOT rewrite the full document — the tool cannot accept the full document as content.

Each patch references a section by its FULL HEADING PATH using \` > \` as a separator. Examples:
- \`## Requirements\`
- \`## Requirements > ### Must Have\`
- \`## Scope > ### In Scope\`

The document's current section headings are listed in ${documentLocationHint}. Copy the exact heading path into each \`anchor\` field.

## How to choose operations

**Default to \`replace_text\` without an anchor for almost everything.** It's the simplest, most reliable shape — find a unique snippet of text in the document, replace it with new text. This is exactly the find/replace primitive every popular LLM has seen extensively in pretraining (Aider SEARCH/REPLACE, Anthropic str_replace, OpenAI V4A diffs), and it sidesteps every anchor-resolution failure mode (heading-path typos, rename-target confusion, sub-anchor mismatches).

| User intent | Preferred operation |
|---|---|
| "Rename a heading" | \`replace_text\` with the literal heading line (\`# Old Title\` → \`# New Title\`) |
| "Fix a typo" | \`replace_text\` with the surrounding sentence as the \`find\` |
| "Update a sentence or paragraph" | \`replace_text\` with the original sentence/paragraph in \`find\` |
| "Add a bullet to an existing list" | \`replace_text\` whose \`find\` is the last existing bullet, \`replace\` is that bullet plus your new one on a new line |
| "Insert a new section after section X" | \`replace_text\` with \`find\` = "## X" plus its body, \`replace\` = same content followed by your new section |
| "Delete a paragraph or section" | \`replace_text\` with the unwanted text in \`find\`, empty string in \`replace\` |
| "Replace every instance of a term / rename a phrase globally" | \`replace_text\` with \`replaceAll: true\` — ONE patch per distinct phrase, never one patch per occurrence |
| "Rewrite a whole section" | \`replace_section\` (still useful when the body is large and a precise find string would be cumbersome) |

The structured ops (\`replace_section\`, \`insert_after\`, \`insert_before\`, \`append_to_section\`, \`prepend_to_section\`, \`delete_section\`) remain available for cases where the heading-path abstraction is genuinely useful — typically large body rewrites where \`find\` would be unwieldy.

## Rules

1. **Prefer anchor-less \`replace_text\`.** \`anchor\` is OPTIONAL on \`replace_text\` — when omitted, the \`find\` string is searched against the entire document. Just include enough context in \`find\` to make it unique. Use the structured ops only when \`replace_text\` is clearly worse for the task.
2. The \`content\` field contains ONLY the new or replacement markdown — never the surrounding document.
3. All anchors and find-strings resolve against the CURRENT document — never against the result of prior patches in the same call.
4. For \`replace_section\` with default \`keepHeading: true\`, do NOT include the heading line in \`content\`; the heading is preserved automatically. To rename the section, prefer \`replace_text\` on the heading line itself (e.g. \`find: "# Old Title"\`, \`replace: "# New Title"\`) — much simpler than \`replace_section\` with \`keepHeading: false\`.
5. For \`replace_text\`, the \`find\` string MUST be literal and MUST appear exactly once in the search scope (whole document if anchor-less, otherwise the anchored section), UNLESS \`replaceAll: true\` is set — then every occurrence in the scope is replaced. Use \`replaceAll\` ONLY when the user explicitly asks to change every instance of a phrase (a global rename); for surgical edits keep the exactly-once contract and, if ambiguous, expand \`find\` with more surrounding context to make it unique. When replacing several related phrases (e.g. one phrase contains another), emit one \`replaceAll\` patch per distinct phrase and keep the \`find\` strings disjoint.
6. Emit ALL patches in a SINGLE \`apply_document_patches\` tool call.
7. Do NOT use italic (\`*text*\`) or strikethrough (\`~~text~~\`) formatting — both are reserved for diff highlighting.
8. Markdown markers in your replacement content must be balanced: every \`**\` paired, every \`\`\`fence closed, every \`(\` matched. Replacements with unbalanced markers, orphan list markers (a line that is only \`- \` or \`1. \`), or a stray closing bracket on its own line are rejected with \`invalid_replacement_content\` and you must re-emit. For \`replace_text\`, find→replace must preserve marker parity (don't drop one half of a \`**...**\` pair when the other half lives outside your patch).
9. Preserve fenced code blocks (triple-backtick blocks) verbatim unless the user explicitly asked to modify them.
10. Tables must stay valid GFM: every row on its own line, a \`| --- | --- |\` separator directly under the header, the same column count in every row, and a blank line before the header and after the last row. Never merge rows onto one line and never let a table start on the same line as prose — either way it renders as literal pipe text instead of a table. A patch that lands next to a table must keep that blank-line boundary intact.

## Error Recovery

If the tool returns an error (anchor not found, ambiguous, etc.), you will receive a ToolMessage listing the failing patches and the valid anchors in the document. Read the error carefully, then retry with corrected anchors. Common mistakes:
- Using only the heading text without the parent path when the heading is ambiguous (e.g., \`### Overview\` when multiple sections have an Overview subsection).
- Typos in the heading text. Copy anchors verbatim from the list.
- Writing \`content\` that includes the heading when \`keepHeading\` is true.

## Two-Channel Response Pattern

Your response has TWO separate channels:

### Channel 1: Tool Call → Editor
- ALL document changes MUST go through \`apply_document_patches\`.
- The server applies the patches and the editor shows the resulting diff.

### Channel 2: Message Content → Chat Sidebar
- Your message text appears in the chat sidebar.
- Keep it brief (1–2 sentences). Summarize what you changed and optionally ask a follow-up question.

**Example of CORRECT response:**
\`\`\`
Tool Call: apply_document_patches(patches=[
  { op: "replace_section", anchor: "## Overview", content: "..." },
  { op: "append_to_section", anchor: "## Requirements > ### Must Have", content: "- New requirement" },
])
Message: "I refreshed the Overview and added a new must-have requirement. Want me to expand the Scope next?"
\`\`\`

## CRITICAL: After Confirmation
When the user CONFIRMS or REJECTS changes (you see a \`confirm_changes\` tool response in the message history), DO NOT call any tools. Simply reply with a brief text acknowledgment.

## 🚨 Content Purity

The \`content\` field of each patch MUST contain ONLY actual document markdown. NEVER include:
- Tool definitions or function signatures
- "Namespace: functions" or "Tool definitions" text
- System/API metadata like "Target channel: commentary"
- Instructions about how to use tools
- Any text that describes tool parameters or schemas
`;
}

/**
 * Get summary-only instructions (after confirmation)
 */
export function getSummaryInstructions(accepted: boolean): string {
	if (accepted) {
		return `The user accepted your document changes.
Provide a brief 1-2 sentence summary of what you wrote or changed.
Do NOT call any tools - just respond with text.
Do NOT repeat the document content.`;
	}
	return `The user rejected your document changes.
Acknowledge this briefly in 1 sentence.
Do NOT call any tools - just respond with text.`;
}
