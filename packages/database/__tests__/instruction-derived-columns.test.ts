/**
 * The three columns that make a snapshot DERIVED, pinned at the schema, the
 * generated client and the migration that creates them.
 *
 * `baseVersion` exists because `baseSnapshotId` cannot answer "was this
 * snapshot derived?". That column is `ON DELETE SET NULL`, and a READY
 * derived snapshot no longer pins its base — so the base can be deleted or
 * pruned between READY and the publish activity, nulling the id. A publish
 * that read itself as a full upload there would fall back to the version rule
 * and revert whatever had taken the pointer in the meantime. `baseVersion` is
 * written once at derive time and nothing in the lifecycle clears it, which is
 * the whole reason it is a separate, unreferenced column rather than a lookup.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	ProjectInstructionSnapshotScalarFieldEnumSchema,
	ProjectInstructionSnapshotSchema,
} from "../prisma/zod";

const schema = readFileSync(
	resolve(__dirname, "../prisma/schema.prisma"),
	"utf8",
);

const migration = readFileSync(
	resolve(
		__dirname,
		"../prisma/migrations/20260917160000_instruction_derived_snapshot_columns/migration.sql",
	),
	"utf8",
);

function modelBlock(name: string): string {
	const m = schema.match(new RegExp(`model ${name} \\{[\\s\\S]*?\\n\\}`));
	if (!m) {
		throw new Error(`model ${name} not found`);
	}
	return m[0];
}

describe("ProjectInstructionSnapshot derived-snapshot columns", () => {
	const block = modelBlock("ProjectInstructionSnapshot");

	it.each([
		["baseSnapshotId", "String?"],
		["baseVersion", "Int?"],
	])("declares %s as %s", (field, type) => {
		expect(block).toMatch(
			new RegExp(`\\b${field}\\s+${type.replace("?", "\\?")}`),
		);
	});

	it("keeps baseVersion out of the self-relation, so no lifecycle can clear it", () => {
		// The relation names `baseSnapshotId` alone. A version number is a
		// value, not a reference: giving it a foreign key would hand it the
		// same `SetNull` that made the id unusable as the discriminator.
		expect(block).toMatch(
			/baseSnapshot\s+ProjectInstructionSnapshot\?\s+@relation\("DerivedInstructionSnapshots", fields: \[baseSnapshotId\]/,
		);
		expect(block).not.toMatch(/fields: \[baseVersion\]/);
	});

	it("exposes both columns on the generated client", () => {
		expect(ProjectInstructionSnapshotScalarFieldEnumSchema.options).toEqual(
			expect.arrayContaining(["baseSnapshotId", "baseVersion"]),
		);
	});

	it("types baseVersion as an optional integer", () => {
		const field = ProjectInstructionSnapshotSchema.shape.baseVersion;
		expect(field.safeParse(7).success).toBe(true);
		// Nullable: every row that predates the feature, and every upload.
		expect(field.safeParse(null).success).toBe(true);
		expect(field.safeParse("7").success).toBe(false);
		expect(field.safeParse(7.5).success).toBe(false);
	});

	it("adds baseVersion in the same additive migration, nullable and unconstrained", () => {
		expect(migration).toContain(
			'ALTER TABLE "project_instruction_snapshot" ADD COLUMN "baseVersion" INTEGER;',
		);
		// Additive and backward compatible: no backfill to run, and the
		// previous app version — which writes none of these columns — keeps
		// working against the migrated database.
		const statement = migration
			.split("\n")
			.find((line) => line.includes('ADD COLUMN "baseVersion"'));
		expect(statement).not.toMatch(/NOT NULL|DEFAULT|REFERENCES/);
	});
});
