import { createHash } from "node:crypto";
import { call, os } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
	userApiKey: { findFirst: vi.fn() },
	organizationApiKey: { findFirst: vi.fn(), update: vi.fn() },
	member: { findFirst: vi.fn() },
	agent: { findFirst: vi.fn() },
}));

vi.mock("../../../../database/prisma/client", () => ({ db }));
vi.mock("@repo/database", async () => ({
	db,
	...(await import(
		"../../../../database/prisma/queries/organization-api-keys"
	)),
	...(await import(
		"../../../../database/prisma/queries/organization-permissions"
	)),
	getAiProviderApiKey: vi.fn(async () => ({ provider: "OPENAI_DIRECT" })),
	getModelForTask: vi.fn(async () => ({
		model: { canonicalName: "example-model" },
		source: "org_override",
	})),
}));
vi.mock("../../../orpc/procedures", async () => ({
	publicProcedure: os,
	...(await import("@repo/permissions")),
	requirePermission: () => os.middleware(({ next }) => next()),
}));
vi.mock("../lib/model-resolver", () => ({
	resolveModelForTenant: vi.fn(async () => ({
		provider: "OPENAI_DIRECT",
		providerModelId: "example-model",
		modelString: "openai/example-model",
		apiKey: "example-provider-key",
		source: "org_override",
	})),
}));

import { resolveModelForAgentProcedure } from "../../ai-config/procedures/resolution/resolve-for-agent";
import { getAgentProcedure } from "../procedures/get-agent";
import { resolveModelProcedure } from "../procedures/resolve-model";
import { resolveTenantProcedure } from "../procedures/resolve-tenant";

const apiKey = "org_example_example-secret";
const options = { context: { headers: new Headers() } };
const keyHash = createHash("sha256").update(apiKey).digest("hex");
const identity = {
	id: "example-key",
	organizationId: "example-org",
	createdByUserId: "example-user",
};

describe.each([
	{
		name: "resolve-model",
		run: () =>
			call(resolveModelProcedure, { apiKey, taskType: "CHAT" }, options),
		scope: "ai:models:resolve",
		validRole: "member",
		demotedRole: "viewer",
		output: { apiKey: "example-provider-key" },
	},
	{
		name: "get-agent",
		run: () =>
			call(
				getAgentProcedure,
				{ apiKey, agentId: "example-agent" },
				options,
			),
		scope: "agents:read",
		validRole: "viewer",
		// All recognized organization roles grant AGENT_READ.
		demotedRole: "unrecognized-role",
		output: { agentId: "example-agent" },
	},
	{
		name: "resolve-tenant",
		run: () =>
			call(
				resolveTenantProcedure,
				{
					apiKey,
					requiredScopes: ["agents:execute"],
				},
				options,
			),
		scope: "agents:execute",
		validRole: "member",
		demotedRole: "viewer",
		output: { organizationId: "example-org", userId: "example-user" },
	},
	{
		name: "resolve-for-agent",
		run: () =>
			call(
				resolveModelForAgentProcedure,
				{ apiKey, taskType: "CHAT" },
				options,
			),
		scope: "ai:models:read",
		validRole: "member",
		demotedRole: "viewer",
		output: {
			organizationId: "example-org",
			providerModelId: "example-model",
		},
	},
])(
	"$name organization key authorization",
	({ run, scope, validRole, demotedRole, output }) => {
		let role: string | null;
		let scopes: string[];
		let isActive: boolean;
		let expiresAt: Date | null;

		beforeEach(() => {
			vi.resetAllMocks();
			role = validRole;
			scopes = [scope];
			isActive = true;
			expiresAt = null;
			db.member.findFirst.mockImplementation(async ({ where }) =>
				where.organizationId === identity.organizationId &&
				where.userId === identity.createdByUserId &&
				role
					? { id: "example-member", role }
					: null,
			);
			db.organizationApiKey.update.mockResolvedValue({});
			db.organizationApiKey.findFirst.mockImplementation(
				async ({ where }) => {
					const cutoff = where.OR?.[1]?.expiresAt.gt;
					return where.keyHash === keyHash &&
						(where.isActive === undefined ||
							where.isActive === isActive) &&
						(!cutoff || !expiresAt || expiresAt > cutoff)
						? { ...identity, scopes }
						: null;
				},
			);
			db.agent.findFirst.mockResolvedValue({
				id: "example-agent-row",
				agentId: "example-agent",
				name: "example-agent",
				displayName: "Example Agent",
				description: null,
				framework: "example-framework",
				deploymentUrl: null,
				status: "ACTIVE",
				scope: "ORGANIZATION",
				config: null,
				metadata: null,
			});
		});

		it("refuses a key whose creator left its organization", async () => {
			role = null;
			await expect(run()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
			expect(db.organizationApiKey.update).not.toHaveBeenCalled();
		});

		it("refuses an inactive key", async () => {
			isActive = false;
			await expect(run()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		});

		it("refuses an expired key", async () => {
			expiresAt = new Date(0);
			await expect(run()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		});

		it.each(["declared scope", "wildcard"])(
			"refuses a creator without live permission with %s",
			async (scopeKind) => {
				role = demotedRole;
				if (scopeKind === "wildcard") {
					scopes = ["*"];
				}
				await expect(run()).rejects.toMatchObject({
					code: "FORBIDDEN",
					message: expect.stringContaining("required permission"),
				});
			},
		);

		it("reports missing scope before checking live permission", async () => {
			scopes = [];
			role = demotedRole;
			await expect(run()).rejects.toMatchObject({
				code: "FORBIDDEN",
				message: expect.stringMatching(/scope/),
			});
		});

		it("accepts a member with the declared scope and a future expiry", async () => {
			role = "member";
			expiresAt = new Date(Date.now() + 60_000);
			await expect(run()).resolves.toMatchObject(output);
		});

		it.each(["declared scope", "wildcard"])(
			"accepts an authorized creator with %s and records one use",
			async (scopeKind) => {
				if (scopeKind === "wildcard") {
					scopes = ["*"];
				}
				await expect(run()).resolves.toMatchObject(output);
				expect(
					db.organizationApiKey.update,
				).toHaveBeenCalledExactlyOnceWith({
					where: { id: identity.id },
					data: {
						lastUsedAt: expect.any(Date),
						usageCount: { increment: 1 },
					},
				});
			},
		);
	},
);
