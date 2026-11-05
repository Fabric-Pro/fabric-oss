import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.hoisted(() => vi.fn());

vi.mock("@repo/database", () => ({
	db: { project: { findUnique } },
}));

import { monitoredProjectExistsActivity } from "../monitored-project";

describe("monitoredProjectExistsActivity", () => {
	beforeEach(() => {
		findUnique.mockReset();
	});

	it("reports a project with a row, which includes a soft-deleted one", async () => {
		findUnique.mockResolvedValue({ id: "proj_1" });

		await expect(
			monitoredProjectExistsActivity({ projectId: "proj_1" }),
		).resolves.toBe(true);
		expect(findUnique).toHaveBeenCalledWith({
			where: { id: "proj_1" },
			select: { id: true },
		});
	});

	it("reports a project with no row as gone", async () => {
		findUnique.mockResolvedValue(null);

		await expect(
			monitoredProjectExistsActivity({ projectId: "proj_1" }),
		).resolves.toBe(false);
	});

	it("throws a database failure instead of reporting the project gone", async () => {
		findUnique.mockRejectedValue(new Error("connection refused"));

		await expect(
			monitoredProjectExistsActivity({ projectId: "proj_1" }),
		).rejects.toThrow("connection refused");
	});
});
