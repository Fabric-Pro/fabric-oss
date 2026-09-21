/**
 * `buildUpdateProjectOperation` is the project write `updateProject` performs,
 * returned un-awaited so `update-project` can batch it with the story
 * sync-base reset when status sync is turned on (Fizzy #2304, spec D1.5).
 *
 * Pinned here: the XOR tenant filter, the `null` → `Prisma.JsonNull`
 * translation for the PM context, pass-through of the status-sync columns,
 * that the builder does NOT await (the batch transaction needs the Prisma
 * promise itself), and that `updateProject` still resolves to the row.
 *
 * Run with: pnpm --filter @repo/database exec vitest run __tests__/build-update-project-operation.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { projectUpdate, JSON_NULL, DB_NULL } = vi.hoisted(() => ({
	projectUpdate: vi.fn(),
	JSON_NULL: Symbol("JsonNull"),
	DB_NULL: Symbol("DbNull"),
}));

vi.mock("../prisma/client", () => ({
	db: { project: { update: projectUpdate } },
	Prisma: { JsonNull: JSON_NULL, DbNull: DB_NULL },
	ProjectMemberRole: { OWNER: "OWNER" },
}));

import {
	buildUpdateProjectOperation,
	updateProject,
} from "../prisma/queries/projects/projects";

const SESSION_AT = new Date("2026-09-21T09:00:00.000Z");

beforeEach(() => {
	projectUpdate.mockReset();
});

describe("buildUpdateProjectOperation", () => {
	it("returns the organization-filtered update itself, un-awaited", () => {
		const pending = { kind: "prisma-promise" };
		projectUpdate.mockReturnValue(pending);

		const op = buildUpdateProjectOperation(
			"proj-1",
			{
				pmStatusSyncEnabled: true,
				pmStatusSyncSessionAt: SESSION_AT,
				pmStatusSyncLastRun: DB_NULL as never,
			},
			"org-1",
		);

		expect(op).toBe(pending);
		expect(projectUpdate).toHaveBeenCalledTimes(1);
		expect(projectUpdate.mock.calls[0][0]).toEqual({
			where: { id: "proj-1", organizationId: "org-1" },
			data: {
				pmStatusSyncEnabled: true,
				pmStatusSyncSessionAt: SESSION_AT,
				pmStatusSyncLastRun: DB_NULL,
			},
		});
	});

	it("filters a personal project on organizationId: null", () => {
		projectUpdate.mockReturnValue({});
		buildUpdateProjectOperation("proj-1", { name: "Renamed" });
		expect(projectUpdate.mock.calls[0][0]).toEqual({
			where: { id: "proj-1", organizationId: null },
			data: { name: "Renamed" },
		});
	});

	it("translates a null PM context to Prisma.JsonNull and passes an object through", () => {
		projectUpdate.mockReturnValue({});
		buildUpdateProjectOperation(
			"proj-1",
			{ projectManagementAdditionalContext: null },
			"org-1",
		);
		expect(projectUpdate.mock.calls[0][0].data).toEqual({
			projectManagementAdditionalContext: JSON_NULL,
		});

		const context = { labelStatusMap: { "workflow::done": "status-done" } };
		buildUpdateProjectOperation(
			"proj-1",
			{ projectManagementAdditionalContext: context },
			"org-1",
		);
		expect(projectUpdate.mock.calls[1][0].data).toEqual({
			projectManagementAdditionalContext: context,
		});
	});
});

describe("updateProject", () => {
	it("awaits the same operation and resolves to the updated row", async () => {
		projectUpdate.mockResolvedValue({ id: "proj-1", name: "Renamed" });
		const row = await updateProject(
			"proj-1",
			"user-1",
			{ name: "Renamed", projectManagementAdditionalContext: null },
			"org-1",
		);
		expect(row).toEqual({ id: "proj-1", name: "Renamed" });
		expect(projectUpdate.mock.calls[0][0]).toEqual({
			where: { id: "proj-1", organizationId: "org-1" },
			data: {
				name: "Renamed",
				projectManagementAdditionalContext: JSON_NULL,
			},
		});
	});
});
