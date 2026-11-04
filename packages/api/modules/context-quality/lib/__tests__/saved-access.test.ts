import { Permissions } from "@repo/permissions";
import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	permissions: vi.fn(),
	project: vi.fn(),
	member: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	db: { project: { findFirst: m.project }, member: { findFirst: m.member } },
}));
vi.mock("@repo/rag/lib/context-quality/project-access", () => ({
	resolveEffectiveProjectPermissions: m.permissions,
}));

import { requireSavedEvaluationAccess } from "../saved-access";

const actor = {
	projectId: "example-project",
	organizationId: "example-org",
	userId: "example-user",
};
beforeEach(() => {
	vi.resetAllMocks();
	m.project.mockResolvedValue({ id: actor.projectId });
	m.member.mockResolvedValue({ role: "admin" });
	m.permissions.mockResolvedValue({
		organizationId: actor.organizationId,
		permissions: [
			Permissions.CONTEXT_READ,
			Permissions.PROJECT_UPDATE,
			Permissions.PROJECT_SETTINGS_EDIT,
		],
	});
});
it("requires matching live project tenant even for an administrator", async () => {
	m.permissions.mockResolvedValue({
		organizationId: "example-other",
		permissions: [Permissions.CONTEXT_READ],
	});
	await expect(requireSavedEvaluationAccess(actor)).rejects.toMatchObject({
		code: "FORBIDDEN",
	});
});
it("honors an authoritative project viewer despite organization admin membership", async () => {
	m.permissions.mockResolvedValue({
		organizationId: actor.organizationId,
		permissions: [Permissions.CONTEXT_READ],
	});
	await expect(
		requireSavedEvaluationAccess(actor, "write"),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	await expect(
		requireSavedEvaluationAccess(actor, "configure"),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
});
it("lets invited guests read history but never borrow the organization's machine credentials", async () => {
	m.member.mockResolvedValue(null);
	expect(await requireSavedEvaluationAccess(actor)).toEqual({
		canWrite: false,
		canConfigure: false,
	});
	await expect(
		requireSavedEvaluationAccess(actor, "write"),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
});
it("requires organization admin and project settings permission to approve export", async () => {
	m.member.mockResolvedValue({ role: "member" });
	await expect(
		requireSavedEvaluationAccess(actor, "configure"),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
});
it("refuses soft-deleted organizations", async () => {
	m.permissions.mockResolvedValue({
		organizationId: actor.organizationId,
		organizationDeleted: true,
		permissions: [Permissions.CONTEXT_READ],
	});
	await expect(requireSavedEvaluationAccess(actor)).rejects.toMatchObject({
		code: "FORBIDDEN",
	});
});
