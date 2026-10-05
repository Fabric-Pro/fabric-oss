import { OAUTH_APP_ROW_NAMES } from "@repo/database/prisma/queries/lib/oauth-app-row";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { member, connection, update, audit, tx } = vi.hoisted(() => {
	const member = vi.fn();
	const connection = vi.fn();
	const update = vi.fn();
	const audit = vi.fn();
	const tx = {
		member: { findFirst: member },
		workflowIntegration: { findFirst: connection, updateMany: update },
	};
	return { member, connection, update, audit, tx };
});
vi.mock("@repo/database", () => ({
	db: { $transaction: async (fn: (value: typeof tx) => unknown) => fn(tx) },
	// Mirrors the real predicate (queries/workflows/integration-access.ts).
	isShareableIntegrationProvider: (provider: string) => provider !== "GITLAB",
	recordAuditTx: audit,
}));

import { setIntegrationUsageScope } from "../integration-sharing";

const actor = { id: "actor", email: "dev@example.com", name: "Example" };
const input = {
	integrationId: "connection-example",
	organizationId: "org-example",
	usageScope: "ORGANIZATION_SHARED" as const,
};
beforeEach(() => {
	vi.clearAllMocks();
	member.mockResolvedValue({ id: "member-example", role: "admin" });
	connection.mockResolvedValue({
		id: input.integrationId,
		userId: actor.id,
		provider: "GMAIL",
		usageScope: "OWNER_ONLY",
		name: "Gmail",
		isActive: true,
	});
	update.mockResolvedValue({ count: 1 });
});
describe("connection sharing consent", () => {
	it("allows a current organization admin to explicitly share their own grant and atomically audits the transition", async () => {
		await setIntegrationUsageScope(input, actor);
		expect(update).toHaveBeenCalled();
		expect(audit).toHaveBeenCalledWith(
			tx,
			expect.objectContaining({
				action: "org.integration.config_updated",
				organizationId: input.organizationId,
				metadata: {
					previousUsageScope: "OWNER_ONLY",
					usageScope: "ORGANIZATION_SHARED",
					provider: "GMAIL",
				},
			}),
		);
	});
	it("does not let an admin publish another member's private grant", async () => {
		connection.mockResolvedValue({
			id: input.integrationId,
			userId: "teammate",
			usageScope: "OWNER_ONLY",
			name: "Gmail",
			isActive: true,
		});
		await expect(setIntegrationUsageScope(input, actor)).rejects.toThrow();
		expect(update).not.toHaveBeenCalled();
	});
	it("does not let an ordinary member share even their own grant", async () => {
		member.mockResolvedValue({ role: "member" });
		await expect(setIntegrationUsageScope(input, actor)).rejects.toThrow();
		expect(update).not.toHaveBeenCalled();
	});
	it("rejects offboarded users before reading a connection", async () => {
		member.mockResolvedValue(null);
		await expect(setIntegrationUsageScope(input, actor)).rejects.toThrow();
		expect(connection).not.toHaveBeenCalled();
	});
	it("allows an admin to revoke an already shared teammate connection", async () => {
		connection.mockResolvedValue({
			id: input.integrationId,
			userId: "teammate",
			usageScope: "ORGANIZATION_SHARED",
			provider: "GMAIL",
			name: "Gmail",
			isActive: true,
		});
		await setIntegrationUsageScope(
			{ ...input, usageScope: "OWNER_ONLY" },
			actor,
		);
		expect(update).toHaveBeenCalled();
	});
	it("lets a demoted connection owner withdraw their own sharing consent", async () => {
		member.mockResolvedValue({ role: "member" });
		connection.mockResolvedValue({
			id: input.integrationId,
			userId: actor.id,
			usageScope: "ORGANIZATION_SHARED",
			provider: "GMAIL",
			name: "Gmail",
			isActive: true,
		});
		await setIntegrationUsageScope(
			{ ...input, usageScope: "OWNER_ONLY" },
			actor,
		);
		expect(update).toHaveBeenCalled();
	});
	it("rejects cross-organization or missing connections", async () => {
		connection.mockImplementation(({ where }) =>
			where.organizationId === "org-other"
				? {
						id: input.integrationId,
						userId: actor.id,
						organizationId: "org-other",
						usageScope: "OWNER_ONLY",
						isActive: true,
					}
				: null,
		);
		await expect(setIntegrationUsageScope(input, actor)).rejects.toThrow();
		expect(update).not.toHaveBeenCalled();
		expect(connection).toHaveBeenCalledWith({
			where: {
				id: input.integrationId,
				organizationId: input.organizationId,
				NOT: { name: { in: OAUTH_APP_ROW_NAMES } },
			},
		});
	});
	it("never shares a personal GitLab connection, even its admin owner's", async () => {
		connection.mockResolvedValue({
			id: input.integrationId,
			userId: actor.id,
			provider: "GITLAB",
			usageScope: "OWNER_ONLY",
			name: "GitLab",
			isActive: true,
		});
		await expect(setIntegrationUsageScope(input, actor)).rejects.toThrow(
			/personal/,
		);
		expect(update).not.toHaveBeenCalled();
		expect(audit).not.toHaveBeenCalled();
	});
	it("still lets a GitLab connection marked shared be withdrawn", async () => {
		connection.mockResolvedValue({
			id: input.integrationId,
			userId: actor.id,
			provider: "GITLAB",
			usageScope: "ORGANIZATION_SHARED",
			name: "GitLab",
			isActive: true,
		});
		await setIntegrationUsageScope(
			{ ...input, usageScope: "OWNER_ONLY" },
			actor,
		);
		expect(update).toHaveBeenCalled();
	});
	it("fails closed when the row changes concurrently before the authorized write", async () => {
		update.mockResolvedValue({ count: 0 });
		await expect(setIntegrationUsageScope(input, actor)).rejects.toThrow();
		expect(audit).not.toHaveBeenCalled();
	});
});
