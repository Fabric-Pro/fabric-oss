import { describe, expect, it } from "vitest";
import { kanbanRouter } from "../router";

describe("kanban router", () => {
	it("does not expose the removed webhook procedure", () => {
		expect(kanbanRouter).not.toHaveProperty("webhook");
	});
});
