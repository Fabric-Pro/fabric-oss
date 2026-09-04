/**
 * The escalated gate for destructive context-source actions (Fizzy #2355).
 *
 * Three properties matter and each has a test: the flag genuinely reverses the
 * behaviour (it gates a capability REMOVAL, so a broken flag locks people out
 * of something they can do today), an EDITOR is refused, and a PROJECT_ADMIN is
 * allowed. The middleware on the procedures still declares PROJECT_UPDATE — this
 * is the raise on top of it.
 */

import { Permissions } from "@repo/permissions";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { isFeatureEnabledMock, resolveEffectiveMock } = vi.hoisted(() => ({
	isFeatureEnabledMock: vi.fn(),
	resolveEffectiveMock: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	isFeatureEnabled: isFeatureEnabledMock,
}));

vi.mock("../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: resolveEffectiveMock,
}));

import { requireContextSourceAdmin } from "../require-context-source-admin";

const PARAMS = { projectId: "proj_1", userId: "user_1" };

// Mirrors the real matrix: PROJECT_UPDATE is granted from EDITOR up, while
// PROJECT_SETTINGS_EDIT starts at PROJECT_ADMIN (packages/permissions/lib/roles.ts).
const EDITOR_PERMISSIONS = [Permissions.PROJECT_UPDATE];
const PROJECT_ADMIN_PERMISSIONS = [
	Permissions.PROJECT_UPDATE,
	Permissions.PROJECT_SETTINGS_EDIT,
];

describe("requireContextSourceAdmin", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("is inert while the flag is off, and does not even resolve permissions", async () => {
		isFeatureEnabledMock.mockResolvedValue(false);

		await expect(
			requireContextSourceAdmin(PARAMS),
		).resolves.toBeUndefined();

		// Not just "allowed" — the flag short-circuits before any lookup, which
		// is what makes turning it off a true rollback rather than a re-check.
		expect(resolveEffectiveMock).not.toHaveBeenCalled();
	});

	it("refuses an EDITOR once the flag is on", async () => {
		isFeatureEnabledMock.mockResolvedValue(true);
		resolveEffectiveMock.mockResolvedValue({
			permissions: EDITOR_PERMISSIONS,
		});

		await expect(requireContextSourceAdmin(PARAMS)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});

	it("allows a PROJECT_ADMIN", async () => {
		isFeatureEnabledMock.mockResolvedValue(true);
		resolveEffectiveMock.mockResolvedValue({
			permissions: PROJECT_ADMIN_PERMISSIONS,
		});

		await expect(
			requireContextSourceAdmin(PARAMS),
		).resolves.toBeUndefined();
	});

	it("refuses when the resolver returns nothing at all", async () => {
		isFeatureEnabledMock.mockResolvedValue(true);
		resolveEffectiveMock.mockResolvedValue(null);

		// Fail closed: an unresolvable caller is not an admin.
		await expect(requireContextSourceAdmin(PARAMS)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});
});
