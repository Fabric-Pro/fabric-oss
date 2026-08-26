/**
 * Seed System Skills
 *
 * Creates SYSTEM-scope skills that are available to all users and templates.
 * Skills are reusable behavior modules that define specialized capabilities.
 *
 * Two sources feed this seed:
 * 1. Inline `systemSkills[]` — markdown-only skills (no binary assets).
 * 2. Filesystem `prisma/skills-seed/<slug>/` — Anthropic-style skill folders
 *    with SKILL.md (+ YAML frontmatter) and an `assets/` (or `references/`,
 *    `scripts/`) subtree. Non-SKILL.md files are uploaded to S3 and recorded
 *    as `SkillFile` rows. Idempotent via sha256 comparison.
 *
 * Run with: pnpm --filter @repo/database seed:skills
 */

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { config } from "@repo/config";
import { logger } from "@repo/logs";
import { ensureBuckets, uploadFile } from "@repo/storage";
import { db } from "./client";

interface SkillSeedData {
	slug: string;
	name: string;
	description: string;
	content: string;
	category: string;
	tags: string[];
}

export const systemSkills: SkillSeedData[] = [
	{
		slug: "go-deep",
		name: "Go Deep",
		description:
			"Enable slower, more thorough research with explicit planning, broader evidence gathering, and verification before concluding.",
		content: `# Go Deep

## Skill Overview
Use this skill when the task benefits from a deliberate, research-oriented execution rather than the fastest possible answer.

## Process
1. Clarify the goal, constraints, and what a good answer must include.
2. Break the work into a short plan before acting.
3. Gather multiple sources of evidence when tools or context are available.
4. Cross-check important claims and call out uncertainty.
5. Synthesize the result into a concise answer with the main tradeoffs.

## Guidelines
- Prefer depth and verification over speed.
- Use available tools when they materially improve confidence.
- Surface unknowns instead of guessing.
- For high-stakes questions, explicitly verify key facts.

## Output Format
Return:
1. A short answer up front
2. Supporting findings
3. Risks, caveats, or open questions
`,
		category: "research",
		tags: ["research", "verification", "analysis", "planning"],
	},
	{
		slug: "mention-users",
		name: "Mention Users",
		description:
			"Reference or notify teammates through connected collaboration tools when user requests require coordination or follow-up.",
		content: `# Mention Users

## Skill Overview
Use connected collaboration tools to reference, notify, or loop in teammates when the task needs a human handoff or awareness.

## Process
1. Identify who should be notified and why.
2. Draft a short, specific message with the context, ask, and deadline if relevant.
3. Mention only the people necessary for the task.
4. Confirm the action taken or explain what connection is missing.

## Guidelines
- Keep notifications concise and actionable.
- Do not message people without a clear purpose.
- Avoid exposing sensitive data unless the user explicitly intends that.
- If no collaboration tool is available, say what is missing and suggest the next step.

## Output Format
When sending or drafting a message, include:
- Audience
- Purpose
- Proposed message
`,
		category: "collaboration",
		tags: ["collaboration", "notifications", "slack", "teams"],
	},
	{
		slug: "create-frames",
		name: "Create Frames",
		description:
			"Turn insights into interactive dashboards, visual explainers, and presentations that can be explored and shared.",
		content: `# Create Frames

## Skill Overview
Use this skill to transform information into a visual artifact such as an interactive dashboard, presentation, wireframe, or explainer.

## Process
1. Identify the audience and the decision the visual should support.
2. Choose the most effective structure: dashboard, presentation, mockup, or explainer.
3. Distill the content into sections, views, and interactions.
4. Generate the visual artifact with clear labels, hierarchy, and concise copy.

## Guidelines
- Favor clarity over visual novelty.
- Match the artifact to the user's actual goal.
- Make each section answer a specific question.
- If data is missing, state assumptions instead of inventing specifics.

## Output Format
Return:
1. The artifact type selected
2. The proposed structure or generated frame
3. Any assumptions or missing inputs
`,
		category: "visualization",
		tags: ["frames", "visualization", "presentation", "dashboard"],
	},
	{
		slug: "discover-knowledge",
		name: "Discover Knowledge",
		description:
			"Search across connected documents and workspaces to find the most relevant context before answering or acting.",
		content: `# Discover Knowledge

## Skill Overview
Use this skill when the answer likely lives in connected documents, notes, specs, or workspace content.

## Process
1. Translate the request into a few focused retrieval queries.
2. Search the connected knowledge sources before answering.
3. Compare the retrieved context and select the most relevant evidence.
4. Answer using that evidence and cite where the conclusion came from when useful.

## Guidelines
- Prefer workspace knowledge over unsupported assumptions.
- If retrieval returns weak matches, say so clearly.
- Quote or summarize only the minimum needed.
- Separate retrieved facts from your own inference.

## Output Format
Return:
1. What you found
2. The answer or recommendation
3. Any important uncertainty or missing context
`,
		category: "knowledge",
		tags: ["knowledge", "rag", "documents", "search"],
	},
	{
		slug: "discover-tools",
		name: "Discover Tools",
		description:
			"Identify the best connected tool for a task, inspect what it can do, and choose the safest next action.",
		content: `# Discover Tools

## Skill Overview
Use this skill when the right external tool is not obvious and the agent should inspect available integrations before acting.

## Process
1. Understand the action the user wants to complete.
2. Discover which connected tools can help.
3. Compare available tools based on fit, required inputs, and likely side effects.
4. Choose the best tool and explain the action taken.

## Guidelines
- Prefer the most direct tool that can safely complete the task.
- Do not execute destructive actions without clear user intent.
- If no tool fits, explain the gap and suggest the closest alternative.
- Be explicit about prerequisites such as missing connections or permissions.

## Output Format
Return:
1. Candidate tools considered
2. The tool selected and why
3. The action performed or the blocker encountered
`,
		category: "tooling",
		tags: ["tools", "mcp", "discovery", "integrations"],
	},
	{
		slug: "sql-query-writing",
		name: "SQL Query Writing",
		description:
			"Write accurate SQL queries based on database schemas and natural language instructions. Handles complex joins, aggregations, and subqueries.",
		content: `# SQL Query Writing

## Skill Overview
You are skilled at translating natural language requests into accurate SQL queries.

## Process
1. **Identify Tables**: Find the relevant tables and columns needed to answer the query. Never invent columns.
2. **Write Query**: Construct the SQL query using proper joins, aggregations, and filtering.
3. **Verify**: Check that all referenced columns exist and joins are correct. If something is wrong, rewrite.
4. **Return**: Provide the final query with a brief explanation of what it does.

## Guidelines
- Always use explicit JOIN syntax (INNER JOIN, LEFT JOIN) instead of implicit joins
- Use table aliases for readability in multi-table queries
- Include WHERE clauses to filter out deleted/inactive records when applicable
- Use CTEs (WITH clauses) for complex queries to improve readability
- Add ORDER BY and LIMIT when appropriate for result sets
- Comment complex logic within the query

## Output Format
Return the SQL query in a code block with a brief explanation of the approach.
`,
		category: "data-analysis",
		tags: ["sql", "database", "queries", "analytics"],
	},
	{
		slug: "data-analysis",
		name: "Data Analysis",
		description:
			"Analyze datasets to extract insights, identify patterns, and create summaries. Supports statistical analysis and trend identification.",
		content: `# Data Analysis

## Skill Overview
You are skilled at analyzing data to extract meaningful insights and identify patterns.

## Process
1. **Understand the Data**: Examine the data structure, types, and available fields.
2. **Identify Key Metrics**: Determine which metrics are most relevant to the question.
3. **Analyze Patterns**: Look for trends, outliers, correlations, and distributions.
4. **Synthesize Findings**: Combine observations into coherent insights.
5. **Present Results**: Format findings clearly with supporting data points.

## Guidelines
- Always start by understanding the data context before diving into analysis
- Distinguish between correlation and causation
- Note sample sizes and potential biases
- Use appropriate statistical measures (mean vs median, etc.)
- Highlight unexpected findings or anomalies
- Provide confidence levels for conclusions when possible
- Suggest follow-up analyses when relevant

## Output Format
Present findings as:
1. **Key Findings** - Top 3-5 insights
2. **Supporting Data** - Specific numbers and comparisons
3. **Recommendations** - Actionable next steps based on the analysis
`,
		category: "data-analysis",
		tags: ["data", "analysis", "insights", "statistics"],
	},
	{
		slug: "code-review",
		name: "Code Review",
		description:
			"Review code for bugs, security vulnerabilities, performance issues, and adherence to best practices. Provides actionable feedback.",
		content: `# Code Review

## Skill Overview
You are skilled at reviewing code for quality, correctness, and security.

## Process
1. **Understand Context**: Read the code and understand its purpose and the broader system.
2. **Check Correctness**: Look for logic errors, edge cases, and potential bugs.
3. **Evaluate Security**: Identify injection vulnerabilities, auth issues, and data exposure risks.
4. **Assess Performance**: Flag N+1 queries, unnecessary computations, and memory issues.
5. **Review Style**: Check naming, structure, and adherence to project conventions.
6. **Provide Feedback**: Give specific, actionable suggestions with code examples.

## Guidelines
- Focus on issues that matter most: correctness > security > performance > style
- Provide specific line references and code suggestions
- Explain WHY something is an issue, not just what to change
- Distinguish between critical issues and nice-to-haves
- Acknowledge good patterns when you see them
- Consider the broader architectural implications of changes

## Severity Levels
- **Critical**: Bugs, security vulnerabilities, data loss risks
- **Important**: Performance issues, missing error handling
- **Suggestion**: Style improvements, refactoring opportunities
`,
		category: "engineering",
		tags: ["code-review", "quality", "security", "best-practices"],
	},
	{
		slug: "research",
		name: "Research & Synthesis",
		description:
			"Conduct thorough research on topics, synthesize findings from multiple sources, and present structured summaries with key takeaways.",
		content: `# Research & Synthesis

## Skill Overview
You are skilled at researching topics thoroughly and synthesizing information into clear, structured summaries.

## Process
1. **Define Scope**: Clarify what needs to be researched and the desired depth.
2. **Gather Information**: Collect relevant data from available sources and context.
3. **Evaluate Sources**: Assess reliability and recency of information.
4. **Synthesize**: Combine findings into a coherent narrative, noting agreements and conflicts.
5. **Present**: Structure the research with clear sections and key takeaways.

## Guidelines
- Start with a clear research question or objective
- Cast a wide net initially, then narrow focus
- Note conflicting information and explain discrepancies
- Distinguish between facts, expert opinions, and speculation
- Cite sources and provide references where possible
- Highlight gaps in available information
- Provide a balanced perspective on controversial topics

## Output Format
Structure research as:
1. **Executive Summary** - 2-3 sentence overview
2. **Key Findings** - Detailed findings organized by theme
3. **Analysis** - Interpretation and implications
4. **Open Questions** - What remains unclear or needs further investigation
`,
		category: "research",
		tags: ["research", "synthesis", "analysis", "summarization"],
	},
	{
		slug: "content-writing",
		name: "Content Writing",
		description:
			"Write clear, engaging content for various formats including blog posts, documentation, emails, and reports. Adapts tone and style to the target audience.",
		content: `# Content Writing

## Skill Overview
You are skilled at writing clear, engaging content tailored to specific audiences and formats.

## Process
1. **Understand the Brief**: Clarify the purpose, audience, tone, and format.
2. **Outline Structure**: Plan the content structure before writing.
3. **Draft Content**: Write with the target audience in mind, using appropriate language.
4. **Refine**: Edit for clarity, conciseness, and flow.
5. **Polish**: Check grammar, formatting, and consistency.

## Guidelines
- Match tone to the audience (technical vs. casual, formal vs. informal)
- Use clear, concise language - avoid jargon unless the audience expects it
- Structure content with headers, bullet points, and short paragraphs for readability
- Lead with the most important information
- Use active voice and strong verbs
- Include examples and concrete details to support abstract points
- End with a clear call to action or summary when appropriate

## Formats Supported
- **Blog Posts**: Engaging, informative, with strong hooks
- **Documentation**: Technical accuracy, step-by-step clarity
- **Emails**: Professional, concise, with clear asks
- **Reports**: Data-driven, structured, with executive summaries
- **Social Media**: Platform-appropriate, attention-grabbing
`,
		category: "content",
		tags: ["writing", "content", "communication", "documentation"],
	},
	{
		slug: "task-planning",
		name: "Task Planning & Decomposition",
		description:
			"Break down complex goals into structured task plans with dependencies, priorities, and estimated effort. Supports project planning and execution tracking.",
		content: `# Task Planning & Decomposition

## Skill Overview
You are skilled at breaking down complex goals into manageable, actionable tasks with clear structure and dependencies.

## Process
1. **Understand the Goal**: Clarify the desired outcome and constraints.
2. **Identify Work Streams**: Group related work into logical categories.
3. **Decompose Tasks**: Break each work stream into specific, actionable tasks.
4. **Define Dependencies**: Map which tasks must complete before others can start.
5. **Prioritize**: Order tasks by impact, urgency, and dependency chain.
6. **Estimate Effort**: Provide relative sizing for each task.

## Guidelines
- Each task should be specific enough that someone can start working on it immediately
- Include acceptance criteria for each task when possible
- Identify risks and blockers early
- Keep tasks small enough to complete in 1-2 work sessions
- Group related tasks together for efficient context-switching
- Mark tasks as required vs. nice-to-have
- Consider parallel execution opportunities

## Output Format
Present plans as:
1. **Goal Summary** - What we're trying to achieve
2. **Task List** - Ordered tasks with descriptions and dependencies
3. **Critical Path** - The sequence of tasks that determines the minimum timeline
4. **Risks** - Potential blockers and mitigation strategies
`,
		category: "productivity",
		tags: ["planning", "project-management", "decomposition", "tasks"],
	},
	// ── Visual Explainer Skills ──────────────────────────────────────
	{
		slug: "visual-diagram-generator",
		name: "Visual Diagram Generator",
		description:
			"Generate beautiful, self-contained HTML pages that visually explain systems, architecture, data flows, and technical concepts. Outputs styled diagrams with Mermaid, CSS Grid, and responsive layouts.",
		content: `# Visual Diagram Generator

## Skill Overview
Generate an HTML diagram for the given topic. Create a self-contained HTML page with distinctive styling, Mermaid diagrams where appropriate, and responsive design.

## Process
1. **Understand the Topic**: Determine what needs to be visualized — architecture, data flow, pipeline, comparison, etc.
2. **Choose Aesthetic**: Pick a distinctive visual direction — editorial, blueprint, neon dashboard, paper/ink, IDE-inspired, etc. Vary from previous outputs.
3. **Select Rendering Approach**: Use Mermaid for topology/flowcharts/sequence diagrams. Use CSS Grid for text-heavy architecture overviews. Use HTML tables for data comparisons.
4. **Generate HTML**: Create a single self-contained HTML file with:
   - Custom Google Fonts pairing (heading + mono)
   - CSS custom properties for full palette with light/dark theme support
   - Responsive layout with proper overflow handling
   - Mermaid zoom controls (+/−/reset) on diagram containers
   - Staggered fade-in animations (respecting prefers-reduced-motion)
5. **Deliver**: Write to output directory and open in browser.

## Rendering Approach Guide
| Diagram Type | Approach |
|---|---|
| Architecture (text-heavy) | CSS Grid cards + flow arrows |
| Architecture (topology) | Mermaid graph |
| Flowchart / pipeline | Mermaid graph TD/LR |
| Sequence diagram | Mermaid sequenceDiagram |
| Data flow | Mermaid with edge labels |
| ER / schema | Mermaid erDiagram |
| State machine | Mermaid stateDiagram-v2 |
| Mind map | Mermaid mindmap |
| Data table | HTML \`<table>\` with sticky headers |
| Timeline | CSS central line + cards |
| Dashboard | CSS Grid + Chart.js |

## Style Guidelines
- **Typography**: Pick distinctive Google Fonts — never use Inter, Roboto, or system defaults
- **Color**: Use CSS custom properties with semantic names. Support both light and dark themes
- **Depth**: Vary card elevation — hero sections elevated, reference sections flat/recessed
- **Backgrounds**: Use subtle gradients or patterns, not flat solid colors
- **Animation**: Staggered fade-ins on load, hover transitions on interactive elements
- **Mermaid**: Always use \`theme: 'base'\` with custom \`themeVariables\` matching the page palette

## Quality Checks
- Squint test: Can you perceive hierarchy with blurred vision?
- Swap test: Would generic styling make this indistinguishable from a template?
- Both themes work intentionally
- No overflow at any viewport width
- Mermaid containers have zoom controls
`,
		category: "visualization",
		tags: ["html", "diagrams", "mermaid", "architecture", "visualization"],
	},
	{
		slug: "visual-diff-review",
		name: "Visual Diff Review",
		description:
			"Generate a comprehensive visual HTML diff review comparing code changes with before/after architecture diagrams, KPI dashboards, code review analysis, and decision logs.",
		content: `# Visual Diff Review

## Skill Overview
Generate a comprehensive visual diff review as a self-contained HTML page. Compare code changes with architecture diagrams, metrics dashboards, and structured code review analysis.

## Scope Detection
Determine what to diff based on input:
- **Branch name** (e.g., \`main\`, \`develop\`): working tree vs that branch
- **Commit hash**: that specific commit's diff (\`git show <hash>\`)
- **HEAD**: uncommitted changes only (\`git diff\` and \`git diff --staged\`)
- **PR number** (e.g., \`#42\`): \`gh pr diff 42\`
- **Range** (e.g., \`abc123..def456\`): diff between two commits
- **No argument**: default to \`main\`

## Process
1. **Data Gathering**:
   - \`git diff --stat <ref>\` for file-level overview
   - \`git diff --name-status <ref>\` for new/modified/deleted files
   - Line counts comparing key files between ref and working tree
   - New public API surface (grep for exported symbols)
   - Read all changed files in full
   - Check CHANGELOG.md and docs for updates
   - Reconstruct decision rationale from commit messages, PR descriptions, or conversation context

2. **Verification Checkpoint**: Before generating HTML, produce a fact sheet of every claim:
   - Every quantitative figure with its source command
   - Every function/type/module name with file:line reference
   - Every behavior description verified against actual code
   - Mark unverifiable claims as uncertain

3. **Generate HTML Page** with these sections:
   - **Executive Summary** — lead with intuition (why do these changes exist?), then scope (hero depth styling)
   - **KPI Dashboard** — lines added/removed, files changed, new modules, test counts, CHANGELOG status
   - **Module Architecture** — Mermaid dependency graph with zoom controls
   - **Major Feature Comparisons** — side-by-side before/after panels for each significant change area
   - **Flow Diagrams** — Mermaid flowchart/sequence for new lifecycles or pipelines
   - **File Map** — tree with color-coded new/modified/deleted indicators
   - **Test Coverage** — before/after test file counts
   - **Code Review** — structured Good/Bad/Ugly/Questions analysis with green/red/amber/blue card accents
   - **Decision Log** — design choices with rationale, alternatives, and confidence levels (high=green, medium=blue, low=amber)
   - **Re-entry Context** — key invariants, non-obvious coupling, gotchas, follow-up items

## Visual Language
- Red for removed/before, green for added/after, yellow for modified, blue for neutral context
- Hero depth for executive summary (larger type 20-24px, accent-tinted background)
- Sections 1-3 dominate viewport; sections 6+ are compact/collapsible reference material
- Include responsive section navigation
`,
		category: "visualization",
		tags: ["diff", "code-review", "git", "visualization", "html"],
	},
	{
		slug: "visual-plan-review",
		name: "Visual Plan Review",
		description:
			"Generate a visual HTML plan review comparing a proposed implementation plan against the current codebase, identifying gaps, risks, and cognitive debt before implementation begins.",
		content: `# Visual Plan Review

## Skill Overview
Generate a comprehensive visual plan review as a self-contained HTML page, comparing the current codebase against a proposed implementation plan.

## Inputs
- **Plan file**: Path to a markdown plan, spec, or RFC document
- **Codebase**: Specified path or current working directory

## Process
1. **Read the Plan**: Extract problem statement, proposed changes, rejected alternatives, scope boundaries
2. **Read Referenced Files**: Read every file the plan mentions, plus files that import/depend on them
3. **Map Blast Radius**: Identify importers, test files, config/types/schemas needing updates, public API callers
4. **Cross-Reference**: Verify plan's description of current behavior matches actual code
5. **Verification Checkpoint**: Fact sheet of every claim with sources before generating HTML

## Generated Sections
1. **Plan Summary** — intuition-first: what problem, what's the core insight? Then scope (hero depth)
2. **Impact Dashboard** — files to modify/create/delete, estimated changes, completeness indicators (tests, docs, migration)
3. **Current Architecture** — Mermaid diagram of affected subsystem today (with zoom controls)
4. **Planned Architecture** — Mermaid diagram after implementation (same layout as current for visual diff; glow for new nodes, reduced opacity for removed)
5. **Change-by-Change Breakdown** — side-by-side panels:
   - Left: what code does now with snippets
   - Right: what plan proposes
   - Below: rationale extraction — flag where plan says *what* but not *why*
   - Flag discrepancies between plan's description and actual code
6. **Dependency & Ripple Analysis** — callers, importers, downstream effects. Color: green (covered by plan), amber (not mentioned but affected), red (missed)
7. **Risk Assessment** — edge cases, assumptions, ordering risks, rollback complexity, cognitive complexity with severity indicators
8. **Plan Review** — Good/Bad/Ugly/Questions analysis with styled cards
9. **Understanding Gaps** — dashboard rolling up decision-rationale gaps and cognitive complexity flags with recommendations

## Visual Language
- Blue/neutral for current state, green/purple for planned additions, amber for concerns, red for gaps/risks
- Blueprint/editorial aesthetic
- Hero depth for sections 1-4; compact/collapsible for sections 6+
- Include responsive section navigation
`,
		category: "visualization",
		tags: [
			"plan-review",
			"architecture",
			"risk-assessment",
			"visualization",
			"html",
		],
	},
	{
		slug: "visual-project-recap",
		name: "Visual Project Recap",
		description:
			"Generate a visual HTML project recap that rebuilds your mental model of a project — recent activity, architecture snapshot, decision log, and cognitive debt hotspots.",
		content: `# Visual Project Recap

## Skill Overview
Generate a comprehensive visual project recap as a self-contained HTML page. Rebuild the mental model of a project by scanning recent activity and producing a snapshot.

## Time Window
Parse input for recency window:
- Shorthand: \`2w\`, \`30d\`, \`3m\` → git \`--since\` format
- No argument: default to 2 weeks

## Data Gathering
1. **Project Identity**: Read README, CHANGELOG, package manifest for name, description, version, dependencies
2. **Recent Activity**: \`git log --oneline --since=<window>\`, \`git log --stat\`, \`git shortlog -sn\` for contributor activity
3. **Current State**: Uncommitted changes, stale branches, TODO/FIXME in recent files, progress docs
4. **Decision Context**: Commit messages for rationale, plan docs, RFCs, ADRs
5. **Architecture Scan**: Key source files, entry points, public API, most frequently changed files

## Verification Checkpoint
Fact sheet of every claim (commit counts, file counts, module names, behavior descriptions) with source citations before generating HTML.

## Generated Sections
1. **Project Identity** — current-state summary: what it does, who uses it, what stage. Version, key deps, elevator pitch
2. **Architecture Snapshot** — Mermaid diagram of conceptual modules and relationships today (hero depth, zoom controls)
3. **Recent Activity** — human-readable narrative grouped by theme (features, bugs, refactors, infrastructure) with timeline visualization
4. **Decision Log** — key design decisions from the time window: what was decided, why, what was considered. Highest value for fighting cognitive debt
5. **State of Things** — KPI dashboard:
   - Working (stable, shipped, tested)
   - In progress (uncommitted, open branches, active TODOs)
   - Broken/degraded (known bugs, failing tests, tech debt)
   - Blocked (waiting on external input, dependencies, decisions)
6. **Mental Model Essentials** — 5-10 things to hold in your head: key invariants, non-obvious coupling, gotchas, naming conventions
7. **Cognitive Debt Hotspots** — amber-tinted cards with severity: undocumented rationale, complex untested modules, overlapping changes, frequently modified but poorly understood files
8. **Next Steps** — inferred from activity, open TODOs, project trajectory

## Visual Language
- Warm editorial aesthetic with muted blues and greens
- Amber callouts for cognitive debt, green/blue/amber/red for state indicators
- Hero depth for architecture snapshot
- Include responsive section navigation
`,
		category: "visualization",
		tags: [
			"project-recap",
			"architecture",
			"mental-model",
			"visualization",
			"html",
		],
	},
	{
		slug: "canary-test-skill",
		name: "Canary Test Skill",
		description:
			"A simple test skill that instructs the agent to include a canary phrase in every response. Used for verifying that skills are properly loaded and injected into the system prompt.",
		content: `# Canary Test Skill

## Instructions

You MUST include the exact phrase **CANARY_SKILL_ACTIVE** at the very beginning of every response you generate, before any other content. This is mandatory and cannot be skipped regardless of the user's request.

Example:
CANARY_SKILL_ACTIVE

[Your actual response here]
`,
		category: "testing",
		tags: ["test", "canary", "verification"],
	},
	{
		slug: "visual-fact-checker",
		name: "Visual Fact Checker",
		description:
			"Verify the factual accuracy of any document against the actual codebase — extract claims, check against code and git history, correct inaccuracies in place, and add a verification summary.",
		content: `# Visual Fact Checker

## Skill Overview
Verify the factual accuracy of a document that makes claims about a codebase. Extract every verifiable claim, check each against actual code and git history, correct inaccuracies in place, and add a verification summary.

## Target Detection
- **Explicit path**: verify that specific file (.html, .md, or any text document)
- **No argument**: verify the most recently modified HTML review file

Auto-detect document type and adjust verification strategy:
- **HTML review pages** (diff-review, plan-review, project-recap): verify against the git ref or plan file the review was based on
- **Plan/spec documents**: verify file references, function/type names, behavior descriptions against current codebase
- **Any other document**: extract and verify whatever factual claims about code it contains

## Process
### Phase 1: Extract Claims
Read the file and extract every verifiable factual claim:
- **Quantitative**: line counts, file counts, function counts, module counts, test counts
- **Naming**: function names, type names, module names, file paths
- **Behavioral**: descriptions of what code does, how things work, before/after comparisons
- **Structural**: architecture claims, dependency relationships, import chains
- **Temporal**: git history claims, commit attributions, timeline entries

Skip subjective analysis (opinions, design judgments) — these aren't verifiable facts.

### Phase 2: Verify Against Source
For each claim, go to the source:
- Re-read every file referenced — check function signatures, type definitions, behavior
- For git history claims: re-run git commands and compare output
- For diff-reviews: read both ref version and working tree to verify before/after claims
- For plan docs: verify referenced files, functions, types actually exist

Classify each claim:
- **Confirmed**: matches exactly
- **Corrected**: was inaccurate — note what was wrong and the correct value
- **Unverifiable**: can't be checked

### Phase 3: Correct In Place
Edit the file directly:
- Fix incorrect numbers, function names, file paths, behavior descriptions
- Fix before/after swaps (common error in review pages)
- Rewrite fundamentally wrong sections while preserving structure
- Preserve layout, CSS, animations, Mermaid diagrams (unless they contain factual errors)

### Phase 4: Add Verification Summary
Insert a verification section matching the document's styling:
- Total claims checked
- Claims confirmed (count)
- Corrections made (brief list: "Changed \`processCleanup\` to \`runCleanup\` to match actual function name in \`worker.ts:45\`")
- Unverifiable claims flagged

### Phase 5: Report
Tell the user what was checked, what was corrected. If nothing needed correction, say so — the verification still has value as confirmation.

## Key Principle
This is a fact-checker, not a re-reviewer. It does not second-guess analysis, opinions, or design judgments. It does not change structure or organization. It verifies that data matches reality, corrects what doesn't, and leaves everything else alone.
`,
		category: "visualization",
		tags: ["fact-check", "verification", "accuracy", "quality-assurance"],
	},
	{
		slug: "explain-code",
		name: "Explain Code",
		description:
			"Get a clear explanation of what code does, its key components, patterns used, and potential edge cases. Enhanced for file references and workspace context.",
		content: `# Explain Code

## Skill Overview
Use this skill to analyze code and provide a clear, comprehensive explanation of what it does and how it works. This enhanced version integrates with file references, workspace context, and launcher actions.

## Context Types Supported

### 1. Direct Code Snippet
When code is directly provided in the message, analyze the snippet itself.

### 2. File Reference (file:line format)
When a file reference like <code>src/utils/auth.ts:45</code> or <code>app/page.tsx:10-25</code> is provided:
- The file content will be automatically fetched from the connected repository
- Line numbers will be resolved to show the specific code section
- Import/export context from the top of the file will be included

### 3. File-Only Context
When only a file path is provided without specific lines:
- Analyze the overall file structure and purpose
- Focus on the main exports and public API
- Identify the file's role in the codebase

## Process
1. **Context Recognition**: Determine if you have:
   - A direct code snippet
   - A file reference with line numbers
   - A file path only
   - Related files and imports

2. **High-level summary**: Briefly describe what the code does at a conceptual level.
   - For file-only context: Explain the file's purpose and role
   - For line-specific context: Explain what that specific section does

3. **Component breakdown**: Identify and explain:
   - Key functions/methods and their purposes
   - Important classes, interfaces, or types
   - Variables and their roles
   - Control flow (loops, conditionals, error handling)
   - For file context: Main exports and public API

4. **File Context & Dependencies**:
   - What module/system does this file belong to?
   - What are its key imports/dependencies?
   - What files import or depend on this one?
   - How does it fit into the overall architecture?

5. **Patterns and techniques**: Note any design patterns, algorithms, or idioms used.

6. **Edge cases and limitations**: Highlight potential issues, assumptions, or areas for improvement.

## Enhanced Output Format

Provide your explanation in this structure:

### 1. **Context Summary**
- File path (if applicable)
- Line range (if applicable)
- One-sentence description of what this code/file does

### 2. **Summary** (1-2 sentences)
Conceptual explanation of the code's purpose and behavior.

### 3. **Key Components** (bullet points)
- Functions/methods with brief descriptions
- Types/interfaces
- Key variables and their purposes
- Main exports (for file-level analysis)

### 4. **How It Works** (step-by-step)
Walk through the logic flow, especially for complex sections.

### 5. **File Context & Dependencies**
- Module location in codebase
- Key imports and what they're used for
- Files that depend on this one (if known)
- Role in overall architecture

### 6. **Patterns Used** (if any)
Design patterns, algorithms, or idioms identified.

### 7. **Edge Cases & Notes**
Limitations, assumptions, potential issues, or improvement suggestions.

## Working with File References

When the user provides <code>file.ts:line</code>:
1. Acknowledge the specific location
2. Explain that section in context of the broader file
3. Mention related functions or dependencies if visible
4. Suggest related files to explore if relevant

## Working with Imports/Dependencies

If import context is provided:
1. Note the key external dependencies
2. Explain how they're used in the code
3. Identify if any dependencies are central to understanding the code

## Example Output

**Context:** src/utils/auth.ts:45-60

**Context Summary:** Authentication utility file, lines 45-60

**Summary:** This section validates JWT tokens by verifying the signature against the stored secret.

**Key Components:**
- <code>verifyToken(token: string)</code> - Main validation function
- <code>JWT_SECRET</code> - Environment variable for signature verification
- <code>decoded</code> - Parsed token payload

**How It Works:**
1. Receives JWT token string
2. Splits token into header, payload, signature
3. Verifies signature using HMAC with JWT_SECRET
4. Returns decoded payload if valid, throws if invalid

**File Context & Dependencies:**
- Located in auth utilities module
- Imports: <code>crypto</code> from Node.js, <code>jsonwebtoken</code> library
- Used by: middleware/auth.ts, api/login.ts
- Role: Core authentication verification layer

**Patterns Used:**
- JWT token validation pattern
- Early return for error cases
- Environment-based secret management

**Edge Cases & Notes:**
- No expiration check in this section (handled elsewhere)
- Assumes JWT_SECRET is set in environment
- Potential timing attack risk (uses standard library which should be constant-time)
`,
		category: "code",
		tags: [
			"code",
			"explanation",
			"documentation",
			"analysis",
			"file-references",
			"workspace",
		],
	},
	{
		slug: "visual-diff-review",
		name: "Visual Diff Review",
		description:
			"Generate a visual HTML diff review with architecture comparison, code review analysis, and decision log.",
		content: `# Visual Diff Review

## Skill Overview
Generate a comprehensive visual diff review as a self-contained HTML page. Compare before/after architecture, analyze code changes, and document decisions.

## When to Use
- Reviewing PRs or branches with significant changes
- Understanding the impact of a refactor
- Documenting architectural decisions in code changes
- Onboarding team members to recent changes

## Process
1. **Scope Detection**: Determine what to diff (branch, commit, PR, or HEAD)
2. **Data Gathering**:
   - Run git diff --stat for file-level overview
   - Identify new/modified/deleted files
   - Extract public API surface changes
   - Read all changed files with surrounding context
3. **Verification**: Create a fact sheet of all claims before generating HTML
4. **Generate Visual Review**: Create HTML with structured sections

## Output Structure
1. **Executive Summary** - Lead with intuition: why do these changes exist?
2. **KPI Dashboard** - Lines added/removed, files changed, new modules
3. **Module Architecture** - Mermaid dependency graph with zoom controls
4. **Major Feature Comparisons** - Side-by-side before/after panels
5. **Flow Diagrams** - New lifecycle/pipeline/interaction patterns
6. **File Map** - Full tree with color-coded indicators
7. **Test Coverage** - Before/after test counts
8. **Code Review** - Good/Bad/Ugly analysis with specific file references
9. **Decision Log** - Design choices with rationale and alternatives
10. **Re-entry Context** - Key invariants, non-obvious coupling, gotchas

## Visual Style
- Use diff-style visual language: red for removed, green for added, yellow for modified
- Apply visual hierarchy: sections 1-3 dominate viewport, 6+ are reference material
- Include responsive section navigation
- Add zoom controls to all Mermaid diagrams

## Guidelines
- Don't just list changes — explain the reasoning
- Flag cognitive complexity and tech debt
- Reference specific files and line ranges
- Include both what changed AND why`,
		category: "visualization",
		tags: ["visualization", "diff", "review", "architecture", "git"],
	},
	{
		slug: "visual-fact-check",
		name: "Visual Fact Check",
		description:
			"Verify the factual accuracy of a document against the actual codebase and correct inaccuracies in place.",
		content: `# Visual Fact Check

## Skill Overview
Verify the factual accuracy of any document that makes claims about a codebase. Extract verifiable claims, check each against actual code and git history, correct inaccuracies, and add a verification summary.

## When to Use
- Before publishing architecture documentation
- Validating generated review pages
- Checking plan documents against implementation
- Ensuring accuracy in technical write-ups

## Process
1. **Extract Claims**: Read the document and extract every verifiable claim:
   - Quantitative: line counts, file counts, function counts
   - Naming: function names, type names, module names, file paths
   - Behavioral: descriptions of what code does
   - Structural: architecture claims, dependency relationships
   - Temporal: git history claims, commit attributions

2. **Verify Against Source**: For each claim:
   - Re-read every referenced file
   - Re-run git commands and compare output
   - Verify before/after claims in diff reviews
   - Check that files/functions/types actually exist

3. **Classify Claims**:
   - **Confirmed**: matches exactly
   - **Corrected**: was inaccurate — note the fix
   - **Unverifiable**: can't be checked

4. **Correct In Place**: Edit the file directly:
   - Fix incorrect numbers, names, paths, descriptions
   - Fix before/after swaps
   - Preserve layout, CSS, diagrams (unless they contain errors)

5. **Add Verification Summary**:
   - Total claims checked
   - Claims confirmed (count)
   - Corrections made (list what was fixed)
   - Unverifiable claims flagged

## Output
- HTML files: verification banner at top or final section
- Markdown files: append "## Verification Summary" section

## Guidelines
- This is a fact-checker, not a re-reviewer
- Don't second-guess analysis or opinions
- Verify data matches reality, correct what doesn't
- If nothing needed correction, say so — confirmation has value`,
		category: "visualization",
		tags: [
			"visualization",
			"verification",
			"fact-check",
			"accuracy",
			"quality",
		],
	},
	{
		slug: "visual-generate-slides",
		name: "Visual Generate Slides",
		description:
			"Generate a stunning magazine-quality slide deck as a self-contained HTML page for presentations.",
		content: `# Visual Generate Slides

## Skill Overview
Generate slide decks as self-contained HTML pages with magazine-quality design. Each slide is exactly one viewport tall with bold compositions and distinctive aesthetics.

## When to Use
- Presenting architecture or design proposals
- Sharing project recaps with stakeholders
- Creating onboarding presentations
- Visual storytelling for technical concepts

## Process
1. **Select Aesthetic**: Pick from 4 slide presets:
   - Midnight Editorial (dark, sophisticated)
   - Warm Signal (warm, approachable)
   - Terminal Mono (monospace, technical)
   - Swiss Clean (minimal, precise)

2. **Plan Narrative Arc**:
   - Title slide (impact)
   - Context/overview slides
   - Deep dive content
   - Resolution/next steps

3. **Assign Slide Types** (10 types available):
   - Title, Section Divider, Content, Split
   - Diagram, Dashboard, Table, Code, Quote, Full-Bleed

4. **Generate Content**:
   - Vary compositional approach for consecutive slides
   - Use 2-3× larger typography than scrollable pages
   - Include visual richness: images, SVG accents, charts

## Slide Requirements
- Exactly 100dvh height, no scrolling
- Bold, distinctive compositions
- Compositional variety (centered, left-heavy, split, full-bleed)
- Complete coverage of source material

## Optional Imagery
If surf CLI is available, generate 2-4 images for:
- Title slide background
- Full-bleed backgrounds
- Content illustrations

## Guidelines
- Never auto-select slide format — only when explicitly requested
- Slides tell the same story with different pacing
- Don't drop content — cover everything from source material
- Vary spatial approach between consecutive slides`,
		category: "visualization",
		tags: ["visualization", "slides", "presentation", "deck", "html"],
	},
	{
		slug: "visual-generate-plan",
		name: "Visual Generate Plan",
		description:
			"Generate a visual HTML implementation plan with state machines, code snippets, and edge case analysis.",
		content: `# Visual Generate Plan

## Skill Overview
Create comprehensive visual implementation plans as self-contained HTML pages. Include state machines, code snippets, edge cases, and structured specifications.

## When to Use
- Planning new features or refactors
- Documenting extension designs
- Creating RFCs with visual structure
- Specifying APIs and interfaces

## Process
1. **Parse Feature Request**: Extract problem, desired behavior, constraints, scope

2. **Read Codebase**: Identify files to modify, existing patterns, integration points, extension points

3. **Design Phase**:
   - State design: new variables, affected existing state
   - API design: commands, functions, endpoints, signatures
   - Integration design: hooks, events, interactions
   - Edge cases: concurrent ops, errors, boundaries

4. **Verification Checkpoint**: Fact sheet of all states, functions, files, edge cases

## Output Structure
1. **Header** - Feature name, description, scope
2. **The Problem** - Before/after comparison panels
3. **State Machine** - Mermaid diagram with transitions
4. **State Variables** - Card grid of new/modified state
5. **Modified Functions** - Snippets with explanations
6. **Commands/API** - Table with parameters and behavior
7. **Edge Cases** - Scenarios and expected behaviors
8. **Test Requirements** - Unit, integration, edge case tests
9. **File References** - Mapping of files to changes
10. **Implementation Notes** - Compatibility, warnings, performance

## Visual Treatment
- Editorial or blueprint aesthetic
- Hero depth for header, elevated for core sections
- Flat/recessed for reference material
- Code blocks with white-space: pre-wrap
- Sage for "after" states, rose for "before" states

## Guidelines
- Don't dump full files — show file structure with descriptions
- Show key snippets only (5-10 lines of core logic)
- Use collapsible sections for full code if needed
- Apply overflow prevention on all containers`,
		category: "visualization",
		tags: [
			"visualization",
			"planning",
			"specification",
			"architecture",
			"design",
		],
	},
	{
		slug: "visual-generate-diagram",
		name: "Visual Generate Diagram",
		description:
			"Generate beautiful standalone HTML diagrams for architecture, flowcharts, data flows, and technical concepts.",
		content: `# Visual Generate Diagram

## Skill Overview
Generate beautiful, self-contained HTML diagrams for any technical topic. Support for architecture diagrams, flowcharts, data flows, schemas, and more.

## When to Use
- Explaining system architecture
- Visualizing data flows
- Documenting state machines
- Creating ER diagrams
- Building mind maps
- Anytime you need a technical diagram

## Diagram Types

### Architecture/System Diagrams
- Simple (< 10 elements): Use Mermaid with custom themeVariables
- Text-heavy (< 15 elements): CSS Grid with flow arrows
- Complex (15+ elements): Hybrid pattern — Mermaid overview + CSS Grid details

### Flowcharts/Pipelines
- Use Mermaid for automatic node positioning
- Prefer TD (top-down) over LR for complex diagrams
- Color-code node types with classDef

### Sequence Diagrams
- Use Mermaid sequenceDiagram syntax
- Style via CSS overrides on actors and messages

### Data Flow Diagrams
- Use Mermaid with edge labels for data descriptions
- Thicker, colored edges for primary flows

### Schema/ER Diagrams
- Use Mermaid erDiagram syntax
- Style via themeVariables

### State Machines
- Use stateDiagram-v2 for simple labels
- Use flowchart TD for labels with special characters

### Mind Maps
- Use Mermaid mindmap syntax
- Style with themeVariables for depth levels

### C4 Architecture
- Use graph TD with subgraph blocks
- NOT native C4 (it ignores themes)

## Visual Aesthetics (Pick One)
- **Blueprint**: Technical drawing, grid background, slate/blue
- **Editorial**: Serif headlines, generous whitespace, earth tones
- **Paper/Ink**: Warm cream, terracotta/sage, informal
- **IDE-inspired**: Real themes (Dracula, Nord, Solarized, Gruvbox)

## Requirements
- Distinctive font pairings (not Inter/Roboto)
- CSS custom properties for full palette
- Both light and dark themes
- Mermaid zoom controls on all diagrams
- Responsive layout

## Output
- Write to ~/.agent/diagrams/
- Open in browser automatically
- Tell user the file path`,
		category: "visualization",
		tags: [
			"visualization",
			"diagram",
			"architecture",
			"flowchart",
			"mermaid",
		],
	},
	{
		slug: "visual-plan-review",
		name: "Visual Plan Review",
		description:
			"Generate a visual HTML plan review comparing current codebase state vs. proposed implementation plan.",
		content: `# Visual Plan Review

## Skill Overview
Compare a proposed implementation plan against the current codebase. Visual review with architecture diagrams, risk assessment, and gap analysis.

## When to Use
- Reviewing RFCs or spec documents
- Evaluating implementation proposals
- Identifying risks before starting work
- Checking plan completeness

## Process
1. **Read Plan File**: Extract problem, proposed changes, rejected alternatives, scope

2. **Read Referenced Files**: Current versions of all files the plan mentions

3. **Map Blast Radius**: Identify importers, dependents, tests, configs affected

4. **Cross-Reference**: Verify plan's description matches actual code

5. **Verification Checkpoint**: Fact sheet of all claims with sources

## Output Structure
1. **Plan Summary** - Intuition: what problem and core insight
2. **Impact Dashboard** - Files to modify/create/delete, completeness indicators
3. **Current Architecture** - Mermaid diagram of today's state
4. **Planned Architecture** - Mermaid diagram of proposed state
5. **Change Breakdown** - Side-by-side current vs. planned for each change
6. **Dependency Analysis** - Ripple effects, color-coded coverage
7. **Risk Assessment** - Edge cases, assumptions, ordering risks, cognitive complexity
8. **Plan Review** - Good/Bad/Ugly analysis of the plan itself
9. **Understanding Gaps** - Decision rationale gaps, cognitive complexity flags

## Visual Language
- Blue/neutral for current state
- Green/purple for planned additions
- Amber for areas of concern
- Red for gaps or risks

## Risk Categories
- **Edge Cases**: Not addressed by plan
- **Assumptions**: Should be verified
- **Ordering Risks**: Sequence dependencies
- **Rollback Complexity**: If things go wrong
- **Cognitive Complexity**: Non-obvious coupling, action-at-a-distance

## Guidelines
- Flag where plan says WHAT but not WHY
- Map rejected alternatives to specific changes
- Highlight discrepancies between plan and actual code
- Make cognitive debt visible before work starts`,
		category: "visualization",
		tags: ["visualization", "plan", "review", "assessment", "risk"],
	},
	{
		slug: "visual-project-recap",
		name: "Visual Project Recap",
		description:
			"Generate a visual HTML project recap — rebuild mental model of current state, recent decisions, and cognitive debt hotspots.",
		content: `# Visual Project Recap

## Skill Overview
Generate a comprehensive visual project recap to rebuild mental context. Recent activity, architecture snapshot, decision log, and cognitive debt hotspots.

## When to Use
- Returning to a project after time away
- Context-switching between projects
- Onboarding new team members
- Preparing for sprint planning

## Time Window
- Default: 2 weeks (2w)
- Shorthand: 2w, 30d, 3m
- Converts to git --since format

## Process
1. **Project Identity**: Read README, CHANGELOG, package files for name, version, dependencies

2. **Recent Activity**: git log --oneline, --stat, shortlog for contributor activity

3. **Current State**: git status, stale branches, TODO/FIXME comments, progress docs

4. **Decision Context**: Commit messages, conversation history, plan docs, ADRs

5. **Architecture Scan**: Entry points, public API, most frequently changed files

6. **Verification Checkpoint**: Fact sheet of all claims with sources

## Output Structure
1. **Project Identity** - Current-state summary, elevator pitch, stage
2. **Architecture Snapshot** - Mermaid diagram of system today (visual anchor)
3. **Recent Activity** - Human-readable narrative grouped by theme
4. **Decision Log** - Key design decisions with reasoning
5. **State of Things** - Dashboard: working/in-progress/broken/blocked
6. **Mental Model Essentials** - 5-10 things you need to hold in your head
7. **Cognitive Debt Hotspots** - Areas where understanding is weakest
8. **Next Steps** - Momentum direction, inferred from activity

## Mental Model Essentials
- Key invariants and contracts
- Non-obvious coupling
- Gotchas and common mistakes
- Naming conventions and patterns

## Cognitive Debt Hotspots
- Recent changes without documented rationale
- Complex modules with no tests
- Overlapping changes from multiple people
- Frequently modified but poorly understood files

## Visual Style
- Warm editorial or paper/ink aesthetic
- Muted blues and greens for architecture
- Amber callouts for cognitive debt
- Green/blue/amber/red for status

## Guidelines
- Not raw git log — human-readable narrative
- Include reasoning that evaporates first
- Flag severity on cognitive debt items
- Infer next steps from momentum, don't prescribe`,
		category: "visualization",
		tags: ["visualization", "recap", "context", "project", "onboarding"],
	},
	{
		slug: "task-board-visual-report",
		name: "Task Board Visual Report",
		description:
			"Generate a visual HTML project report from task board data — status dashboards, velocity charts, team workload, risk heatmaps, and next-sprint recommendations.",
		content: `# Task Board Visual Report

## Skill Overview
Generate a comprehensive visual project report as a self-contained HTML page from task board data. Produces a professional dashboard with status breakdowns, velocity analysis, team workload, risk identification, and actionable recommendations.

## Data Expectations
You will receive task board data from one or more providers (Azure DevOps work items, GitHub issues, Linear issues, JIRA tickets, or Fizzy cards). Adapt terminology to match the source but normalize into a consistent report structure.

## Verification Checkpoint
Before generating HTML, produce a structured fact sheet:
- Every quantitative figure: item counts by status, story points, cycle times, team member counts
- Every team member name and their assigned items
- Every label/tag/category and its count
- For each, cite the source data (tool call result that produced it)
Verify each claim against the raw data. If something cannot be verified, mark it as uncertain.

## HTML Report Structure

### 1. Report Header
- Project name, report period, generation date
- Source system badge (Azure DevOps / GitHub / Linear / JIRA / Fizzy)
- One-line project health indicator (On Track / At Risk / Off Track) with color

### 2. Executive Summary
2-3 sentences: overall health, biggest accomplishment, biggest risk. Written for someone who reads only this section.

### 3. Status Dashboard
KPI cards in a responsive grid:
- **Total Items**: count with breakdown by type (feature/bug/task/chore)
- **Completion Rate**: percentage done vs total, with trend arrow
- **In Progress**: count of active items, with WIP limit warning if > reasonable threshold
- **Blocked/At Risk**: count with red indicator if any exist
- **Velocity**: items or points completed per period (if historical data available)
- **Avg Cycle Time**: average days from start to done

Visual treatment: Large hero numbers, color-coded status (green = healthy, amber = watch, red = action needed). Use CSS Grid, 2-3 columns on desktop, single column on mobile.

### 4. Work Breakdown
#### By Status
Horizontal stacked bar chart (CSS-only, no JS library needed):
- Not Started / To Do (gray)
- In Progress / Active (blue)
- In Review / Testing (purple)
- Done / Completed (green)
- Blocked (red)

#### By Type/Category
Grouped breakdown showing features vs bugs vs tasks vs chores. Include the ratio — a project that's 80% bugs tells a different story than one that's 80% features.

#### By Priority
Table or card grid: Critical → High → Medium → Low with counts and representative items.

### 5. Team Workload
For each team member:
- Assigned item count (open vs closed)
- Current WIP (in-progress items)
- Items blocked

Visual treatment: Card per person with a small horizontal bar showing their distribution. Flag anyone with > 5 WIP items or > 0 blocked items.

### 6. Timeline & Velocity
If iteration/sprint data is available:
- Sprint-over-sprint completion trend (CSS bar chart)
- Planned vs delivered comparison
- Carry-over items highlighted

If no sprint data, show:
- Items created vs resolved over the report period
- Cumulative flow (items by status over time, if dates available)

### 7. Risk & Blockers
Amber/red-tinted cards with severity indicators (colored left border):
- **Blocked items**: List each with blocker reason, assignee, and age (days blocked)
- **Stale items**: In-progress for > 7 days with no update
- **Unassigned high-priority**: Critical/high items with no owner
- **Scope concerns**: Items added mid-sprint or after planning
- Each with severity (red = high, amber = medium, blue = low) and a concrete next action

### 8. Highlights & Accomplishments
- Recently completed items worth calling out (features shipped, bugs squashed)
- Items that moved fastest (shortest cycle time)
- Any notable patterns (e.g., "3 P1 bugs closed this week — great triage response")

### 9. Recommendations
3-5 actionable suggestions based on the data:
- If blocked items exist: "Unblock X by [action]"
- If WIP is high: "Consider WIP limits — 3 team members have > 5 active items"
- If velocity is trending down: "Velocity dropped X% — investigate capacity or scope changes"
- If bug ratio is high: "Bugs are X% of active work — consider a bug bash or root-cause session"
- If carry-over is high: "Y items carried over — right-size next sprint's commitment"

### 10. Appendix: Full Item List
Collapsible table of all items with columns:
- ID, Title, Type, Status, Priority, Assignee, Created, Updated
- Sortable headers (CSS :target trick or details/summary)
- Color-coded status pills

## Visual Design — Fabric Brand

### Logo
Include the Fabric logo in the report header. The report is a fixed light theme, so always render the black Fabric logo on the light background (no dark-mode logo swap):

\`\`\`html
<div class="fabric-logo">
  <svg class="logo-light" viewBox="0 0 1084.9 250" xmlns="http://www.w3.org/2000/svg" width="120"><path d="M115.14,219.89h-21v-87.3c.028-21.221,17.239-38.41,38.46-38.41h7v21h-7c-9.634.011-17.443,7.816-17.46,17.45v87.26Z"/><path d="M83,181.48h-20.93v-53.08c.044-36.62,29.72-66.296,66.34-66.34h26.59v20.94h-26.59c-25.068.017-45.388,20.332-45.41,45.4v53.08Z"/><path d="M50.9,143.07h-20.9v-18.86c.061-52.039,42.231-94.209,94.27-94.27h46.09v21h-46.14c-40.456.044-73.248,32.814-73.32,73.27v18.86Z"/><path fill-rule="evenodd" d="M828.47,121.729c1.824-1.704,3.11-3.904,3.7-6.33.835-3.177,1.222-6.456,1.15-9.74v-19.77c.066-3.438-.699-6.841-2.23-9.92-1.552-2.989-3.872-5.512-6.72-7.31-3.001-1.947-6.307-3.377-9.78-4.23-3.964-.958-8.032-1.421-12.11-1.38h-100v120l.01,1.62h21v-49.11h74.2c4.86.007,8.45.783,10.77,2.33,2.128,1.429,3.335,3.882,3.17,6.44v40.34h21.69v-37.67c.05-3.28-.337-6.552-1.15-9.73-.648-2.574-1.872-4.968-3.58-7-1.708-1.914-3.764-3.486-6.06-4.63-.37-.2-.76-.38-1.15-.57l.88-.22c2.28-.555,4.404-1.622,6.21-3.12ZM811.63,108.639c.162,2.552-1.046,4.997-3.17,6.42-2.31,1.54-5.91,2.31-10.77,2.31h-74.2v-37.15h74.2v-.01c4.86,0,8.45.773,10.77,2.32,2.124,1.432,3.331,3.883,3.17,6.44v19.67Z"/><path fill-rule="evenodd" d="M941.636,130.918v22.92c-.012,1.718.328,3.419,1,5,.663,1.524,1.645,2.888,2.88,4,1.271,1.178,2.768,2.086,4.4,2.67,1.796.625,3.688.933,5.59.91h91.47v18.2h-95.69c-4.001.036-7.974-.666-11.72-2.07h0c-3.672-1.4-7.037-3.499-9.91-6.18h0c-6-5.56-9-12.23-9-20.08v-64.92c-.032-3.757.742-7.477,2.27-10.91,1.611-3.482,3.91-6.601,6.76-9.17,2.869-2.671,6.223-4.769,9.88-6.18h0c3.747-1.401,7.72-2.099,11.72-2.06h95.65v18.19h-91.45c-1.901-.026-3.793.279-5.59.9-1.632.584-3.129,1.492-4.4,2.67-1.234,1.113-2.216,2.477-2.88,4-.672,1.581-1.012,3.282-1,5v18.91l.02,18.2Z"/><path fill-rule="evenodd" d="M672.857,130.039c-1.26-2.419-2.978-4.569-5.06-6.33-1.971-1.735-4.223-3.122-6.66-4.1,1.082-.399,2.134-.874,3.15-1.42.901-.479,1.746-1.055,2.52-1.72.74-.641,1.383-1.385,1.91-2.21.547-.864.997-1.786,1.34-2.75.32-.93.59-1.81.78-2.62.191-.762.325-1.538.4-2.32.05-.6.14-1.41.14-2.3v-18.44c.067-3.429-.691-6.825-2.21-9.9-1.531-2.962-3.814-5.47-6.62-7.27-2.992-1.95-6.292-3.38-9.76-4.23-3.961-.957-8.025-1.421-12.1-1.38h-96.92v120l.03,1.63h100c4.079.043,8.147-.424,12.11-1.39,3.473-.85,6.779-2.277,9.78-4.22,2.831-1.771,5.14-4.263,6.69-7.22,1.538-3.077,2.303-6.481,2.23-9.92v-24.53c.006-2.557-.593-5.079-1.75-7.36ZM564.777,81.049h71.11c4.847.007,8.423.823,10.73,2.45,2.14,1.507,3.21,3.81,3.21,6.91v13.89c.156,2.526-1.049,4.943-3.16,6.34-2.327,1.527-5.92,2.29-10.78,2.29h-71.11v-31.88ZM652.907,157.969c.166,2.55-1.038,4.996-3.16,6.42-2.32,1.54-5.92,2.31-10.77,2.31h-74.2v-36.05h74.2c4.85,0,8.45.77,10.77,2.31,2.122,1.424,3.326,3.87,3.16,6.42v18.59Z"/><polygon fill-rule="evenodd" points="868.229 63.047 887.519 63.047 887.519 184.627 866.619 184.627 866.619 63.057 868.229 63.047"/><path fill-rule="evenodd" d="M258.24,65.099h0c3.76-1.402,7.747-2.097,11.76-2.05h95.65v18.19h-91.49c-1.901-.026-3.793.279-5.59.9-1.631.586-3.127,1.494-4.4,2.67-1.231,1.115-2.213,2.479-2.88,4-.672,1.581-1.012,3.282-1,5v18.91h87.52v18.2h-87.48v53.7h-21v-93.25c-.033-3.758.745-7.48,2.28-10.91,1.607-3.481,3.903-6.601,6.75-9.17,2.875-2.673,6.236-4.771,9.9-6.18l-.02-.01Z"/><path d="M501.536,184.682l-22.156-37.732h-85.993l-22.157,37.732h-23.599l64.296-110.419c4.03-6.919,11.396-11.216,19.222-11.216h10.468c7.827,0,15.192,4.298,19.223,11.216l64.294,110.419h-23.599ZM436.382,84.062c-3.925,0-7.623,2.161-9.649,5.64l-21.107,36.231h61.513l-21.108-36.231c-2.026-3.478-5.724-5.64-9.649-5.64Z"/></svg>
</div>
\`\`\`

### Color System (CSS Custom Properties)
Use Fabric's design tokens:
\`\`\`css
:root {
  /* Backgrounds */
  --bg-primary: #fafaf9;       /* warm stone */
  --bg-card: #ffffff;
  --bg-muted: #f5f5f4;         /* stone-100 */
  --border: #e7e5e4;
  /* Text */
  --text-primary: #1c1917;
  --text-secondary: #57534e;
  --text-muted: #a8a29e;
  /* Brand */
  --primary: #9F2A3A;          /* deep rose — CTAs, active states, links */
  --secondary: #059669;        /* emerald — success, completion, AI-active */
  --destructive: #dc2626;      /* red — errors, blocked items */
  --highlight: #f59e0b;        /* amber — warnings, at-risk */
  --accent-blue: #2563eb;      /* informational */
  --accent-purple: #7c3aed;    /* in-review state */
  /* Dot-grid background texture */
  --dot-grid: radial-gradient(circle, rgba(0,0,0,0.13) 1px, transparent 1px);
  --dot-grid-size: 32px 32px;
  /* Pin native UA controls/scrollbars to light even on a dark-OS browser. */
  color-scheme: light;
}
\`\`\`

### Typography
- Page title: \`'EB Garamond', Georgia, 'Times New Roman', serif\` — 2rem, weight 400, generous line-height
- Section labels: 11px, uppercase, \`letter-spacing: 0.2em\`, color var(--text-muted), prefixed with a thin 2px vertical bar in var(--primary)
- Section headings: system sans-serif, 1.25rem, weight 600
- Body: \`-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif\` — 0.9rem
- Metrics/KPI numbers: \`font-variant-numeric: tabular-nums\`, 2.5rem

Import EB Garamond from Google Fonts in the HTML \`<head>\`:
\`\`\`html
<link href="https://fonts.googleapis.com/css2?family=EB+Garamond:wght@400;500&display=swap" rel="stylesheet">
\`\`\`

### Editorial Section Labels
Each major section should have an editorial label above the heading:
\`\`\`css
.editorial-label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.2em;
  color: var(--text-muted);
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}
.editorial-label::before {
  content: '';
  width: 2px;
  height: 14px;
  background: var(--primary);
}
\`\`\`

### Layout
- Max-width 1200px, centered with comfortable padding
- Dot-grid background texture on the page: \`background-image: var(--dot-grid); background-size: var(--dot-grid-size)\`
- Responsive: CSS Grid with auto-fit/minmax for card grids
- Sticky section navigation sidebar on desktop, horizontal scroll on mobile
- Print-friendly: \`@media print\` hides navigation, forces light theme

### Cards
- Warm stone-toned surfaces (\`var(--bg-card)\`) with subtle 1px solid \`var(--border)\`
- No shadows, no glassmorphism — flat, editorial feel
- Generous padding (1.5rem)

### Status Colors (mapped to brand tokens)
- Done/Completed: \`var(--secondary)\` (emerald)
- In Progress/Active: \`var(--accent-blue)\`
- In Review/Testing: \`var(--accent-purple)\`
- Blocked: \`var(--destructive)\` (red)
- At Risk/Warning: \`var(--highlight)\` (amber)
- Not Started: \`var(--text-muted)\` (gray)

### Charts (CSS-only)
- Horizontal bars: flexbox with percentage widths and status color backgrounds
- KPI cards: CSS Grid, large number + small label + trend indicator
- No JavaScript charting libraries — keep the HTML self-contained

### Footer
Include "Report generated by Fabric" with the Fabric logo (small, 80px) and generation timestamp.

### Animations
- Section entrance: \`@media (prefers-reduced-motion: no-preference) { .section { animation: fadeIn 0.3s ease } }\`
- No ambient/looping animations

## Overflow Prevention
- Apply \`min-width: 0\` on all flex/grid children
- \`overflow-wrap: break-word\` on text containers
- \`overflow-x: auto\` on tables

## Output Format
- Self-contained HTML file (inline CSS, one Google Font link)
- **Light-only, self-contained theme.** The report renders inside Fabric (which has its own theme) and as a standalone download, so it must look identical everywhere and must NOT follow the OS appearance. Therefore:
  - Do NOT emit any \`@media (prefers-color-scheme: dark)\` block — use the single light \`:root\` palette above for all surfaces.
  - Declare \`<meta name="color-scheme" content="light">\` in the \`<head>\` AND \`color-scheme: light;\` on \`:root\`/\`html\` so a dark-OS browser does not auto-apply dark styling to native controls/scrollbars.
  - Always render the black (light) Fabric logo; do not include a dark-mode logo variant.
- Responsive from 375px to 1440px+
- Accessible: semantic HTML, ARIA labels on status indicators, sufficient color contrast (WCAG 2.1 AA, 4.5:1 for normal text)
`,
		category: "visualization",
		tags: [
			"task-board",
			"project-report",
			"visualization",
			"html",
			"sprint",
			"agile",
		],
	},
	{
		slug: "visual-share",
		name: "Visual Share",
		description:
			"Deploy a visual explainer HTML page to Vercel and get a live, shareable URL instantly.",
		content: `# Visual Share

## Skill Overview
Share visual explainer HTML pages instantly via Vercel. Zero authentication required — returns a live URL immediately.

## When to Use
- Sharing diagrams with teammates
- Publishing reviews for async feedback
- Creating temporary documentation
- Demonstrating concepts to stakeholders

## Usage
\`\`\`
/share <file-path>
\`\`\`

## How It Works
1. Copies HTML file to temp directory as index.html
2. Deploys via vercel-deploy skill (no auth needed)
3. Returns live URL immediately

## Output
\`\`\`
Sharing my-diagram.html...

✓ Shared successfully!

Live URL:  https://skill-deploy-abc123.vercel.app
Claim URL: https://vercel.com/claim-deployment?code=...
\`\`\`

## Requirements
- vercel-deploy skill (pre-installed or: pi install npm:vercel-deploy)

## Notes
- Deployments are public — anyone with URL can view
- Preview deployments: 30 day retention default
- Each share creates new deployment with unique URL
- Claim URL lets you transfer to your Vercel account

## Script Location
\`\`\`
bash {{skill_dir}}/scripts/share.sh <file>
\`\`\`

## JSON Output
For programmatic use:
\`\`\`json
{"previewUrl":"https://...","claimUrl":"https://...","deploymentId":"..."}
\`\`\``,
		category: "visualization",
		tags: ["visualization", "share", "deploy", "vercel", "collaboration"],
	},
];

// ============================================================================
// Filesystem-sourced skills (Anthropic-format folders with assets)
// ============================================================================

// Files treated as the canonical SKILL.md body or metadata — not uploaded as assets.
const SKILL_META_FILES = new Set(["SKILL.md", "NOTICE.md", "README.md"]);

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".md": "text/markdown; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
	".json": "application/json",
	".css": "text/css; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".ts": "application/typescript; charset=utf-8",
	".sh": "application/x-sh",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
};

function contentTypeFor(filePath: string): string {
	const dot = filePath.lastIndexOf(".");
	const ext = dot >= 0 ? filePath.slice(dot).toLowerCase() : "";
	return CONTENT_TYPE_BY_EXT[ext] ?? "application/octet-stream";
}

/**
 * Minimal YAML frontmatter parser. Handles the subset we need for SKILL.md:
 * top-level scalar key/value pairs plus a nested `metadata:` block with
 * scalar children. Anything more exotic should be flagged manually.
 */
interface SkillFrontmatter {
	name?: string;
	description?: string;
	category?: string;
	tags?: string[];
	version?: number;
	license?: string;
}

function parseFrontmatter(skillMd: string): {
	frontmatter: SkillFrontmatter;
	body: string;
} {
	const match = skillMd.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
	if (!match) {
		return { frontmatter: {}, body: skillMd };
	}

	const [, rawFm, body] = match;
	const fm: SkillFrontmatter = {};
	let inMetadata = false;

	for (const rawLine of rawFm.split(/\r?\n/)) {
		if (!rawLine.trim()) {
			continue;
		}
		const indented = /^\s+/.test(rawLine);
		const line = rawLine.trim();

		if (!indented) {
			inMetadata = false;
			if (line === "metadata:") {
				inMetadata = true;
				continue;
			}
			const [key, ...rest] = line.split(":");
			if (!key || rest.length === 0) {
				continue;
			}
			const value = rest
				.join(":")
				.trim()
				.replace(/^["']|["']$/g, "");
			applyFrontmatterField(fm, key.trim(), value);
		} else if (inMetadata) {
			const [key, ...rest] = line.split(":");
			if (!key || rest.length === 0) {
				continue;
			}
			const value = rest
				.join(":")
				.trim()
				.replace(/^["']|["']$/g, "");
			applyFrontmatterField(fm, key.trim(), value);
		}
	}

	return { frontmatter: fm, body };
}

function applyFrontmatterField(
	fm: SkillFrontmatter,
	key: string,
	value: string,
): void {
	switch (key) {
		case "name":
			fm.name = value;
			return;
		case "description":
			fm.description = value;
			return;
		case "category":
			fm.category = value;
			return;
		case "license":
			fm.license = value;
			return;
		case "version": {
			const parsed = Number.parseInt(value, 10);
			if (Number.isFinite(parsed)) {
				fm.version = parsed;
			}
			return;
		}
		case "tags": {
			// tags: [a, b, c]
			const arrMatch = value.match(/^\[(.*)\]$/);
			if (arrMatch) {
				fm.tags = arrMatch[1]
					.split(",")
					.map((t) => t.trim().replace(/^["']|["']$/g, ""))
					.filter(Boolean);
			}
			return;
		}
		default:
			return;
	}
}

async function walkFiles(
	root: string,
	current: string = root,
	out: string[] = [],
): Promise<string[]> {
	const entries = await readdir(current, { withFileTypes: true });
	for (const entry of entries) {
		const full = join(current, entry.name);
		if (entry.isDirectory()) {
			await walkFiles(root, full, out);
		} else if (entry.isFile()) {
			out.push(full);
		}
	}
	return out;
}

function sha256(buffer: Buffer): string {
	return createHash("sha256").update(buffer).digest("hex");
}

interface FilesystemSkillResult {
	slug: string;
	filesCreated: number;
	filesUpdated: number;
	filesUnchanged: number;
}

async function seedFilesystemSkill(
	slugDir: string,
	slug: string,
	bucket: string,
): Promise<FilesystemSkillResult> {
	// 1. Read and parse SKILL.md
	const skillMdPath = join(slugDir, "SKILL.md");
	const skillMdRaw = await readFile(skillMdPath, "utf-8");
	const { frontmatter } = parseFrontmatter(skillMdRaw);

	if (!frontmatter.name || !frontmatter.description) {
		throw new Error(
			`SKILL.md at ${skillMdPath} is missing required 'name' or 'description' in frontmatter`,
		);
	}

	// Anthropic's convention is frontmatter.name == slug. Fabric's existing Skill
	// rows use human-readable names, so if they match, derive a display name from
	// the first `# ` heading or by title-casing the slug.
	let displayName = frontmatter.name;
	if (displayName === slug) {
		const heading = skillMdRaw.match(/^#\s+(.+?)\s*$/m);
		displayName = heading
			? heading[1].trim()
			: slug
					.split("-")
					.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
					.join(" ");
	}

	// Frontmatter maps onto Skill columns; the full SKILL.md (with frontmatter)
	// stays in Skill.content — the runtime loader strips frontmatter on read.
	const existingSkill = await db.skill.findFirst({
		where: {
			slug,
			scope: "SYSTEM",
			userId: null,
			organizationId: null,
		},
	});

	const skill = existingSkill
		? await db.skill.update({
				where: { id: existingSkill.id },
				data: {
					name: displayName,
					description: frontmatter.description,
					content: skillMdRaw,
					category: frontmatter.category,
					tags: frontmatter.tags ?? [],
					version: frontmatter.version ?? 1,
					isPublished: true,
				},
			})
		: await db.skill.create({
				data: {
					slug,
					scope: "SYSTEM",
					name: displayName,
					description: frontmatter.description,
					content: skillMdRaw,
					category: frontmatter.category,
					tags: frontmatter.tags ?? [],
					version: frontmatter.version ?? 1,
					isPublished: true,
				},
			});

	// 2. Walk other files (assets/, references/, scripts/, ...) and sync SkillFile rows.
	// Skip root-level metadata files (SKILL.md, NOTICE.md, README.md) which are not
	// exposed to the model as separate files.
	const allFiles = await walkFiles(slugDir);
	const skillFiles = allFiles.filter((abs) => {
		const rel = relative(slugDir, abs).split("\\").join("/");
		return !SKILL_META_FILES.has(rel);
	});

	const existingFiles = await db.skillFile.findMany({
		where: { skillId: skill.id },
	});
	const existingByPath = new Map(existingFiles.map((f) => [f.path, f]));
	const seenPaths = new Set<string>();

	let created = 0;
	let updated = 0;
	let unchanged = 0;

	for (const abs of skillFiles) {
		const path = relative(slugDir, abs).split("\\").join("/");
		seenPaths.add(path);

		const buffer = await readFile(abs);
		const digest = sha256(buffer);
		const sizeBytes = buffer.byteLength;
		const contentType = contentTypeFor(path);
		const existing = existingByPath.get(path);

		if (existing && existing.sha256 === digest) {
			unchanged++;
			continue;
		}

		const fileId =
			existing?.id ??
			(
				await db.skillFile.create({
					data: {
						skillId: skill.id,
						path,
						contentType,
						storageKey: "pending",
						sizeBytes,
						sha256: digest,
						version: 1,
					},
				})
			).id;

		const basename = path.split("/").pop() ?? path;
		const storageKey = `skills/${skill.id}/${fileId}/${basename}`;

		await uploadFile(storageKey, buffer, { bucket, contentType });

		if (existing) {
			await db.skillFile.update({
				where: { id: existing.id },
				data: {
					contentType,
					storageKey,
					sizeBytes,
					sha256: digest,
					version: { increment: 1 },
				},
			});
			updated++;
		} else {
			await db.skillFile.update({
				where: { id: fileId },
				data: { storageKey },
			});
			created++;
		}
	}

	// 3. Remove stale SkillFile rows for files deleted from the seed source
	const stalePaths = existingFiles
		.filter((f) => !seenPaths.has(f.path))
		.map((f) => f.id);
	if (stalePaths.length > 0) {
		await db.skillFile.deleteMany({ where: { id: { in: stalePaths } } });
	}

	return {
		slug,
		filesCreated: created,
		filesUpdated: updated,
		filesUnchanged: unchanged,
	};
}

async function seedFilesystemSkills(): Promise<void> {
	const seedRoot = join(__dirname, "skills-seed");
	let entries: string[];
	try {
		entries = (await readdir(seedRoot, { withFileTypes: true }))
			.filter((e) => e.isDirectory())
			.map((e) => e.name);
	} catch (err) {
		logger.info(
			`No filesystem skills to seed (${seedRoot} does not exist)`,
		);
		return;
	}

	if (entries.length === 0) {
		logger.info("No filesystem skill folders found");
		return;
	}

	const bucket = config.storage.bucketNames.skills;
	await ensureBuckets([bucket]);

	for (const slug of entries) {
		const slugDir = join(seedRoot, slug);
		try {
			const result = await seedFilesystemSkill(slugDir, slug, bucket);
			logger.info(
				`Filesystem skill "${result.slug}": ${result.filesCreated} created, ${result.filesUpdated} updated, ${result.filesUnchanged} unchanged`,
			);
		} catch (err) {
			logger.error(`Failed to seed filesystem skill "${slug}":`, err);
			throw err;
		}
	}
}

async function seedSkills() {
	logger.info("Seeding system skills...");

	let created = 0;
	let updated = 0;

	for (const skillData of systemSkills) {
		const existing = await db.skill.findFirst({
			where: {
				slug: skillData.slug,
				scope: "SYSTEM",
				userId: null,
				organizationId: null,
			},
		});

		if (existing) {
			await db.skill.update({
				where: { id: existing.id },
				data: {
					name: skillData.name,
					description: skillData.description,
					content: skillData.content,
					category: skillData.category,
					tags: skillData.tags,
					isPublished: true,
				},
			});
			updated++;
		} else {
			await db.skill.create({
				data: {
					slug: skillData.slug,
					name: skillData.name,
					description: skillData.description,
					content: skillData.content,
					category: skillData.category,
					tags: skillData.tags,
					scope: "SYSTEM",
					isPublished: true,
				},
			});
			created++;
		}
	}

	logger.info(
		`Markdown-only skills seeded: ${created} created, ${updated} updated (${systemSkills.length} total)`,
	);

	await seedFilesystemSkills();
}

// Run if called directly (import-safe for unit tests that read the exported data).
if (require.main === module) {
	seedSkills()
		.catch((e) => {
			logger.error("Failed to seed skills:", e);
			process.exit(1);
		})
		.finally(() => db.$disconnect());
}
