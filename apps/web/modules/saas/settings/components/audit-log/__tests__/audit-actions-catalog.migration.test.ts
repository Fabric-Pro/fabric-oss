import { describe, expect, it } from "vitest";
import { describeActionKey } from "../audit-actions-catalog";

/**
 * The three actions a move of uploaded coding instructions into a repository
 * records (Fizzy #2878 §9), and the one a switch back to upload mode changes.
 * The descriptions are what an operator reads in the log, so they name the
 * values the rows carry; each value below is one the server writes.
 */
describe("the audit descriptions of a move into a repository", () => {
	it.each([
		"canceled",
		"pull_request_closed",
		"switched_to_uploads",
		"integration_disconnected",
		"start_failed",
	])("explains the cancel reason %s", (reason) => {
		expect(
			describeActionKey(
				"project.instructions.repository_migration_canceled",
			),
		).toContain(`\`${reason}\``);
	});

	it("says the cancel row carries the state a move was in when it was ended from outside", () => {
		expect(
			describeActionKey(
				"project.instructions.repository_migration_canceled",
			),
		).toContain("`metadata.state`");
	});

	it.each(["switched", "synced"])(
		"explains the completed stage %s",
		(stage) => {
			expect(
				describeActionKey(
					"project.instructions.repository_migration_completed",
				),
			).toContain(`\`${stage}\``);
		},
	);

	it("says what a switch to upload mode records about the move it ended", () => {
		expect(
			describeActionKey("project.instructions.repository_sync_disabled"),
		).toContain("`metadata.endedMigration`");
	});
});
