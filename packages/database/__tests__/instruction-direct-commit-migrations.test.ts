/**
 * The three migrations behind a direct commit to the synced branch (Fizzy
 * #2878 §10), pinned at the SQL the deploy runs.
 *
 * The split is the contract. A value added by `ALTER TYPE ... ADD VALUE`
 * cannot be used in the transaction that adds it, so each of the two new enum
 * values is alone in its own migration and commits before anything can use
 * it. The two columns are one additive, metadata-only statement: nullable, no
 * default, no backfill, no index, so the populated snapshot table is never
 * rewritten or locked for it and the previous app version, which never reads
 * or writes them, is unaffected.
 *
 * The inventory also includes the native Git intent receipt constraint;
 * further migrations naming these identifiers must be added explicitly.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	MIGRATIONS_DIR,
	splitStatements,
	stripSqlNoise,
} from "../scripts/lint-migrations";

const DESTINATION =
	"20261002150000_instruction_proposal_destination_repository_commit";
const TRIGGER = "20261002150100_instruction_sync_trigger_commit_pushed";
const COLUMNS = "20261002150200_instruction_snapshot_direct_commit_columns";
const MIGRATIONS = [
	DESTINATION,
	TRIGGER,
	COLUMNS,
	"20261006110000_instruction_git_intents",
];

const NEW_IDENTIFIERS =
	/'REPOSITORY_COMMIT'|'COMMIT_PUSHED'|"commitContext"|"commitOutcome"/;

function readMigration(name: string): string {
	return readFileSync(join(MIGRATIONS_DIR, name, "migration.sql"), "utf8");
}

/** A migration's SQL without its comments, string literals kept. */
function executable(name: string): string {
	return readMigration(name)
		.replace(/\/\*[\s\S]*?\*\//g, " ")
		.split("\n")
		.map((line) => line.replace(/--.*$/, ""))
		.join("\n");
}

/** The executable statements, comments removed, whitespace collapsed. */
function statements(name: string): string[] {
	const counted = splitStatements(stripSqlNoise(readMigration(name)));
	const parts = executable(name)
		.split(";")
		.map((part) => part.replace(/\s+/g, " ").trim())
		.filter((part) => part !== "");
	expect(parts).toHaveLength(counted.length);
	return parts;
}

describe("direct commit migrations (Fizzy #2878 §10)", () => {
	it("match the explicit inventory: no other migration names the feature's new identifiers", () => {
		const touching = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.filter((name) => {
				try {
					return NEW_IDENTIFIERS.test(executable(name));
				} catch {
					return false; // a directory without a migration.sql
				}
			})
			.sort();

		expect(touching).toEqual(MIGRATIONS);
	});

	it("adds the REPOSITORY_COMMIT destination alone, so it commits before any use", () => {
		expect(statements(DESTINATION)).toEqual([
			`ALTER TYPE "ProjectInstructionProposalDestination" ADD VALUE 'REPOSITORY_COMMIT'`,
		]);
	});

	it("adds the COMMIT_PUSHED trigger alone, so it commits before any use", () => {
		expect(statements(TRIGGER)).toEqual([
			`ALTER TYPE "ProjectInstructionSyncTrigger" ADD VALUE 'COMMIT_PUSHED'`,
		]);
	});

	describe("the column migration", () => {
		const sql = statements(COLUMNS).join(";\n");

		it("is one statement adding exactly two nullable JSONB columns with no default: metadata-only", () => {
			expect(statements(COLUMNS)).toEqual([
				`ALTER TABLE "project_instruction_snapshot" ADD COLUMN "commitContext" JSONB, ADD COLUMN "commitOutcome" JSONB`,
			]);
		});

		it("builds no index, writes no rows and drops or rewrites nothing", () => {
			expect(sql).not.toMatch(/\bINDEX\b/i);
			expect(sql).not.toMatch(/\b(UPDATE|INSERT|DELETE)\b/i);
			expect(sql).not.toMatch(/\b(DROP|SET NOT NULL|DEFAULT|TYPE)\b/i);
		});
	});
});
