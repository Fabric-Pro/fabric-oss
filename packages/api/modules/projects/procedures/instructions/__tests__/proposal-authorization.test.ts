import { Permissions } from "@repo/permissions";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	resolveEffectiveProjectPermissions: vi.fn(),
}));

vi.mock("../../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: (...args: unknown[]) =>
		m.resolveEffectiveProjectPermissions(...args),
}));

import {
	assertInstructionDeriveAccess,
	assertInstructionSnapshotMutationAccess,
	canReviewInstructionProposals,
	isInstructionSnapshotContentReadable,
} from "../proposal-authorization";

beforeEach(() => {
	m.resolveEffectiveProjectPermissions.mockReset();
	m.resolveEffectiveProjectPermissions.mockResolvedValue({
		source: "org",
		organizationId: "org_1",
		permissions: [Permissions.INSTRUCTION_READ],
	});
});

describe("instruction proposal authorization", () => {
	it("serves file content only for direct or approved READY snapshots", () => {
		expect(
			isInstructionSnapshotContentReadable({
				status: "READY",
				proposalStatus: null,
			}),
		).toBe(true);
		expect(
			isInstructionSnapshotContentReadable({
				status: "READY",
				proposalStatus: "APPROVED",
			}),
		).toBe(true);
		for (const proposalStatus of ["PENDING", "REJECTED"] as const) {
			expect(
				isInstructionSnapshotContentReadable({
					status: "READY",
					proposalStatus,
				}),
			).toBe(false);
		}
		expect(
			isInstructionSnapshotContentReadable({
				status: "VALIDATING",
				proposalStatus: null,
			}),
		).toBe(false);
	});

	it("lets a project reader submit a proposal but not create a direct snapshot", async () => {
		await expect(
			assertInstructionDeriveAccess({
				projectId: "project_1",
				userId: "reader_1",
				proposal: true,
			}),
		).resolves.toBeUndefined();
		await expect(
			assertInstructionDeriveAccess({
				projectId: "project_1",
				userId: "reader_1",
				proposal: false,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("lets only the pending proposal owner finish its upload", async () => {
		await expect(
			assertInstructionSnapshotMutationAccess({
				projectId: "project_1",
				userId: "reader_1",
				snapshot: {
					userId: "reader_1",
					proposalStatus: "PENDING",
				},
			}),
		).resolves.toBeUndefined();

		await expect(
			assertInstructionSnapshotMutationAccess({
				projectId: "project_1",
				userId: "reader_2",
				snapshot: {
					userId: "reader_1",
					proposalStatus: "PENDING",
				},
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("keeps direct upload and finalize behind create permission", async () => {
		await expect(
			assertInstructionSnapshotMutationAccess({
				projectId: "project_1",
				userId: "reader_1",
				snapshot: { userId: "reader_1", proposalStatus: null },
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("denies submission after read permission is revoked", async () => {
		m.resolveEffectiveProjectPermissions.mockResolvedValue(null);

		await expect(
			assertInstructionDeriveAccess({
				projectId: "project_1",
				userId: "reader_1",
				proposal: true,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("distinguishes proposal review from reader submission", async () => {
		await expect(
			canReviewInstructionProposals({
				projectId: "project_1",
				userId: "reader_1",
			}),
		).resolves.toBe(false);

		m.resolveEffectiveProjectPermissions.mockResolvedValue({
			source: "project",
			organizationId: "org_1",
			permissions: [Permissions.INSTRUCTION_UPDATE],
		});
		await expect(
			canReviewInstructionProposals({
				projectId: "project_1",
				userId: "editor_1",
			}),
		).resolves.toBe(true);
	});
});
