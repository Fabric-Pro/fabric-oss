/**
 * Contract tests for the classifier the personal-context inventory and drop job
 * both read from.
 *
 * The rule that matters here is narrow and was found the expensive way. A row
 * with no organization AND no user is not personal context — it is GLOBAL. The
 * seeded MCP catalog and the system prompt library are exactly that shape, and
 * a sweep written against `organizationId IS NULL` alone takes them with it: on
 * a local database that was seventy-two rows out of the eighty-seven the
 * inventory reported, including forty-six MCP servers and the whole system
 * prompt set.
 *
 * The inventory is what surfaced it, which is why the plan says to read the
 * inventory before running anything. These tests are so the next reader does
 * not have to.
 *
 * The fixture is a hand-written schema rather than the real one: this pins the
 * RULE, and a test that read the live schema would change meaning every time a
 * model was added.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
	personalBearingModels,
	personalWhere,
} from "../../../scripts/lib/personal-context-models";

const SCHEMA = `
model OwnedByAPerson {
  id             String  @id
  organizationId String?
  userId         String?
}

model AlwaysOwned {
  id             String  @id
  organizationId String?
  userId         String
}

model EmptyStringPersonal {
  id             String  @id
  organizationId String  @default("")
  userId         String
}

model NoOwnerColumn {
  id             String  @id
  organizationId String?
}

model OrganizationOnly {
  id             String  @id
  organizationId String
}
`;

function classify() {
	const dir = mkdtempSync(join(tmpdir(), "personal-models-"));
	const path = join(dir, "schema.prisma");
	writeFileSync(path, SCHEMA, "utf8");
	const models = personalBearingModels(path);
	return Object.fromEntries(models.map((m) => [m.name, m]));
}

describe("personalBearingModels", () => {
	it("skips a model that cannot express 'no organization'", () => {
		expect(classify()).not.toHaveProperty("OrganizationOnly");
	});

	it("keeps both encodings — a null and an empty string", () => {
		const models = classify();
		expect(models.OwnedByAPerson.encoding).toBe("null");
		expect(models.EmptyStringPersonal.encoding).toBe("empty-string");
	});

	it("records whether a row can exist with no owner", () => {
		const models = classify();
		expect(models.OwnedByAPerson.userIdNullable).toBe(true);
		expect(models.AlwaysOwned.userIdNullable).toBe(false);
		expect(models.NoOwnerColumn.hasUserId).toBe(false);
	});
});

describe("personalWhere", () => {
	// The regression this file exists for.
	it("excludes ownerless rows where the schema allows them", () => {
		expect(personalWhere(classify().OwnedByAPerson)).toEqual({
			organizationId: null,
			userId: { not: null },
		});
	});

	it("adds no owner predicate where every row already has one", () => {
		// A `{ not: null }` on a non-nullable column is a Prisma validation
		// error, not a harmless extra clause.
		expect(personalWhere(classify().AlwaysOwned)).toEqual({
			organizationId: null,
		});
	});

	it("selects the empty string, which an IS NULL sweep never sees", () => {
		expect(personalWhere(classify().EmptyStringPersonal)).toEqual({
			organizationId: "",
		});
	});
});
