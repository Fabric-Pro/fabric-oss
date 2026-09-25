/**
 * The six migrations behind proposal pull requests (Fizzy #2563, spec
 * §4.5, §12), pinned at the SQL the deploy runs.
 *
 * The split is the contract, not a style choice. The trigger value is alone
 * so it commits before anything can use it; the enums and columns are one
 * additive, metadata-only file with no backfill and no index; and each index
 * on the existing snapshot table is its own single-statement `CONCURRENTLY`
 * migration, because a concurrent build cannot run inside a transaction and
 * a blocking one would lock the table (PR 1 convention,
 * `20260923130100_instruction_snapshot_sync_run_key_idx`). No `IF NOT
 * EXISTS`: after a failed concurrent build the clause would skip the rebuild
 * and record the migration as applied over an invalid index. The sixth adds
 * the Refresh cooldown's admission time, again one metadata-only column.
 *
 * The set itself is pinned too: every migration whose SQL touches this
 * feature's schema must be one of the six, so a seventh cannot land here
 * without this file saying what it may do.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	MIGRATIONS_DIR,
	splitStatements,
	stripSqlNoise,
} from "../scripts/lint-migrations";

const TRIGGER = "20260924210000_instruction_sync_trigger_pull_request_merged";
const COLUMNS = "20260924210100_instruction_proposal_pull_requests";
const INDEXES = [
	[
		"20260924210200_instruction_snapshot_pr_operation_id_key",
		"project_instruction_snapshot_pullRequestOperationId_key",
		true,
	],
	[
		"20260924210300_instruction_snapshot_pr_due_idx",
		"project_instruction_snapshot_pr_due_idx",
		false,
	],
	[
		"20260924210400_instruction_snapshot_pr_confirmation_due_idx",
		"project_instruction_snapshot_pr_confirmation_due_idx",
		false,
	],
] as const;
const REFRESH_ADMITTED_AT =
	"20260924210500_instruction_snapshot_pr_refresh_admitted_at";

/** Every migration of the feature, in the order the deploy applies them. */
const FEATURE_MIGRATIONS = [
	TRIGGER,
	COLUMNS,
	...INDEXES.map(([migration]) => migration),
	REFRESH_ADMITTED_AT,
];

/**
 * Identifiers only this feature's schema carries, matched in executable SQL
 * (comments removed, literals kept): its enums, the trigger value, the
 * snapshot's proposal and pull-request columns, its index names and the
 * sync row's reader opt-in.
 */
const FEATURE_SCHEMA =
	/'PULL_REQUEST_MERGED'|"ProjectInstructionProposalDestination"|"ProjectInstructionPullRequestState"|"proposalDestination"|"proposalNote"|"allowReaderProposals"|"mergeSync[A-Za-z]*"|"project_instruction_snapshot_pr_[a-z_]+"|"project_instruction_snapshot_pullRequestOperationId_key"|"pullRequest(?:Attempt|Attempts|Context|HeadSha|Ref|State|OperationId|Failure|Observation|LastCheckedAt|NextAttemptAt|ObligationOpen|ConfirmationDueAt|RefreshAdmittedAt|ExternalId)"/;

function readMigration(name: string): string {
	return readFileSync(join(MIGRATIONS_DIR, name, "migration.sql"), "utf8");
}

/** The executable statements, comments removed, literals kept. */
function statements(name: string): string[] {
	const raw = readMigration(name);
	const withoutComments = raw
		.split("\n")
		.map((line) => line.replace(/--.*$/, ""))
		.join("\n");
	// Count on the noise-stripped text (a `;` inside a literal never splits),
	// then read the matching spans of the comment-free original.
	const counted = splitStatements(stripSqlNoise(raw));
	const parts = withoutComments
		.split(";")
		.map((part) => part.replace(/\s+/g, " ").trim())
		.filter((part) => part !== "");
	expect(parts).toHaveLength(counted.length);
	return parts;
}

/** A migration's SQL without its comments, string literals kept. */
function executable(name: string): string {
	return readMigration(name)
		.replace(/\/\*[\s\S]*?\*\//g, " ")
		.split("\n")
		.map((line) => line.replace(/--.*$/, ""))
		.join("\n");
}

describe("proposal pull-request migrations (spec §4.5)", () => {
	it("are exactly these six: no other migration touches the feature's schema", () => {
		const touching = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.filter((name) => {
				try {
					return FEATURE_SCHEMA.test(executable(name));
				} catch {
					return false; // a directory without a migration.sql
				}
			})
			.sort();

		expect(touching).toEqual(FEATURE_MIGRATIONS);
	});

	it("adds the PULL_REQUEST_MERGED trigger alone, so it commits before any use", () => {
		expect(statements(TRIGGER)).toEqual([
			`ALTER TYPE "ProjectInstructionSyncTrigger" ADD VALUE 'PULL_REQUEST_MERGED'`,
		]);
	});

	describe("the column migration", () => {
		const sql = statements(COLUMNS).join(";\n");

		it("creates both enum types", () => {
			expect(sql).toMatch(
				/CREATE TYPE "ProjectInstructionProposalDestination" AS ENUM \('FABRIC', 'REPOSITORY'\)/,
			);
			expect(sql).toMatch(
				/CREATE TYPE "ProjectInstructionPullRequestState" AS ENUM \('QUEUED', 'OPENING', 'OPEN', 'CLOSE_REQUESTED', 'MERGED', 'CLOSED', 'BLOCKED', 'CANCELED'\)/,
			);
		});

		it("adds MERGED and CLOSED to the proposal status with ADD VALUE", () => {
			expect(sql).toMatch(
				/ALTER TYPE "ProjectInstructionProposalStatus" ADD VALUE 'MERGED'/,
			);
			expect(sql).toMatch(
				/ALTER TYPE "ProjectInstructionProposalStatus" ADD VALUE 'CLOSED'/,
			);
		});

		it.each([
			[
				"proposalDestination",
				`"proposalDestination" "ProjectInstructionProposalDestination" NOT NULL DEFAULT 'FABRIC'`,
			],
			[
				"pullRequestAttempt",
				`"pullRequestAttempt" INTEGER NOT NULL DEFAULT 0`,
			],
			[
				"pullRequestObligationOpen",
				`"pullRequestObligationOpen" BOOLEAN NOT NULL DEFAULT false`,
			],
			[
				"allowReaderProposals",
				`"allowReaderProposals" BOOLEAN NOT NULL DEFAULT false`,
			],
		])(
			"declares %s with a constant default (metadata-only)",
			(_, column) => {
				expect(sql).toContain(column);
			},
		);

		it.each([
			`"proposalNote" JSONB`,
			`"pullRequestOperationId" TEXT`,
			`"pullRequestState" "ProjectInstructionPullRequestState"`,
			`"pullRequestContext" JSONB`,
			`"pullRequestHeadSha" TEXT`,
			`"pullRequestRef" TEXT`,
			`"pullRequestAttempts" JSONB[] DEFAULT ARRAY[]::JSONB[]`,
			`"pullRequestUrl" TEXT`,
			`"pullRequestExternalId" TEXT`,
			`"pullRequestObservation" JSONB`,
			`"pullRequestFailure" JSONB`,
			`"pullRequestLastCheckedAt" TIMESTAMP(3)`,
			`"pullRequestNextAttemptAt" TIMESTAMP(3)`,
			`"pullRequestConfirmationDueAt" TIMESTAMP(3)`,
			`"mergeSyncRequestedAt" TIMESTAMP(3)`,
			`"mergeSyncDispatchedAt" TIMESTAMP(3)`,
			`"mergeSyncRunId" TEXT`,
			`"mergeSyncExpected" JSONB`,
		])("adds %s", (column) => {
			expect(sql).toContain(`ADD COLUMN ${column}`);
		});

		it("builds no index, so the snapshot table is never locked for one", () => {
			expect(sql).not.toMatch(/\bINDEX\b/i);
		});

		it("writes no rows: no backfill", () => {
			expect(sql).not.toMatch(/\bUPDATE\b/i);
			expect(sql).not.toMatch(/\bINSERT\b/i);
		});
	});

	it.each(INDEXES)(
		"%s is one CREATE INDEX CONCURRENTLY named %s, without IF NOT EXISTS",
		(migration, indexName, unique) => {
			const parts = statements(migration);
			expect(parts).toHaveLength(1);
			const [statement] = parts;
			expect(statement).toMatch(
				new RegExp(
					`^CREATE ${unique ? "UNIQUE " : ""}INDEX CONCURRENTLY "${indexName}" ON "project_instruction_snapshot"`,
				),
			);
			expect(statement).not.toMatch(/IF NOT EXISTS/i);
		},
	);

	describe("the refresh admission migration", () => {
		it("adds pullRequestRefreshAdmittedAt as one nullable column with no default: metadata-only", () => {
			expect(statements(REFRESH_ADMITTED_AT)).toEqual([
				`ALTER TABLE "project_instruction_snapshot" ADD COLUMN "pullRequestRefreshAdmittedAt" TIMESTAMP(3)`,
			]);
		});

		it("builds no index, writes no rows and drops or rewrites nothing", () => {
			const sql = statements(REFRESH_ADMITTED_AT).join(";\n");
			expect(sql).not.toMatch(/\bINDEX\b/i);
			expect(sql).not.toMatch(/\b(?:UPDATE|INSERT|DELETE)\b/i);
			expect(sql).not.toMatch(
				/\b(?:DROP|RENAME|TRUNCATE|ALTER COLUMN)\b|NOT NULL|DEFAULT/i,
			);
		});
	});

	it("names the indexes exactly as the schema maps them, within 63 characters (R18)", () => {
		const schema = readFileSync(
			join(MIGRATIONS_DIR, "..", "schema.prisma"),
			"utf8",
		);
		for (const [, indexName] of INDEXES) {
			expect(indexName.length).toBeLessThanOrEqual(63);
			expect(schema).toContain(`map: "${indexName}"`);
		}
	});
});
