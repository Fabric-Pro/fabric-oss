/**
 * `resolveWorkflowIntegrationPreferring`: an organization's designated shared
 * connection comes before the actor's own, but only while it is still an
 * active, shared connection of that provider in the actor's organization.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	member: vi.fn(),
	integration: vi.fn(),
}));

vi.mock("../../../client", () => ({
	db: {
		member: { findFirst: mocks.member },
		workflowIntegration: { findFirst: mocks.integration },
	},
}));

import { resolveWorkflowIntegrationPreferring } from "../integration-access";

const shared = { id: "shared-connection" };
const own = { id: "own-connection" };

beforeEach(() => {
	vi.resetAllMocks();
	mocks.member.mockResolvedValue({ id: "member-1" });
});

describe("resolveWorkflowIntegrationPreferring", () => {
	it("uses the designated shared connection before the actor's own", async () => {
		mocks.integration.mockResolvedValueOnce(shared);

		await expect(
			resolveWorkflowIntegrationPreferring(
				"MICROSOFT_GRAPH",
				"shared-connection",
				"user-1",
				"org-1",
			),
		).resolves.toBe(shared);
		expect(mocks.integration).toHaveBeenCalledTimes(1);
		expect(mocks.integration.mock.calls[0][0].where).toMatchObject({
			id: "shared-connection",
			provider: "MICROSOFT_GRAPH",
			usageScope: "ORGANIZATION_SHARED",
			isActive: true,
			organizationId: "org-1",
		});
	});

	it("falls back to the actor's own connection when the designated one is no longer shared or active", async () => {
		mocks.integration
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(own);

		await expect(
			resolveWorkflowIntegrationPreferring(
				"MICROSOFT_GRAPH",
				"shared-connection",
				"user-1",
				"org-1",
			),
		).resolves.toBe(own);
		expect(mocks.integration.mock.calls[1][0].where).toMatchObject({
			userId: "user-1",
			provider: "MICROSOFT_GRAPH",
		});
	});

	it("uses the actor's own connection when nothing is designated", async () => {
		mocks.integration.mockResolvedValueOnce(own);

		await expect(
			resolveWorkflowIntegrationPreferring(
				"MICROSOFT_GRAPH",
				null,
				"user-1",
				"org-1",
			),
		).resolves.toBe(own);
		expect(mocks.integration).toHaveBeenCalledTimes(1);
		expect(mocks.integration.mock.calls[0][0].where).not.toHaveProperty(
			"id",
		);
	});

	it("gives nobody outside the organization any connection", async () => {
		mocks.member.mockResolvedValue(null);

		await expect(
			resolveWorkflowIntegrationPreferring(
				"MICROSOFT_GRAPH",
				"shared-connection",
				"user-1",
				"org-1",
			),
		).resolves.toBeNull();
		expect(mocks.integration).not.toHaveBeenCalled();
	});
});
