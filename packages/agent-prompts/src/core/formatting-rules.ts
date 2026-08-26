/**
 * Centralized Markdown Formatting Rules
 *
 * Single source of truth for all markdown formatting requirements.
 * Used by prompt builders and document validators.
 */

/**
 * Core markdown formatting rules
 */
export const MARKDOWN_FORMATTING_RULES = {
	/**
	 * Rules as human-readable instructions
	 */
	rules: [
		"Every section heading MUST have a blank line before AND after it",
		"Every list item MUST be on its own line starting with '- ' or '1. '",
		"Every paragraph MUST be separated by blank lines",
		"Tables MUST use GitHub Flavored Markdown (GFM) syntax with | and --- separators",
		"Tables MUST NOT use ASCII box-drawing characters like +, ±, or horizontal lines made of dashes",
		"Normal prose MUST NOT be wrapped in ```markdown, ```plaintext, or ```text fences",
		"Code blocks MUST use triple backticks with language tags when applicable",
		"JSON examples MUST use ```json fenced blocks and MUST close before normal prose resumes",
		"Never output bare labels like 'json { ... }' or 'plaintext GET /path ...' on one line",
		"Links MUST use proper markdown syntax: [text](url)",
		"Headings MUST follow proper hierarchy: ## for main sections, ### for subsections",
		"List markers MUST be consistent within a list (- for unordered, 1. for ordered)",
		"Code blocks MUST be properly closed with matching backticks",
		"Endpoint lists MUST be plain bullet items like '- GET /api/users' and MUST NOT use inline-code backticks unless showing literal source code",
		"Emphasis (bold/italic) MUST NOT conflict with diff highlighting (avoid *text* and ~~text~~)",
	],

	/**
	 * Correct formatting example
	 */
	correctExample: `## Executive Summary

This document describes the product requirements for the system.

## Features

### User Management

- User registration with email verification
- Password reset functionality
- Role-based access control (RBAC)

### Data Management

| Feature | Priority | Status |
|---------|----------|--------|
| Import CSV | High | Planned |
| Export PDF | Medium | Planned |

## Technical Requirements

The system will be built using:

1. React for the frontend
2. Node.js for the backend
3. PostgreSQL for the database

### Code Example

\`\`\`typescript
function example() {
  return "Hello, World!";
}
\`\`\``,

	/**
	 * Incorrect formatting example (what NOT to do)
	 */
	incorrectExample:
		"Executive SummaryThis document describes...FeaturesUser Management- User registration...Data Management| Feature | Priority |Import CSV | High |Export PDF | Medium |Technical RequirementsThe system will be built using:1. React for the frontend2. Node.js for the backend3. PostgreSQL for the database",

	/**
	 * Incorrect table format examples (NEVER use these)
	 */
	incorrectTableExamples: [
		// ASCII box-drawing table - WRONG
		`+----------+----------+--------+
| Feature  | Priority | Status |
+----------+----------+--------+
| Import   | High     | Done   |
+----------+----------+--------+`,
		// Table without separator row - WRONG
		`| Feature | Priority | Status |
| Import | High | Done |`,
	],

	/**
	 * Correct table format example
	 */
	correctTableExample: `| Feature | Priority | Status |
|---------|----------|--------|
| Import CSV | High | Planned |
| Export PDF | Medium | Planned |`,

	/**
	 * Validation regex patterns
	 */
	validationPatterns: {
		// Detect headings without blank lines before them (except at start of document)
		headingWithoutBlankLineBefore: /[^\n]\n##/g,
		// Detect headings without blank lines after them
		headingWithoutBlankLineAfter: /##[^\n]+\n[^\n\s]/g,
		// Detect malformed tables (missing separator row or inconsistent columns)
		malformedTable: /\|[^\n]+\n(?!\|[-\s|]+\n)/g,
		// Detect unclosed code blocks
		unclosedCodeBlock: /```[^`]*$/gm,
		// Detect inconsistent list markers (mixing - and 1. in same list)
		inconsistentListMarkers: /^[\s]*[-*][^\n]+\n[\s]*\d+\./gm,
		// Detect paragraphs without blank lines between them
		paragraphsWithoutBlankLines: /[^\n]\n[^\n#\s-*|`]/g,
	},

	/**
	 * Section-specific formatting rules
	 */
	sectionRules: {
		headings: [
			"Use ## for main sections (h2)",
			"Use ### for subsections (h3)",
			"Use #### for sub-subsections (h4) if needed",
			"Always add blank line before and after headings",
		],
		lists: [
			"Use '-' for unordered lists",
			"Use '1. ' for ordered lists",
			"Be consistent within each list",
			"Indent nested lists with 2 spaces",
			"Every list item starts on its own line with its own marker. Do not inline numbered steps as continuation of a bullet (e.g. '- Steps: 1. foo 2. bar' is wrong — write each step on its own line indented 2 spaces).",
		],
		tables: [
			"Use GitHub Flavored Markdown (GFM) table syntax ONLY",
			"First row contains headers with | separators",
			"Second row MUST contain separator: |---|---|",
			"All rows must have same number of columns",
			"NEVER use ASCII box-drawing characters (+, ±, or horizontal dashes between rows)",
			"NEVER use +---+---+ style borders",
		],
		codeBlocks: [
			"Use triple backticks (```)",
			"Specify language tag when applicable",
			"Close with matching triple backticks",
			"Indent code within blocks appropriately",
			"Use code fences ONLY for actual code, JSON payloads, shell commands, or Mermaid diagrams",
			"NEVER leave a fenced block open when returning to headings, lists, or paragraphs",
			"NEVER wrap an entire section or document in a code fence",
		],
		links: [
			"Use format: [link text](url)",
			"Use relative paths for internal links",
			"Use absolute URLs for external links",
		],
	},
};

/**
 * Get formatted markdown formatting rules as a string for prompts
 */
export function getMarkdownFormattingRulesPrompt(): string {
	return `## ⚠️ CRITICAL: Markdown Formatting Rules (MUST FOLLOW)

You MUST format your output as proper Markdown. This is ABSOLUTELY REQUIRED - failure to follow these rules makes the document unusable.

### ⚠️ TABLES ARE CRITICAL - READ THIS FIRST:

When creating tables, you MUST use GitHub Flavored Markdown (GFM) table syntax with pipe characters (|).

**CORRECT TABLE FORMAT (ALWAYS USE THIS):**
\`\`\`markdown
| Feature | Description | Priority |
|---------|-------------|----------|
| Login | User authentication | High |
| Dashboard | Project overview | Medium |
\`\`\`

**WRONG - NEVER DO THIS (concatenated text without pipes):**
\`\`\`
FeatureDescriptionPriorityLoginUser authenticationHighDashboardProject overviewMedium
\`\`\`

**WRONG - NEVER DO THIS (no separator row):**
\`\`\`
| Feature | Description | Priority |
| Login | User authentication | High |
\`\`\`

If you output table data without | separators and |---| separator rows, the document WILL BE BROKEN.

### ⚠️ OUTPUT CONTRACT FOR DOCUMENTS:

These rules apply to every document you generate:

1. Write the document itself as plain markdown, not inside \`\`\`markdown fences
2. Use headings, paragraphs, bullet lists, and tables directly
3. Use fenced blocks only for actual examples such as JSON, code, shell commands, or Mermaid
4. Every fenced block MUST be closed before the next heading, paragraph, or list starts
5. For API docs, endpoint summaries MUST be plain bullets like:
   - GET /api/users
   - POST /api/auth/login
6. Do NOT wrap endpoint bullets in backticks unless you are showing literal source code
7. Do NOT emit one-line pseudo-blocks like:
   - json { "id": "123" }
   - plaintext GET /api/users POST /api/auth/login

### CORRECT API Example:
\`\`\`markdown
## Authentication

### Obtain Access Token

To authenticate, send a request to the login endpoint.

\`\`\`json
{ "email": "user@example.com", "password": "password123" }
\`\`\`

Response:

\`\`\`json
{ "accessToken": "token", "refreshToken": "token", "expiresIn": 3600 }
\`\`\`

## API Endpoints

### User Management

- GET /api/users
- POST /api/auth/login
- PUT /api/user/:id
- DELETE /api/user/:id
\`\`\`

### WRONG API Example (NEVER DO THIS):
\`\`\`
\`\`\`json
{ "accessToken": "token" }
Include the access token in the Authorization header for other requests:
## API Endpoints
\`\`\`
\`\`\`

The WRONG example leaves normal prose and headings trapped inside a code fence. NEVER do this.

### General Rules:
${MARKDOWN_FORMATTING_RULES.rules.map((rule, i) => `${i + 1}. ${rule}`).join("\n")}

### CORRECT Document Example:
\`\`\`markdown
${MARKDOWN_FORMATTING_RULES.correctExample}
\`\`\`

### WRONG Example (NEVER do this):
\`\`\`
${MARKDOWN_FORMATTING_RULES.incorrectExample}
\`\`\`

The WRONG example runs everything together without proper spacing. NEVER do this.

### Section-Specific Rules:

#### Headings:
${MARKDOWN_FORMATTING_RULES.sectionRules.headings.map((r) => `- ${r}`).join("\n")}

#### Lists:
${MARKDOWN_FORMATTING_RULES.sectionRules.lists.map((r) => `- ${r}`).join("\n")}

#### Tables (CRITICAL - MUST USE PIPE SYNTAX):
${MARKDOWN_FORMATTING_RULES.sectionRules.tables.map((r) => `- ${r}`).join("\n")}
- EVERY table row MUST start and end with | character
- EVERY table cell MUST be separated by | character
- The second row MUST be a separator like |---|---|---|

**CORRECT table format (ALWAYS use this pattern):**
\`\`\`markdown
${MARKDOWN_FORMATTING_RULES.correctTableExample}
\`\`\`

**WRONG table formats (NEVER use these):**
\`\`\`
${MARKDOWN_FORMATTING_RULES.incorrectTableExamples[0]}
\`\`\`
ASCII box-drawing tables with + and - borders are NOT valid markdown!

\`\`\`
FeatureDescriptionPriority (concatenated without separators - WRONG!)
\`\`\`
Tables without | pipe separators will render as broken text!

#### Code Blocks:
${MARKDOWN_FORMATTING_RULES.sectionRules.codeBlocks.map((r) => `- ${r}`).join("\n")}

#### Links:
${MARKDOWN_FORMATTING_RULES.sectionRules.links.map((r) => `- ${r}`).join("\n")}`;
}
