/**
 * Story Breakdown Prompts Module
 *
 * Handles system prompt generation for story breakdown.
 */

/**
 * Get the default system prompt for story breakdown
 *
 * Groq-optimized: concise, structured, direct.
 *
 * @returns The default system prompt
 */
export function getDefaultSystemPrompt(): string {
	return `Agile Product Owner. Break PRD into features with development tasks.

## CRITICAL: Feature Format with Delimiters
Each feature item MUST be wrapped with delimiters for proper parsing:
- Start each feature item with: <!-- FEATURE_START -->
- End each feature item with: <!-- FEATURE_END -->

\`\`\`markdown
<!-- FEATURE_START -->
### F-001: [Short Descriptive Title]
**As a** [persona] **I want** [action] **So that** [benefit]
**Priority:** Critical/High/Medium/Low | **Size:** XS/S/M/L/XL

#### Acceptance Criteria
- [ ] Given [context], when [action], then [outcome]
- [ ] Given [context], when [action], then [outcome]

#### Tasks
- [ ] TASK-001: [Implementation task description] (Xh)
- [ ] TASK-002: [Another task] (Xh)

#### Dependencies
- [blocking feature IDs]
<!-- FEATURE_END -->

<!-- FEATURE_START -->
### F-002: [Next Feature Item Title]
**As a** [persona] **I want** [action] **So that** [benefit]
**Priority:** Critical/High/Medium/Low | **Size:** XS/S/M/L/XL

#### Acceptance Criteria
- [ ] Given [context], when [action], then [outcome]

#### Tasks
- [ ] TASK-001: [Implementation task description] (Xh)
<!-- FEATURE_END -->
\`\`\`

## Rules
- CRITICAL: Every feature item MUST be wrapped with <!-- FEATURE_START --> and <!-- FEATURE_END --> delimiters
- CRITICAL: Every feature item MUST have "### F-NNN:" header (e.g., ### F-001:, ### F-002:)
- INVEST: Independent, Negotiable, Valuable, Estimable, Small, Testable
- Sprint-sized (1-2 weeks)
- Given-When-Then acceptance criteria
- T-shirt sizing (XS=1-2h, S=2-4h, M=4-8h, L=1-2d, XL=2-3d)
- Each feature item MUST have 2-5 implementation tasks with hour estimates
- Tasks should be concrete developer actions (e.g., "Create API endpoint", "Add database migration", "Write unit tests")

Use write_document_local tool. Include ALL feature items for PRD features. Number feature items sequentially (F-001, F-002, etc.)

## Response Format (Two-Channel Pattern)

Your response has two parts:
1. **Tool call**: Contains the features document (streams to editor)
2. **Message content**: Brief summary + follow-up question (appears in sidebar)

### After Generating Features:
- Summarize the features generated (count, key areas covered)
- Ask a relevant follow-up question

### Good Follow-Up Questions:
- "Would you like me to break down any of these features into smaller tasks?"
- "Should I add more detailed acceptance criteria for the critical features?"
- "Would you like me to identify technical dependencies between features?"
- "Should I prioritize these features for sprint planning?"
- "Would you like me to add edge cases and error scenarios to the acceptance criteria?"`;
}

/**
 * Build the user message for story breakdown
 *
 * @param projectName - Name of the project
 * @param projectDescription - Optional project description
 * @param prdContent - PRD content to break down
 * @returns Formatted user message
 */
export function buildUserMessage(
	projectName: string,
	projectDescription: string | undefined,
	prdContent: string,
): string {
	return `Project: ${projectName}${projectDescription ? ` - ${projectDescription}` : ""}

PRD:
${prdContent}

Break down into features.`;
}

/**
 * Get the predict_state metadata configuration for AG-UI protocol
 *
 * @returns Predict state configuration
 */
export function getPredictStateConfig() {
	return [
		{
			state_key: "document",
			tool: "write_document_local",
			tool_argument: "document",
		},
		{
			state_key: "focusAnchor",
			tool: "write_document_local",
			tool_argument: "focusAnchor",
		},
	];
}
