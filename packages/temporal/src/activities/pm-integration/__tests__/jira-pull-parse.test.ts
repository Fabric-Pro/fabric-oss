/**
 * Tests for parsePMItemFromGetOutput — focused on the Jira (Atlassian Rovo)
 * pull, which nests everything under `fields`. Before the fix the parser only
 * read top-level `summary`/`description` and ADO's `fields["System.Title"]`, so
 * a Jira pull extracted nothing → empty update → false-success no-op.
 *
 * The Jira shape below mirrors a live getJiraIssue response.
 */

import { describe, expect, it } from "vitest";
import { parsePMItemFromGetOutput } from "../story-sync";

// MCP tools return { content: [{ type: "text", text: "<json>" }] }
const wrap = (value: unknown) => ({
	content: [{ type: "text", text: JSON.stringify(value) }],
});

const JIRA_ISSUE = {
	id: "10170",
	key: "SAN-11",
	self: "https://api.atlassian.com/ex/jira/abc/rest/api/3/issue/10170",
	fields: {
		summary: "Initial Git Setup",
		description: "Set up the repository and CI.",
		status: { id: "10000", name: "In Progress" },
		labels: ["backend", "infra"],
	},
};

describe("parsePMItemFromGetOutput — Jira (Rovo) nested fields", () => {
	it("extracts title/description/status/labels from fields", () => {
		const parsed = parsePMItemFromGetOutput(wrap(JIRA_ISSUE));
		expect(parsed.title).toBe("Initial Git Setup");
		expect(parsed.description).toBe("Set up the repository and CI.");
		expect(parsed.columnName).toBe("In Progress");
		expect(parsed.labels).toEqual(["backend", "infra"]);
	});

	it("works on the unwrapped object too", () => {
		const parsed = parsePMItemFromGetOutput(JIRA_ISSUE);
		expect(parsed.title).toBe("Initial Git Setup");
		expect(parsed.columnName).toBe("In Progress");
	});

	it("flattens an ADF description object instead of dropping it", () => {
		const issue = {
			...JIRA_ISSUE,
			fields: {
				...JIRA_ISSUE.fields,
				description: {
					type: "doc",
					version: 1,
					content: [
						{
							type: "heading",
							content: [{ type: "text", text: "Big Picture" }],
						},
						{
							type: "paragraph",
							content: [
								{ type: "text", text: "Set up the repo." },
							],
						},
					],
				},
			},
		};
		const parsed = parsePMItemFromGetOutput(wrap(issue));
		expect(parsed.title).toBe("Initial Git Setup");
		expect(parsed.description).toBe("Big Picture\n\nSet up the repo.");
	});
});

describe("parsePMItemFromGetOutput — existing providers still parse (regression)", () => {
	it("ADO System.* fields", () => {
		const ado = {
			fields: {
				"System.Title": "ADO Item",
				"System.Description": "<p>desc</p>",
				"System.State": "Active",
			},
			tags: ["a", "b"],
		};
		const parsed = parsePMItemFromGetOutput(wrap(ado));
		expect(parsed.title).toBe("ADO Item");
		expect(parsed.description).toBe("<p>desc</p>");
		expect(parsed.labels).toEqual(["a", "b"]);
	});

	it("Fizzy top-level fields + column object", () => {
		const fizzy = {
			title: "Fizzy Card",
			description: "card body",
			column: { id: "col-2", name: "Doing" },
			labels: ["x"],
		};
		const parsed = parsePMItemFromGetOutput(wrap(fizzy));
		expect(parsed.title).toBe("Fizzy Card");
		expect(parsed.description).toBe("card body");
		expect(parsed.columnName).toBe("Doing");
		expect(parsed.columnId).toBe("col-2");
		expect(parsed.labels).toEqual(["x"]);
	});
});
