/**
 * `createApprovedRequestGrants`: allow specific later calls without asking
 * again, because the person's yes to an earlier call covered them. One ACTIVE
 * session bound to the run, one already-approved one-shot grant per call, each
 * fingerprinted on the exact call, so a grant opens nothing else.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const sessionCreateMock = vi.fn();

vi.mock("../prisma/client", () => ({
	db: {
		authoritySession: {
			create: (args: unknown) => sessionCreateMock(args),
		},
	},
}));

import {
	authorityRequestFingerprint,
	createApprovedRequestGrants,
} from "../prisma/queries/authority";

const INPUT = {
	userId: "user-1",
	organizationId: "org-1",
	runType: "ORCHESTRATOR" as const,
	runId: "conv-1",
	providerType: "MCP" as const,
	providerKey: "fabric",
	providerDisplayName: "Fabric",
	accessLevel: "WRITE" as const,
	approvalInstructions: "Approved with the workflow's creation",
	calls: [
		{
			toolName: "fabric_publish_workflow",
			requestFingerprint: authorityRequestFingerprint(
				"fabric_publish_workflow",
				{ workflowId: "wf-1" },
			),
		},
		{
			toolName: "fabric_execute_workflow",
			requestFingerprint: authorityRequestFingerprint(
				"fabric_execute_workflow",
				{ workflowId: "wf-1" },
			),
		},
	],
};

beforeEach(() => {
	sessionCreateMock.mockReset();
	sessionCreateMock.mockResolvedValue({ id: "session-1", grants: [] });
});

describe("createApprovedRequestGrants", () => {
	it("creates one ACTIVE session bound to the user, organization and run", async () => {
		await createApprovedRequestGrants(INPUT);

		const [{ data }] = sessionCreateMock.mock.calls[0];
		expect(data).toMatchObject({
			userId: "user-1",
			organizationId: "org-1",
			runType: "ORCHESTRATOR",
			runId: "conv-1",
			status: "ACTIVE",
			approvalInstructions: "Approved with the workflow's creation",
		});
		expect(data.approvedAt).toBeInstanceOf(Date);
		expect(data.expiresAt.getTime()).toBeGreaterThan(Date.now());
	});

	it("creates one approved one-shot grant per call, scoped to that tool and fingerprinted on that call", async () => {
		await createApprovedRequestGrants(INPUT);

		const [{ data }] = sessionCreateMock.mock.calls[0];
		expect(data.grants.create).toHaveLength(2);
		expect(data.grants.create).toEqual([
			expect.objectContaining({
				kind: "REQUEST",
				status: "APPROVED",
				approvedBy: "user-1",
				providerKey: "fabric",
				accessLevel: "WRITE",
				toolScope: ["fabric_publish_workflow"],
				requestFingerprint: INPUT.calls[0].requestFingerprint,
			}),
			expect.objectContaining({
				kind: "REQUEST",
				status: "APPROVED",
				toolScope: ["fabric_execute_workflow"],
				requestFingerprint: INPUT.calls[1].requestFingerprint,
			}),
		]);
	});

	it("keeps a personal-context session out of any organization", async () => {
		const { organizationId: _organizationId, ...personal } = INPUT;

		await createApprovedRequestGrants(personal);

		expect(
			sessionCreateMock.mock.calls[0][0].data.organizationId,
		).toBeNull();
	});

	it("expires the session and its grants together", async () => {
		await createApprovedRequestGrants({ ...INPUT, ttlMinutes: 5 });

		const [{ data }] = sessionCreateMock.mock.calls[0];
		const [grant] = data.grants.create;
		expect(grant.expiresAt).toBe(data.expiresAt);
		expect(data.expiresAt.getTime() - data.approvedAt.getTime()).toBe(
			5 * 60 * 1000,
		);
	});
});
