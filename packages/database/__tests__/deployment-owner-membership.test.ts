import { beforeEach, describe, expect, it, vi } from "vitest";

const memberLookup = vi.hoisted(() => ({
	mode: "member" as "member" | "missing" | "error",
	calls: [] as unknown[],
}));
vi.mock("../prisma/client", () => ({
	db: {
		member: {
			findUnique: (args: unknown) => {
				memberLookup.calls.push(args);
				if (memberLookup.mode === "error") {
					throw new Error("lookup failed");
				}
				return Promise.resolve(
					memberLookup.mode === "member"
						? { id: "member-example" }
						: null,
				);
			},
		},
	},
}));

import { isDeploymentOwnerCurrentMember } from "../prisma/queries/agent-deployments/owner-membership";

describe("isDeploymentOwnerCurrentMember", () => {
	beforeEach(() => {
		memberLookup.mode = "member";
		memberLookup.calls = [];
	});

	it("allows a current member using both fields from the deployment", async () => {
		await expect(
			isDeploymentOwnerCurrentMember({
				userId: "owner-example",
				organizationId: "example-org",
			}),
		).resolves.toBe(true);
		expect(memberLookup.calls).toContainEqual({
			where: {
				organizationId_userId: {
					organizationId: "example-org",
					userId: "owner-example",
				},
			},
			select: { id: true },
		});
	});

	it("refuses a removed owner", async () => {
		memberLookup.mode = "missing";
		const result = await isDeploymentOwnerCurrentMember({
			userId: "owner-example",
			organizationId: "example-org",
		});
		expect(result).toBe(false);
	});

	it("propagates an unreadable membership", async () => {
		memberLookup.mode = "error";
		await expect(
			isDeploymentOwnerCurrentMember({
				userId: "owner-example",
				organizationId: "example-org",
			}),
		).rejects.toThrow("lookup failed");
	});

	it("refuses an organization deployment with a missing owner id", async () => {
		await expect(
			isDeploymentOwnerCurrentMember({
				userId: "",
				organizationId: "example-org",
			}),
		).resolves.toBe(false);
		expect(memberLookup.calls).toEqual([]);
	});

	it("preserves personal deployment behavior", async () => {
		await expect(
			isDeploymentOwnerCurrentMember({
				userId: "owner-example",
				organizationId: null,
			}),
		).resolves.toBe(true);
		expect(memberLookup.calls).toEqual([]);
	});
});
