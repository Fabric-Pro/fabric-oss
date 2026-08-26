export interface DocumentRepairFixture {
	name: string;
	input: string;
	expectNormalized: string[];
	expectHtml: string[];
	/** Substrings that must NOT survive the repair, in either direction. */
	expectAbsent?: string[];
}

export const documentRepairFixtures: DocumentRepairFixture[] = [
	{
		name: "collapsed key technologies table and escaped bullet",
		input: `\\- **Authentication**: Better Auth and JWT for secure user authentication, with two-factor authentication (2FA) for additional security.

Key Technologies

| Technology | Purpose | |-------------|----------------------------------------|| React | Frontend development || Next.js | Server-side rendering and routing || TypeScript | Static type checking || Tailwind CSS | Styling framework |`,
		expectNormalized: [
			"- **Authentication**: Better Auth and JWT for secure user authentication, with two-factor authentication (2FA) for additional security.",
			"| Technology | Purpose |",
			"| React | Frontend development |",
			"| Next.js | Server-side rendering and routing |",
		],
		expectHtml: [
			"<ul>",
			"<table>",
			"<th>Technology</th>",
			"<td>Frontend development</td>",
		],
	},
	{
		// A table that failed to render during an AI diff was serialized back
		// as one long pipe run, glued to the prose it shared a paragraph with.
		// Half its cells are empty, which is what used to defeat the rebuild.
		name: "collapsed risk table with empty cells glued to prose",
		input: `## Risks

The current register is below. | Risk | Owner | Mitigation | | --- | --- | --- | | Data loss |  | Nightly backups | | Latency | Bob |  |`,
		expectNormalized: [
			"The current register is below.",
			"| Risk | Owner | Mitigation |",
			"| Data loss |  | Nightly backups |",
			"| Latency | Bob |  |",
		],
		expectHtml: [
			"<table>",
			"<th>Mitigation</th>",
			"<td>Nightly backups</td>",
		],
	},
	{
		name: "collapsed endpoint summary and escaped numbered heading",
		input: `## 4\\. API Specifications

plaintext GET /api/users POST /api/auth/login PUT /api/user/:id DELETE /api/user/:id`,
		expectNormalized: [
			"## 4. API Specifications",
			"- GET /api/users",
			"- POST /api/auth/login",
			"- DELETE /api/user/:id",
		],
		expectHtml: [
			"<h2>4. API Specifications</h2>",
			"<ul>",
			"GET /api/users",
		],
	},
	{
		name: "bold marker split across a bullet boundary",
		input: `- **Dependency**: Existing per-project release notes subscriber model

- **Dependency*

- *: Release notes review/approval step (Ticket 1869)`,
		expectNormalized: [
			"- **Dependency**: Release notes review/approval step (Ticket 1869)",
		],
		expectHtml: ["Release notes review/approval step"],
	},
	{
		name: "open question split across two bullets",
		input: `## Open Questions

- Q: What

- icon asset should be used to distinguish org-synced subscribers from manually added subscribers?`,
		expectNormalized: [
			"- Q: What icon asset should be used to distinguish org-synced subscribers from manually added subscribers?",
		],
		expectHtml: ["Open Questions"],
	},
	{
		name: "nested markdown trapped in plaintext fence",
		input: `\`\`\`plaintext
### Request/Response Formats

- **Data Structures:** JSON
- **Validation Rules:** Joi
\`\`\``,
		expectNormalized: [
			"### Request/Response Formats",
			"- **Data Structures:** JSON",
		],
		expectHtml: ["<h3>Request/Response Formats</h3>", "<ul>"],
	},
	{
		// An AI edit renumbered these criteria. The word diff split the marker
		// digits across DEL/ADD, the item degraded to a paragraph, its marker
		// was escaped on save, and the five-space continuations — no longer
		// inside a list item — became an indented code block that the next
		// save wrote out as a fence. A stray empty pair rode along.
		name: "escaped acceptance criteria with prose sealed in bare fences",
		input: `### Work Capture

38\\. GIVEN no chat app or monitored channel is configured

\`\`\`
 WHEN a user attempts active chat work capture
 THEN Fabric blocks capture and explains the missing chat setup.
\`\`\`

39\\. GIVEN chat setup is missing in Settings

\`\`\`
\`\`\``,
		expectNormalized: [
			"38. GIVEN no chat app or monitored channel is configured",
			"39. GIVEN chat setup is missing in Settings",
			"WHEN a user attempts active chat work capture",
			"THEN Fabric blocks capture and explains the missing chat setup.",
		],
		expectHtml: ["<li>", "GIVEN no chat app or monitored channel"],
		expectAbsent: ["\\.", "```"],
	},
];
