/**
 * The integration procedures each declare their own copy of the provider enum.
 * Until they share one constant, this test is what stops them drifting: it
 * compares the COMPLETE value sets against the Prisma schema, so adding a
 * provider to four of five files (or to the schema alone) fails here rather
 * than at runtime with a validation error on one endpoint.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PROCEDURE_DIR = join(
	__dirname,
	"../modules/workflows/procedures/integrations",
);
const SCHEMA_PATH = join(__dirname, "../../database/prisma/schema.prisma");
const FILES = [
	"save-integration.ts",
	"list-integrations.ts",
	"test-connection.ts",
	"test-saved-connection.ts",
	"list-integration-status.ts",
];

function readEnumValues(file: string): string[] {
	const source = readFileSync(join(PROCEDURE_DIR, file), "utf8");
	const block = source.match(
		/const IntegrationTypeEnum = z\.enum\(\[([\s\S]*?)\]\)/,
	);
	if (!block) {
		throw new Error(`${file} does not declare IntegrationTypeEnum`);
	}
	return [...block[1].matchAll(/"([A-Z0-9_]+)"/g)].map((m) => m[1]);
}

function readSchemaProviders(): string[] {
	const schema = readFileSync(SCHEMA_PATH, "utf8");
	const block = schema.match(/enum WorkflowIntegrationProvider \{([^}]*)\}/);
	if (!block) {
		throw new Error("WorkflowIntegrationProvider enum not found in schema");
	}
	return block[1]
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("//"));
}

describe("IntegrationTypeEnum parity", () => {
	// Comparing every file against the schema also proves the files agree with
	// each other, so there is no separate cross-file test.
	it("matches the Prisma WorkflowIntegrationProvider enum", () => {
		const schemaProviders = readSchemaProviders().sort();
		expect(schemaProviders.length).toBeGreaterThan(0);

		for (const file of FILES) {
			expect(
				readEnumValues(file).sort(),
				`${file} does not match the Prisma provider enum`,
			).toEqual(schemaProviders);
		}
	});
});
