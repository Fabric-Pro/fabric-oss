/**
 * Base Instructions
 *
 * Core instructions that apply to all document generation,
 * organized by quality tier.
 */

import type { QualityTier } from "../types";

/**
 * Quality tier instructions
 */
export const QUALITY_TIER_INSTRUCTIONS: Record<QualityTier, string> = {
	draft: `## Quality Level: Draft

Generate a quick draft focusing on structure and key points:
- Cover all required sections with essential content
- Use placeholder text for details that need research
- Focus on getting the framework and flow right
- Mark areas that need expansion with [TODO: ...]
- Prioritize speed over completeness`,

	standard: `## Quality Level: Standard

Generate a complete, professional document:
- All required sections fully written with specific details
- Include concrete examples and actionable items
- Ready for team review and feedback
- Clear, professional language throughout
- Proper formatting with consistent structure`,

	comprehensive: `## Quality Level: Comprehensive

Generate an exhaustive, enterprise-grade document:
- Deep analysis in each section with multiple perspectives
- Comprehensive examples covering edge cases
- Cross-references between related sections
- Risk analysis with mitigation strategies
- Detailed acceptance criteria for all features
- Consider security, scalability, and maintainability
- Include decision rationale and trade-off analysis`,
};

/**
 * Universal writing guidelines
 */
export const WRITING_GUIDELINES = `## Writing Guidelines

### IMPORTANT: Proper Markdown Formatting

Your output MUST be well-formatted markdown:

1. **Headings**: Use ## for main sections, ### for subsections
2. **Blank lines**: Add blank lines before AND after every heading
3. **Lists**: Put each item on its own line with proper - or 1. prefix
4. **Paragraphs**: Separate paragraphs with blank lines
5. **Tables**: Use proper markdown table syntax with | separators

Example structure:
\`\`\`
## Main Section

Introduction paragraph.

### Subsection

- Item one
- Item two
- Item three

| Header 1 | Header 2 |
|----------|----------|
| Value 1  | Value 2  |
\`\`\`

### Language
- Use clear, direct language - avoid jargon unless necessary
- Be specific - replace vague terms with concrete details
- Use active voice: "The system validates..." not "Validation is performed..."
- Avoid ambiguous words: replace "should/might/could" with "will/must/may"
- Define acronyms on first use

### Structure
- Start each section with a brief overview
- Group related items logically
- Use consistent terminology throughout
- End with clear next steps or action items where appropriate

### Diagrams with Mermaid

When diagrams would help explain concepts, use mermaid code blocks. The editor renders mermaid diagrams beautifully.

**Flowcharts** - For process flows and decision trees:
\`\`\`mermaid
flowchart TD
    A[Start] --> B{Decision?}
    B -->|Yes| C[Action 1]
    B -->|No| D[Action 2]
    C --> E[End]
    D --> E
\`\`\`

**Sequence Diagrams** - For interactions between components:
\`\`\`mermaid
sequenceDiagram
    participant U as User
    participant S as Server
    participant D as Database
    U->>S: Request
    S->>D: Query
    D-->>S: Response
    S-->>U: Result
\`\`\`

**Entity Relationship** - For data models:
\`\`\`mermaid
erDiagram
    USER ||--o{ ORDER : places
    ORDER ||--|{ LINE_ITEM : contains
    PRODUCT ||--o{ LINE_ITEM : "ordered in"
\`\`\`

**State Diagrams** - For state machines:
\`\`\`mermaid
stateDiagram-v2
    [*] --> Draft
    Draft --> Review
    Review --> Approved
    Review --> Draft: Changes Requested
    Approved --> Published
    Published --> [*]
\`\`\`

**C4 Architecture Diagrams** - For system architecture. ALWAYS use proper C4 syntax (NOT basic flowchart/graph syntax):

C4 Context Diagram (highest level - shows system and external actors):
\`\`\`mermaid
C4Context
    title System Context for E-Commerce Platform

    Person(customer, "Customer", "A user of the e-commerce platform")
    Person(admin, "Admin", "System administrator")

    Enterprise_Boundary(b0, "Company") {
        System(ecommerce, "E-Commerce System", "Allows customers to browse and purchase products")
    }

    System_Ext(payment, "Payment Gateway", "Processes payments")
    System_Ext(email, "Email Service", "Sends notifications")

    Rel(customer, ecommerce, "Uses", "HTTPS")
    Rel(admin, ecommerce, "Manages", "HTTPS")
    Rel(ecommerce, payment, "Processes payments", "API")
    Rel(ecommerce, email, "Sends emails", "SMTP")
\`\`\`

C4 Container Diagram (shows containers within the system):
\`\`\`mermaid
C4Container
    title Container Diagram for E-Commerce System

    Person(customer, "Customer", "A user")

    System_Boundary(c1, "E-Commerce System") {
        Container(web, "Web App", "Next.js", "Serves the UI")
        Container(api, "API Server", "Node.js", "Business logic")
        ContainerDb(db, "Database", "PostgreSQL", "Stores data")
        Container(cache, "Cache", "Redis", "Session & caching")
    }

    Rel(customer, web, "Uses", "HTTPS")
    Rel(web, api, "Calls", "REST/JSON")
    Rel(api, db, "Reads/Writes", "SQL")
    Rel(api, cache, "Uses", "Redis Protocol")
\`\`\`

IMPORTANT: For architecture documents, ALWAYS use C4Context, C4Container, or C4Component syntax. Do NOT use basic "graph LR" or "flowchart" for architecture - those are for process flows only.

CRITICAL FORMATTING RULE: Every mermaid code block MUST be properly closed with a matching \\\`\\\`\\\` fence BEFORE any heading, paragraph, or other markdown content resumes. Never leave a mermaid fence unclosed. Each diagram must be a self-contained fenced block:

\\\`\\\`\\\`mermaid
<diagram content>
\\\`\\\`\\\`

Do NOT continue writing headings or prose inside a mermaid fence. Close the fence first, then continue with markdown.

Use diagrams to:
- Visualize complex relationships and flows
- Show system architecture at different levels
- Illustrate state transitions and workflows
- Make abstract concepts concrete

Keep diagrams focused and readable - split complex diagrams into multiple simpler ones.`;

/**
 * Get base instructions for a quality tier
 */
export function getBaseInstructions(tier: QualityTier): string {
	return `${QUALITY_TIER_INSTRUCTIONS[tier]}

${WRITING_GUIDELINES}`;
}
