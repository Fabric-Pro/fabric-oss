import { describe, expect, it } from "vitest";
import { syncNowStartedAt, syncNowWorkflowId } from "../sync-now-workflow-id";

describe("Sync now workflow id", () => {
	it("reads back the start time of an id it minted", () => {
		const id = syncNowWorkflowId("proj-1", 1_763_000_000_000);

		expect(syncNowStartedAt(id, "proj-1")).toEqual(
			new Date(1_763_000_000_000),
		);
	});

	it("does not accept another project's run", () => {
		const id = syncNowWorkflowId("proj-2", 1_763_000_000_000);

		expect(syncNowStartedAt(id, "proj-1")).toBeNull();
	});

	it("does not accept a project whose id only starts the same", () => {
		const id = syncNowWorkflowId("proj-1-extra", 1_763_000_000_000);

		expect(syncNowStartedAt(id, "proj-1")).toBeNull();
	});
});
