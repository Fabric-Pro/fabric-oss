import { describe, expect, it } from "vitest";
import { repairMalformedMermaidFences } from "../src/activities/project-document-generation";

describe("repairMalformedMermaidFences", () => {
	it("should auto-close an unclosed mermaid fence when a heading follows", () => {
		const input = `### C4 Context Diagram

\`\`\`mermaid
C4Context
    title Context Diagram
    Person(customer, "Customer", "Uses the app")
    System(app, "App", "The application")
    Rel(customer, app, "Uses", "HTTPS")

### C4 Container Diagram

\`\`\`mermaid
C4Container
    title Container Diagram
    Person(customer, "Customer", "End user")
\`\`\``;

		const result = repairMalformedMermaidFences(input);

		// First mermaid block should be auto-closed before the second heading
		expect(result).toContain("```mermaid\nC4Context");
		expect(result).toContain("```\n### C4 Container Diagram");
		// Second mermaid block should remain intact
		expect(result).toContain("```mermaid\nC4Container");
	});

	it("should leave properly-closed mermaid fences untouched", () => {
		const input = `### Diagram

\`\`\`mermaid
flowchart TD
    A --> B
\`\`\`

### Next Section`;

		const result = repairMalformedMermaidFences(input);
		expect(result).toBe(input);
	});

	it("should handle multiple unclosed mermaid fences", () => {
		const input = `### Context

\`\`\`mermaid
C4Context
    title System
    Person(user, "User", "A user")

### Container

\`\`\`mermaid
C4Container
    title Containers
    Container(web, "Web", "App")

### ER Diagram

\`\`\`mermaid
erDiagram
    CUSTOMER ||--o{ ORDER : places
\`\`\``;

		const result = repairMalformedMermaidFences(input);

		// All three diagrams should be separate, properly-closed blocks
		const mermaidBlocks = result.match(/```mermaid/g);
		const closingFences = result.match(/^```$/gm);
		expect(mermaidBlocks).toHaveLength(3);
		expect(closingFences).toHaveLength(3);

		// Headings should not be inside code blocks
		expect(result).toContain("```\n### Container");
		expect(result).toContain("```\n### ER Diagram");
	});

	it("should discard stray bare fences between markdown sections", () => {
		const input = `### Endpoints

- GET /api/users

\`\`\`

### Request/Response

- **Data:** JSON`;

		const result = repairMalformedMermaidFences(input);

		// The bare ``` should not create a code block
		expect(result).not.toContain(
			"```\n\n### Request/Response\n\n- **Data:** JSON\n```",
		);
		expect(result).toContain("### Request/Response");
		expect(result).toContain("- **Data:** JSON");
	});

	it("should fix the exact malformed content from the staging bug report", () => {
		// This is the exact pattern from the failing document on staging:
		// C4Context fence unclosed, C4Container has bare `mermaid` without opening ```,
		// ER diagram is properly fenced.
		const input = `## Architecture Diagrams

### C4 Context Diagram

\`\`\`mermaid
C4Context
    title Context Diagram for TEST Project

    Person(customer, "Customer", "Uses web app to discover restaurants and place orders")
    Person(merchant, "Restaurant Partner", "Manages menus and receives orders")

    System(test, "TEST Project", "Web-based food delivery platform")

    System_Ext(payment, "Payment Gateway", "Processes card and wallet payments")
    System_Ext(notify, "Notification Service", "Sends text/email/app notifications")

    Rel(customer, test, "Uses", "HTTPS")
    Rel(merchant, test, "Uses (Partner Portal)", "HTTPS")
    Rel(test, payment, "Integrates with", "API")
    Rel(test, notify, "Sends events to", "Webhook/HTTP")

### C4 Container Diagram

\`\`\`mermaid
C4Container
    title Container Diagram for TEST Project

    Person(customer, "Customer", "End user of the web app")

    System_Boundary(c1, "TEST Project") {
        Container(web, "Web App", "Next.js + TypeScript", "Presents UI")
        Container(api, "API Server", "Node.js", "Business logic")
        ContainerDb(db, "PostgreSQL", "Database", "Stores data")
    }

    Rel(customer, web, "Uses", "HTTPS")
    Rel(web, api, "Calls", "REST/JSON")
    Rel(api, db, "Reads/Writes", "SQL")

### ER Diagram

\`\`\`mermaid
erDiagram
    CUSTOMER ||--o{ ORDER : places
    RESTAURANT ||--|{ MENU_ITEM : offers
    ORDER ||--|{ ORDER_ITEM : contains
\`\`\`

## Core Data Model`;

		const result = repairMalformedMermaidFences(input);

		// All three diagrams should be separate, properly-closed blocks
		const mermaidBlocks = result.match(/```mermaid/g);
		expect(mermaidBlocks).toHaveLength(3);

		// Each diagram should have its own closing fence
		const closingFences = result.match(/^```$/gm);
		expect(closingFences).toHaveLength(3);

		// Headings should NOT be inside code blocks
		expect(result).toContain("### C4 Container Diagram");
		expect(result).toContain("### ER Diagram");
		expect(result).toContain("## Core Data Model");

		// The C4Context block should contain its content
		expect(result).toContain(
			'Rel(test, notify, "Sends events to", "Webhook/HTTP")',
		);
		// The C4Container block should contain its content
		expect(result).toContain('Rel(api, db, "Reads/Writes", "SQL")');
		// The ER diagram should contain its content
		expect(result).toContain("CUSTOMER ||--o{ ORDER : places");
	});

	it("should wrap bare mermaid keyword (no backticks) into a proper fence", () => {
		const input = `### Context Diagram

\`\`\`mermaid
C4Context
    title System Context
    Person(user, "User", "End user")
    Rel(user, app, "Uses", "HTTPS")

### Container Diagram



mermaid
C4Container
    title Container Diagram
    Person(user, "User", "End user")
    Rel(user, web, "Uses", "HTTPS")

### ER Diagram

\`\`\`mermaid
erDiagram
    USER ||--o{ ORDER : places
\`\`\``;

		const result = repairMalformedMermaidFences(input);

		// All three should be properly fenced
		const mermaidBlocks = result.match(/```mermaid/g);
		expect(mermaidBlocks).toHaveLength(3);

		const closingFences = result.match(/^```$/gm);
		expect(closingFences).toHaveLength(3);

		// The bare "mermaid" block should now be wrapped
		expect(result).toContain("```mermaid\nC4Container");
		// Headings should be outside fences
		expect(result).toContain("### Container Diagram");
		expect(result).toContain("### ER Diagram");
	});

	it("should NOT treat 'mermaid' in prose as a fence opener", () => {
		const input = `## Diagrams

We use mermaid
for all our architecture diagrams in this project.

### Next Section

Some content here.`;

		const result = repairMalformedMermaidFences(input);
		// "mermaid" in prose should be left untouched
		expect(result).toBe(input);
	});

	it("should handle non-mermaid fences normally", () => {
		const input = `\`\`\`json
{ "key": "value" }
\`\`\`

### Section`;

		const result = repairMalformedMermaidFences(input);
		expect(result).toBe(input);
	});
});
