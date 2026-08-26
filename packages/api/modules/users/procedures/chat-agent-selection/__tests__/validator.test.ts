/**
 * Validator tests — chat-agent-selection.
 *
 * Mock surface lives at the Prisma `db` boundary (per
 * `fabric/standards/testing/test-writing.md` "mocks at the boundary"):
 * we mock `db.registeredAgent.findMany`, `db.aiModel.findMany`,
 * `db.agentTemplateInstance.findMany`, `db.userCloudProviderConfig.findMany`,
 * and `db.cloudProviderConfig.findMany`. The validator's own helpers
 * (bucketing, schema parse, ordering, error handling) are exercised
 * end-to-end through the public `validatePersistedAgents` function.
 *
 * Real agents are looked up in `RegisteredAgent` (the same table the picker
 * reads via `/agents/registry/list`), keyed by the slug-style
 * `RegisteredAgent.agentId`. RegisteredAgent has no `aiProvider` column,
 * so vendor reachability is NOT a drop reason for real agents — only
 * status, scope, and existence are.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// `vi.mock` is hoisted to the top of the file. Capture the spies we need
// inside `vi.hoisted()` so they exist by the time the factory runs.
const mocks = vi.hoisted(() => ({
	registeredAgentFindMany: vi.fn(),
	aiModelFindMany: vi.fn(),
	agentTemplateInstanceFindMany: vi.fn(),
	userCloudProviderConfigFindMany: vi.fn(),
	cloudProviderConfigFindMany: vi.fn(),
	loggerWarn: vi.fn(),
}));

// Re-export the real Zod schema from @repo/database — only the `db` object
// is mocked. The validator imports both `db` and `PersistedSelectedAgentSchema`
// from `@repo/database`; we keep the schema real so a "schema parse failure"
// test exercises the actual schema, not a stub.
vi.mock("@repo/database", async () => {
	const real =
		await vi.importActual<typeof import("@repo/database")>(
			"@repo/database",
		);
	return {
		...real,
		db: {
			registeredAgent: { findMany: mocks.registeredAgentFindMany },
			aiModel: { findMany: mocks.aiModelFindMany },
			agentTemplateInstance: {
				findMany: mocks.agentTemplateInstanceFindMany,
			},
			userCloudProviderConfig: {
				findMany: mocks.userCloudProviderConfigFindMany,
			},
			cloudProviderConfig: {
				findMany: mocks.cloudProviderConfigFindMany,
			},
		},
	};
});

vi.mock("@repo/logs", () => ({
	logger: {
		warn: mocks.loggerWarn,
		info: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

const {
	registeredAgentFindMany,
	aiModelFindMany,
	agentTemplateInstanceFindMany,
	userCloudProviderConfigFindMany,
	cloudProviderConfigFindMany,
	loggerWarn,
} = mocks;

import { validatePersistedAgents } from "../validator";

const PERSONAL_USER = "user_personal";
const ORG_ID = "org_x";

beforeEach(() => {
	registeredAgentFindMany.mockReset();
	aiModelFindMany.mockReset();
	agentTemplateInstanceFindMany.mockReset();
	userCloudProviderConfigFindMany.mockReset();
	cloudProviderConfigFindMany.mockReset();
	loggerWarn.mockReset();

	// Defaults: no rows; specific tests override per-call.
	registeredAgentFindMany.mockResolvedValue([]);
	aiModelFindMany.mockResolvedValue([]);
	agentTemplateInstanceFindMany.mockResolvedValue([]);
	userCloudProviderConfigFindMany.mockResolvedValue([]);
	cloudProviderConfigFindMany.mockResolvedValue([]);
});

describe("validatePersistedAgents — real agents", () => {
	it("queries RegisteredAgent by the slug-style agentId, not by cuid id", async () => {
		// Regression guard for the original wiring bug: validator queried
		// db.agent by `id`, so SYSTEM/USER/ORG chips were silently dropped
		// because no row matched. The fix is "look at the same table the
		// picker reads, with the same key."
		registeredAgentFindMany.mockResolvedValue([
			{
				agentId: "sidekick",
				scope: "SYSTEM",
				organizationId: null,
				userId: null,
			},
		]);

		const result = await validatePersistedAgents({
			entries: [{ agentId: "sidekick", name: "Sidekick" }],
			userId: PERSONAL_USER,
			organizationId: null,
		});

		expect(registeredAgentFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					agentId: { in: ["sidekick"] },
					status: "ACTIVE",
				}),
			}),
		);
		expect(result.kept).toHaveLength(1);
		expect(result.kept[0]?.agentId).toBe("sidekick");
		expect(result.droppedCount).toBe(0);
	});

	it("keeps an ACTIVE SYSTEM-scope agent unconditionally (matches picker behavior)", async () => {
		registeredAgentFindMany.mockResolvedValue([
			{
				agentId: "sidekick",
				scope: "SYSTEM",
				organizationId: null,
				userId: null,
			},
		]);

		const result = await validatePersistedAgents({
			entries: [{ agentId: "sidekick", name: "Sidekick" }],
			userId: PERSONAL_USER,
			organizationId: null,
		});

		expect(result.kept).toHaveLength(1);
		expect(result.kept[0]?.agentId).toBe("sidekick");
		expect(result.droppedCount).toBe(0);
	});

	it("keeps an ACTIVE personal-scope (USER) agent in personal context", async () => {
		registeredAgentFindMany.mockResolvedValue([
			{
				agentId: "agent_1",
				scope: "USER",
				organizationId: null,
				userId: PERSONAL_USER,
			},
		]);

		const result = await validatePersistedAgents({
			entries: [{ agentId: "agent_1", name: "Helper" }],
			userId: PERSONAL_USER,
			organizationId: null,
		});

		expect(result.kept).toHaveLength(1);
		expect(result.kept[0]?.agentId).toBe("agent_1");
		expect(result.droppedCount).toBe(0);
	});

	it("drops an INACTIVE agent (the where-clause status filter excludes it)", async () => {
		// Mirrors what Prisma would return: the INACTIVE row is filtered
		// out by `status: "ACTIVE"` in the where-clause, so findMany
		// returns an empty list for that id.
		registeredAgentFindMany.mockResolvedValue([]);

		const result = await validatePersistedAgents({
			entries: [{ agentId: "agent_inactive", name: "Helper" }],
			userId: PERSONAL_USER,
			organizationId: null,
		});

		expect(result.kept).toEqual([]);
		expect(result.droppedCount).toBe(1);
	});

	it("drops an org-scoped agent surfaced inside a personal-scope read", async () => {
		registeredAgentFindMany.mockResolvedValue([
			{
				agentId: "agent_org_only",
				scope: "ORGANIZATION",
				organizationId: ORG_ID,
				userId: null,
			},
		]);

		const result = await validatePersistedAgents({
			entries: [{ agentId: "agent_org_only", name: "Org Agent" }],
			userId: PERSONAL_USER,
			organizationId: null,
		});

		expect(result.kept).toEqual([]);
		expect(result.droppedCount).toBe(1);
	});

	it("drops a USER-scope agent that belongs to a different user", async () => {
		registeredAgentFindMany.mockResolvedValue([
			{
				agentId: "agent_other_user",
				scope: "USER",
				organizationId: null,
				userId: "another_user",
			},
		]);

		const result = await validatePersistedAgents({
			entries: [{ agentId: "agent_other_user", name: "Helper" }],
			userId: PERSONAL_USER,
			organizationId: null,
		});

		expect(result.kept).toEqual([]);
		expect(result.droppedCount).toBe(1);
	});

	it("keeps an ORG-scope agent in matching org context", async () => {
		registeredAgentFindMany.mockResolvedValue([
			{
				agentId: "agent_org",
				scope: "ORGANIZATION",
				organizationId: ORG_ID,
				userId: null,
			},
		]);

		const result = await validatePersistedAgents({
			entries: [{ agentId: "agent_org", name: "Team Helper" }],
			userId: PERSONAL_USER,
			organizationId: ORG_ID,
		});

		expect(result.kept).toHaveLength(1);
		expect(result.droppedCount).toBe(0);
	});
});

describe("validatePersistedAgents — model-as-agent", () => {
	it("drops a model that is missing from the catalog", async () => {
		userCloudProviderConfigFindMany.mockResolvedValue([
			{ provider: "OPENAI_DIRECT" },
		]);
		aiModelFindMany.mockResolvedValue([]); // catalog miss

		const result = await validatePersistedAgents({
			entries: [{ agentId: "model:does-not-exist", name: "Phantom" }],
			userId: PERSONAL_USER,
			organizationId: null,
		});

		expect(result.kept).toEqual([]);
		expect(result.droppedCount).toBe(1);
	});

	it("drops a catalog model when the tenant has no provider for the model's vendor", async () => {
		// Catalog has the model, but tenant only has Cohere → vendor mismatch.
		userCloudProviderConfigFindMany.mockResolvedValue([
			{ provider: "COHERE" },
		]);
		aiModelFindMany.mockResolvedValue([
			{ canonicalName: "gpt-4o", vendor: "OpenAI" },
		]);

		const result = await validatePersistedAgents({
			entries: [{ agentId: "model:gpt-4o", name: "GPT-4o" }],
			userId: PERSONAL_USER,
			organizationId: null,
		});

		expect(result.kept).toEqual([]);
		expect(result.droppedCount).toBe(1);
	});

	it("keeps a catalog model when a matching provider is enabled", async () => {
		userCloudProviderConfigFindMany.mockResolvedValue([
			{ provider: "OPENAI_DIRECT" },
		]);
		aiModelFindMany.mockResolvedValue([
			{ canonicalName: "gpt-4o", vendor: "OpenAI" },
		]);

		const result = await validatePersistedAgents({
			entries: [{ agentId: "model:gpt-4o", name: "GPT-4o" }],
			userId: PERSONAL_USER,
			organizationId: null,
		});

		expect(result.kept).toHaveLength(1);
		expect(result.droppedCount).toBe(0);
	});

	it("keeps a model reachable via its provider mapping even when the vendor does not match (e.g. Databricks-served Llama)", async () => {
		// Tenant has ONLY Databricks enabled (no gateway). The model's vendor
		// is "Meta" (no vendor-string match), but it has a DATABRICKS provider
		// mapping — so it is genuinely reachable and must be kept.
		userCloudProviderConfigFindMany.mockResolvedValue([
			{ provider: "DATABRICKS" },
		]);
		aiModelFindMany.mockResolvedValue([
			{
				canonicalName: "llama-3-3-70b",
				vendor: "Meta",
				providerMappings: [{ provider: "DATABRICKS" }],
			},
		]);

		const result = await validatePersistedAgents({
			entries: [
				{ agentId: "model:llama-3-3-70b", name: "Llama 3.3 70B" },
			],
			userId: PERSONAL_USER,
			organizationId: null,
		});

		expect(result.kept).toHaveLength(1);
		expect(result.droppedCount).toBe(0);
	});
});

describe("validatePersistedAgents — template-instance", () => {
	it("drops a template instance when the row is hard-deleted", async () => {
		agentTemplateInstanceFindMany.mockResolvedValue([]); // no row

		const result = await validatePersistedAgents({
			entries: [
				{
					agentId: "template-instance:inst_deleted",
					name: "Old Template",
				},
			],
			userId: PERSONAL_USER,
			organizationId: null,
		});

		expect(result.kept).toEqual([]);
		expect(result.droppedCount).toBe(1);
	});

	it("drops a template instance whose tenant scope does not match the read context", async () => {
		// Instance is org-scoped; reading from personal context.
		agentTemplateInstanceFindMany.mockResolvedValue([
			{ id: "inst_org", userId: "creator", organizationId: ORG_ID },
		]);

		const result = await validatePersistedAgents({
			entries: [
				{ agentId: "template-instance:inst_org", name: "Team Tpl" },
			],
			userId: PERSONAL_USER,
			organizationId: null,
		});

		expect(result.kept).toEqual([]);
		expect(result.droppedCount).toBe(1);
	});

	it("keeps a personal template instance owned by the calling user", async () => {
		agentTemplateInstanceFindMany.mockResolvedValue([
			{
				id: "inst_personal",
				userId: PERSONAL_USER,
				organizationId: null,
			},
		]);

		const result = await validatePersistedAgents({
			entries: [
				{
					agentId: "template-instance:inst_personal",
					name: "My Tpl",
				},
			],
			userId: PERSONAL_USER,
			organizationId: null,
		});

		expect(result.kept).toHaveLength(1);
		expect(result.droppedCount).toBe(0);
	});
});

describe("validatePersistedAgents — history & forward-compat & schema gate", () => {
	it("always drops history: chips (conversation-bound, not user-bound)", async () => {
		const result = await validatePersistedAgents({
			entries: [{ agentId: "history:nexus", name: "Nexus" }],
			userId: PERSONAL_USER,
			organizationId: null,
		});

		expect(result.kept).toEqual([]);
		expect(result.droppedCount).toBe(1);
	});

	it("drops entries with an unknown prefix (forward-compat)", async () => {
		const result = await validatePersistedAgents({
			entries: [{ agentId: "weird:foo", name: "Future" }],
			userId: PERSONAL_USER,
			organizationId: null,
		});

		expect(result.kept).toEqual([]);
		expect(result.droppedCount).toBe(1);
	});

	it("drops entries that fail PersistedSelectedAgentSchema parse", async () => {
		const result = await validatePersistedAgents({
			// Empty agentId fails `z.string().min(1)`; missing name fails too.
			entries: [{ agentId: "" }, { totally: "wrong" }, null, "scalar"],
			userId: PERSONAL_USER,
			organizationId: null,
		});

		expect(result.kept).toEqual([]);
		expect(result.droppedCount).toBe(4);
	});

	it("treats non-array `entries` as empty + droppedCount 0", async () => {
		const result = await validatePersistedAgents({
			entries: { not: "an array" },
			userId: PERSONAL_USER,
			organizationId: null,
		});

		expect(result.kept).toEqual([]);
		expect(result.droppedCount).toBe(0);
	});
});

describe("validatePersistedAgents — mixed array preserves order", () => {
	it("keeps original input order; drops invalid; reports correct droppedCount", async () => {
		userCloudProviderConfigFindMany.mockResolvedValue([
			{ provider: "OPENAI_DIRECT" },
		]);
		registeredAgentFindMany.mockResolvedValue([
			{
				agentId: "agent_keep",
				scope: "USER",
				organizationId: null,
				userId: PERSONAL_USER,
			},
		]);
		aiModelFindMany.mockResolvedValue([
			{ canonicalName: "gpt-4o", vendor: "OpenAI" },
		]);
		agentTemplateInstanceFindMany.mockResolvedValue([]); // template instance dropped

		const result = await validatePersistedAgents({
			entries: [
				{ agentId: "agent_keep", name: "Helper" },
				{ agentId: "model:gpt-4o", name: "GPT-4o" },
				{ agentId: "template-instance:gone", name: "Deleted Tpl" },
				{ agentId: "history:nexus", name: "History" },
				{ agentId: "weird:future", name: "Future Variant" },
			],
			userId: PERSONAL_USER,
			organizationId: null,
		});

		// Two kept (real agent + model), in original order.
		expect(result.kept.map((c) => c.agentId)).toEqual([
			"agent_keep",
			"model:gpt-4o",
		]);
		expect(result.droppedCount).toBe(3);
	});
});

describe("validatePersistedAgents — never throws", () => {
	it("returns { kept: [], droppedCount: 0 } and warns when a downstream query rejects", async () => {
		userCloudProviderConfigFindMany.mockRejectedValue(
			new Error("database is down"),
		);
		registeredAgentFindMany.mockResolvedValue([]);

		const result = await validatePersistedAgents({
			entries: [{ agentId: "agent_x", name: "X" }],
			userId: PERSONAL_USER,
			organizationId: null,
		});

		expect(result).toEqual({ kept: [], droppedCount: 0 });
		expect(loggerWarn).toHaveBeenCalledTimes(1);
	});
});
