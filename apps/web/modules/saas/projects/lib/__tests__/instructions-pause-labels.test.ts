/**
 * The status line says why automatic sync is paused by looking the reason up
 * in `repositorySync.pausedReasons`: a reason the enum gains without a label
 * there would throw as a missing translation on the one screen that shows it.
 * `MIGRATING` is the reason a move of uploaded instructions into a repository
 * gives (Fizzy #2878 §9).
 *
 * The reasons are read from the Prisma schema, the one place that defines
 * them: the generated enum is not exported to the web app.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import en from "@repo/i18n/translations/en.json";
import { describe, expect, it } from "vitest";

const SCHEMA = join(
	__dirname,
	"../../../../../../../packages/database/prisma/schema.prisma",
);

function enumValues(name: string): string[] {
	const block = new RegExp(`enum ${name} \\{([^}]*)\\}`).exec(
		readFileSync(SCHEMA, "utf8"),
	);
	return (block?.[1] ?? "")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "" && !line.startsWith("//"));
}

describe("the reasons automatic repository sync can be paused for", () => {
	it("are found in the schema", () => {
		expect(enumValues("ProjectInstructionSyncPause")).toContain(
			"MIGRATING",
		);
	});

	it("each have a label in the tab's copy", () => {
		const labelled = Object.keys(
			en.projects.codingInstructions.repositorySync.pausedReasons,
		);

		expect([...labelled].sort()).toEqual(
			enumValues("ProjectInstructionSyncPause").sort(),
		);
	});

	it("name the move into a repository as what holds a project's sync", () => {
		expect(
			en.projects.codingInstructions.repositorySync.pausedReasons
				.MIGRATING,
		).toBe("these instructions are being moved into this repository");
	});
});
