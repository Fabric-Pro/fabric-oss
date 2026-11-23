/**
 * Living Memory checks that read the effective-permission resolver directly
 * apply the permission gate's reach refusal: an organization role grants
 * nothing on a project the user cannot open.
 *
 *  - `resolveContextSyncAccess` answers such a caller as an unknown project.
 *  - The admission check counts a sync delegate who cannot open the project as
 *    one who lost the permission, as the worker's re-check does.
 */
import { Permissions } from "@repo/permissions";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	resolveEffectiveProjectPermissions: vi.fn(),
	getMemoryWriteAdmissionState: vi.fn(),
	evaluateMemoryWrite: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getMemoryWriteAdmissionState: mocks.getMemoryWriteAdmissionState,
	hasProjectAccess: vi.fn(),
}));
vi.mock("../../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions:
		mocks.resolveEffectiveProjectPermissions,
}));
vi.mock("@repo/temporal/memory-write/evaluate", () => ({
	evaluateMemoryWrite: mocks.evaluateMemoryWrite,
}));

import { resolveContextSyncAccess } from "../../../procedures/contexts/repository-sync/access";
import { validateMemoryWrite } from "../validate-memory-write";

const CONTEXT_PERMISSIONS = [
	Permissions.CONTEXT_READ,
	Permissions.CONTEXT_CREATE,
];

function orgAccess(isVisible: boolean) {
	return {
		source: "org",
		organizationId: "org-example",
		isVisible,
		permissions: CONTEXT_PERMISSIONS,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("resolveContextSyncAccess", () => {
	it("answers NOT_FOUND to an org member who cannot open the project", async () => {
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue(
			orgAccess(false),
		);

		await expect(
			resolveContextSyncAccess(
				"project-example",
				"user-example",
				Permissions.CONTEXT_READ,
			),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("admits the project's creator through the same org role", async () => {
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue(
			orgAccess(true),
		);

		await expect(
			resolveContextSyncAccess(
				"project-example",
				"user-example",
				Permissions.CONTEXT_READ,
			),
		).resolves.toMatchObject({ organizationId: "org-example" });
	});
});

describe("validateMemoryWrite — the sync delegate", () => {
	function judgeWithDelegate(isVisible: boolean) {
		mocks.getMemoryWriteAdmissionState.mockResolvedValue({
			readOnlyMode: false,
			sync: { userId: "user-delegate", repositoryIntegrationId: null },
			target: null,
			instructionRoots: [],
			managedCount: 0,
			managedKeys: [],
		});
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue(
			orgAccess(isVisible),
		);
		mocks.evaluateMemoryWrite.mockReturnValue({ ok: true });
		return validateMemoryWrite({
			projectId: "project-example",
			organizationId: "org-example",
			targetId: "target-example",
			message: "Example",
			entries: [],
		});
	}

	it("does not hold context create when the delegate cannot open the project", async () => {
		await judgeWithDelegate(false);

		expect(mocks.resolveEffectiveProjectPermissions).toHaveBeenCalledWith(
			"project-example",
			"user-delegate",
		);
		expect(mocks.evaluateMemoryWrite.mock.calls[0][0]).toMatchObject({
			delegateHoldsContextCreate: false,
		});
	});

	it("holds context create when the delegate can open the project", async () => {
		await judgeWithDelegate(true);

		expect(mocks.evaluateMemoryWrite.mock.calls[0][0]).toMatchObject({
			delegateHoldsContextCreate: true,
		});
	});
});
