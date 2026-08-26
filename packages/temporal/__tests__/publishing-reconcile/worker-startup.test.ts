import { beforeEach, describe, expect, it, vi } from "vitest";

// `vi.hoisted`, for the reason round 2 established on the registration suite:
// vi.mock factories are hoisted above module-scope declarations, so a factory
// referencing a plain `const` throws before a single assertion runs.
const { registerSystemSchedules } = vi.hoisted(() => ({
	registerSystemSchedules: vi.fn(async () => {}),
}));

vi.mock("../../src/schedules", () => ({ registerSystemSchedules }));

import { startWorkerRuntime } from "../../src/worker-startup";

describe("worker startup registers system schedules", () => {
	beforeEach(() => {
		registerSystemSchedules.mockClear();
		registerSystemSchedules.mockImplementation(async () => {});
	});

	it("invokes registerSystemSchedules exactly once when the workers start", async () => {
		const run = vi.fn(async () => {});
		await startWorkerRuntime([{ run }, { run }]);
		expect(registerSystemSchedules).toHaveBeenCalledTimes(1);
		expect(run).toHaveBeenCalledTimes(2);
	});

	it("does not let a registration failure stop the workers polling", async () => {
		registerSystemSchedules.mockImplementation(async () => {
			throw new Error("registration exploded");
		});
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const run = vi.fn(async () => {});
		await expect(startWorkerRuntime([{ run }])).resolves.toBeDefined();
		expect(registerSystemSchedules).toHaveBeenCalledTimes(1);
		expect(run).toHaveBeenCalledTimes(1);
		// The swallow is EXPLICIT and observable. Without this assertion the
		// `.catch` can be replaced by a bare `void ...` and nothing goes red.
		await new Promise((r) => setTimeout(r, 0));
		expect(errors).toHaveBeenCalledWith(
			"[Worker] Failed to register system schedules:",
			"registration exploded",
		);
		errors.mockRestore();
	});
});
