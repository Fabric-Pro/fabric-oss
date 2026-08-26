/**
 * Saved run configurations (mocks C8).
 *
 * Two rules carry the weight, and both are about the picker staying usable:
 * every project always has at least one configuration, and the seeded one cannot
 * be deleted out from under it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
	testRunConfiguration: {
		findMany: vi.fn(),
		findUnique: vi.fn(),
		findFirst: vi.fn(),
		create: vi.fn(),
		update: vi.fn(),
		delete: vi.fn(),
	},
	project: { findUnique: vi.fn() },
}));

vi.mock("../../../client", () => ({ db: dbMock }));

import {
	createRunConfiguration,
	deleteRunConfiguration,
	ensureSystemRunConfiguration,
	SYSTEM_RUN_CONFIGURATION_NAME,
	updateRunConfiguration,
} from "../run-configurations";

beforeEach(() => {
	vi.clearAllMocks();
	dbMock.project.findUnique.mockResolvedValue({
		organizationId: "org1",
		userId: null,
	});
	dbMock.testRunConfiguration.create.mockResolvedValue({ id: "cfg1" });
	dbMock.testRunConfiguration.update.mockResolvedValue({ id: "cfg1" });
	dbMock.testRunConfiguration.findUnique.mockResolvedValue({ id: "cfg1" });
});

describe("ensureSystemRunConfiguration", () => {
	it("creates the seeded row when a project has none", async () => {
		dbMock.testRunConfiguration.findUnique.mockResolvedValueOnce(null);

		await ensureSystemRunConfiguration("p1");

		const created =
			dbMock.testRunConfiguration.create.mock.calls[0][0].data;
		expect(created.name).toBe(SYSTEM_RUN_CONFIGURATION_NAME);
		expect(created.isSystem).toBe(true);
		// All targets null: the seeded configuration IS "whatever the QA policy
		// says", so it keeps following the policy instead of pinning today's
		// values at the moment it happened to be created.
		expect(created.environmentId).toBeUndefined();
		expect(created.browser).toBeUndefined();
	});

	it("copies tenancy from the PROJECT, never from a caller", async () => {
		dbMock.testRunConfiguration.findUnique.mockResolvedValueOnce(null);

		await ensureSystemRunConfiguration("p1");

		expect(
			dbMock.testRunConfiguration.create.mock.calls[0][0].data,
		).toMatchObject({ organizationId: "org1", userId: null });
	});

	it("does not mint a second one when it already exists", async () => {
		dbMock.testRunConfiguration.findUnique.mockResolvedValueOnce({
			id: "cfg1",
			name: SYSTEM_RUN_CONFIGURATION_NAME,
			isSystem: true,
			environmentId: null,
			browser: null,
			resolution: null,
		});

		await ensureSystemRunConfiguration("p1");

		// Seeding happens on READ, so concurrent readers must not each create one.
		expect(dbMock.testRunConfiguration.create).not.toHaveBeenCalled();
	});
});

describe("deleteRunConfiguration", () => {
	it("refuses to delete the seeded configuration", async () => {
		dbMock.testRunConfiguration.findFirst.mockResolvedValue({
			isSystem: true,
		});

		const result = await deleteRunConfiguration({
			projectId: "p1",
			configurationId: "cfg1",
		});

		// It is the guarantee that the picker is never empty; a project with no
		// configuration at all cannot start a run from this surface.
		expect(result).toEqual({ deleted: false, reason: "SYSTEM" });
		expect(dbMock.testRunConfiguration.delete).not.toHaveBeenCalled();
	});

	it("deletes an ordinary one", async () => {
		dbMock.testRunConfiguration.findFirst.mockResolvedValue({
			isSystem: false,
		});

		expect(
			await deleteRunConfiguration({
				projectId: "p1",
				configurationId: "cfg2",
			}),
		).toEqual({ deleted: true });
	});

	it("reports an id from another project as not found, not as forbidden", async () => {
		// The query is scoped by projectId, so a foreign id simply matches
		// nothing — and the caller must not learn that it exists elsewhere.
		dbMock.testRunConfiguration.findFirst.mockResolvedValue(null);

		expect(
			await deleteRunConfiguration({
				projectId: "p1",
				configurationId: "someone-elses",
			}),
		).toEqual({ deleted: false, reason: "NOT_FOUND" });
	});
});

describe("updateRunConfiguration", () => {
	it("ignores a rename of the seeded configuration but applies its targets", async () => {
		// Its name is referred to in copy and holds the picker's first slot; its
		// targets are ordinary settings someone may reasonably want to change.
		dbMock.testRunConfiguration.findFirst.mockResolvedValue({
			isSystem: true,
		});

		await updateRunConfiguration({
			projectId: "p1",
			configurationId: "cfg1",
			name: "Renamed",
			browser: "firefox",
		});

		const data = dbMock.testRunConfiguration.update.mock.calls[0][0].data;
		expect(data.name).toBeUndefined();
		expect(data.browser).toBe("firefox");
	});

	it("applies a rename to an ordinary configuration", async () => {
		dbMock.testRunConfiguration.findFirst.mockResolvedValue({
			isSystem: false,
		});

		await updateRunConfiguration({
			projectId: "p1",
			configurationId: "cfg2",
			name: "Nightly regression",
		});

		expect(
			dbMock.testRunConfiguration.update.mock.calls[0][0].data.name,
		).toBe("Nightly regression");
	});

	it("returns null for an unknown id rather than creating one", async () => {
		dbMock.testRunConfiguration.findFirst.mockResolvedValue(null);

		expect(
			await updateRunConfiguration({
				projectId: "p1",
				configurationId: "nope",
				name: "x",
			}),
		).toBeNull();
		expect(dbMock.testRunConfiguration.update).not.toHaveBeenCalled();
	});
});

describe("createRunConfiguration", () => {
	it("copies tenancy from the project", async () => {
		await createRunConfiguration({
			projectId: "p1",
			name: "Smoke",
			browser: "webkit",
		});

		expect(
			dbMock.testRunConfiguration.create.mock.calls[0][0].data,
		).toMatchObject({
			projectId: "p1",
			name: "Smoke",
			browser: "webkit",
			organizationId: "org1",
		});
	});
});
