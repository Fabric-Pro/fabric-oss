import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({
	health: vi.fn(),
	findAgentByMetadata: vi.fn(),
	createAgent: vi.fn(),
	getAgent: vi.fn(),
}));
const logger = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("@repo/logs", () => ({ logger }));
vi.mock("@repo/letta", async (importOriginal) => ({
	...(await importOriginal<object>()),
	getLettaClient: () => client,
}));

import { LettaError } from "@repo/letta";
import { initializeLettaMemory } from "../src/activities/letta-memory-activities";
import { verifyLettaAgentOwnership } from "../src/activities/letta-security";

beforeEach(() => {
	vi.resetAllMocks();
	vi.stubEnv("LETTA_BASE_URL", "https://memory.example.com");
	client.health.mockResolvedValue({ healthy: true });
	client.findAgentByMetadata.mockResolvedValue(null);
	client.createAgent.mockResolvedValue({ id: "agent-new" });
});
afterEach(() => vi.unstubAllEnvs());

describe("Letta memory tenant binding", () => {
	it("creates memory without an identity endpoint and stamps authoritative metadata", async () => {
		await expect(
			initializeLettaMemory({
				userId: "user-a",
				organizationId: "org-a",
			}),
		).resolves.toEqual({ agentId: "agent-new", isNew: true });
		expect(client.createAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				metadata: expect.objectContaining({
					type: "orchestrator-memory",
					identityType: "org",
					identifierKey: "org-a",
					organizationId: "org-a",
				}),
			}),
		);
		expect(client.createAgent.mock.calls[0]?.[0]).not.toHaveProperty(
			"identityIds",
		);
	});

	it("uses organization metadata without requiring the original creator", async () => {
		client.findAgentByMetadata.mockResolvedValue({ id: "agent-shared" });
		await expect(
			initializeLettaMemory({
				userId: "user-b",
				organizationId: "org-a",
			}),
		).resolves.toEqual({ agentId: "agent-shared", isNew: false });
		expect(client.findAgentByMetadata).toHaveBeenCalledWith({
			type: "orchestrator-memory",
			identityType: "org",
			identifierKey: "org-a",
			organizationId: "org-a",
		});
		expect(client.createAgent).not.toHaveBeenCalled();
	});

	it("does not create after an incomplete or failed lookup", async () => {
		client.findAgentByMetadata.mockRejectedValue(
			new Error("Search incomplete"),
		);
		await expect(
			initializeLettaMemory({
				userId: "user-a",
				organizationId: "org-a",
			}),
		).resolves.toBeNull();
		expect(client.createAgent).not.toHaveBeenCalled();
	});

	it("emits bounded flat initialization diagnostics without provider messages", async () => {
		client.findAgentByMetadata.mockRejectedValue(
			new LettaError(
				"private provider content",
				"LIST_AGENTS_FAILED",
				503,
			),
		);
		await initializeLettaMemory({
			userId: "user-a",
			organizationId: "org-a",
		});
		expect(logger.error).toHaveBeenCalledWith(
			{
				event: "letta.memory.initialization_failed",
				code: "LIST_AGENTS_FAILED",
				httpStatus: 503,
				operation: "initializeLettaMemory",
			},
			"Letta memory initialization failed",
		);
		expect(JSON.stringify(logger.error.mock.calls)).not.toContain(
			"private provider content",
		);
	});

	it.each([
		undefined,
		{},
		{ userId: "user-a" },
		{
			type: "orchestrator-memory",
			identityType: "org",
			identifierKey: "org-b",
			organizationId: "org-b",
		},
		{
			type: "other",
			identityType: "org",
			identifierKey: "org-a",
			organizationId: "org-a",
		},
	])(
		"refuses absent, incomplete and cross-tenant metadata: %j",
		async (metadata) => {
			client.getAgent.mockResolvedValue({ id: "agent-a", metadata });
			await expect(
				verifyLettaAgentOwnership({
					userId: "user-a",
					organizationId: "org-a",
					lettaAgentId: "agent-a",
				}),
			).resolves.toMatchObject({ valid: false });
		},
	);

	it("authorizes shared organization memory for a different member", async () => {
		client.getAgent.mockResolvedValue({
			metadata: {
				type: "orchestrator-memory",
				identityType: "org",
				identifierKey: "org-a",
				organizationId: "org-a",
				userId: "creator-a",
			},
		});
		await expect(
			verifyLettaAgentOwnership({
				userId: "member-b",
				organizationId: "org-a",
				lettaAgentId: "agent-a",
			}),
		).resolves.toEqual({ valid: true });
	});

	it("requires both the legacy personal user and absence of an organization", async () => {
		client.getAgent.mockResolvedValue({
			metadata: {
				type: "orchestrator-memory",
				identityType: "user",
				identifierKey: "user-a",
				userId: "user-a",
				organizationId: "org-a",
			},
		});
		await expect(
			verifyLettaAgentOwnership({
				userId: "user-a",
				lettaAgentId: "agent-a",
			}),
		).resolves.toMatchObject({ valid: false });
	});

	it.each([
		{ owner: "user-a", valid: true },
		{ owner: "user-b", valid: false },
	])("binds legacy personal memory to $owner", async ({ owner, valid }) => {
		client.getAgent.mockResolvedValue({
			metadata: {
				type: "orchestrator-memory",
				identityType: "user",
				identifierKey: owner,
				userId: owner,
			},
		});
		await expect(
			verifyLettaAgentOwnership({
				userId: "user-a",
				lettaAgentId: "agent-a",
			}),
		).resolves.toMatchObject({ valid });
	});
});
