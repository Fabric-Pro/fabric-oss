import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildProjectKnowledgeSearchQuery } from "../prisma/queries/projects/knowledge-search";

const schema = readFileSync(
	new URL("../prisma/schema.prisma", import.meta.url),
	"utf8",
);

function columnsByTable(): Map<string, Set<string>> {
	const tables = new Map<string, Set<string>>();
	for (const [, body] of schema.matchAll(/^model \w+ \{\n([\s\S]*?)\n\}/gm)) {
		const table = body.match(/@@map\("(\w+)"\)/)?.[1];
		if (!table) {
			continue;
		}
		const fields = body
			.split("\n")
			.map((line) => line.trim().split(/\s+/)[0])
			.filter((name) => /^[a-zA-Z]\w*$/.test(name));
		tables.set(table, new Set(fields));
	}
	return tables;
}

describe("knowledge search SQL against the Prisma schema", () => {
	it("references only columns that exist on the table behind each alias", () => {
		const columns = columnsByTable();
		const { text } = buildProjectKnowledgeSearchQuery({
			projectId: "example-project",
			organizationId: "example-org",
			query: "needle",
			limit: 10,
		});
		const missing: string[] = [];
		let checked = 0;

		for (const branch of text.split(/\n\s*UNION ALL\n/)) {
			const aliases = new Map<string, string>();
			for (const [, table, alias] of branch.matchAll(
				/\b(?:FROM|JOIN)\s+([a-z_]+)\s+([a-z]+)\b/g,
			)) {
				if (columns.has(table)) {
					aliases.set(alias, table);
				}
			}
			for (const [, alias, column] of branch.matchAll(
				/\b([a-z]+)\."(\w+)"/g,
			)) {
				const table = aliases.get(alias);
				if (!table) {
					continue;
				}
				checked += 1;
				if (!columns.get(table)?.has(column)) {
					missing.push(`${table}.${column}`);
				}
			}
		}

		expect(checked).toBeGreaterThan(10);
		expect(missing).toEqual([]);
	});

	it("scopes user stories through the project's hosting organization", () => {
		const { text } = buildProjectKnowledgeSearchQuery({
			projectId: "example-project",
			organizationId: "example-org",
			query: "needle",
			limit: 10,
		});

		expect(text).toContain("FROM user_story s JOIN project p");
		expect(text).toMatch(/p\."organizationId" = \$\d+/);
		expect(text).not.toContain('s."organizationId"');
	});
});
