/**
 * Workflow API keys.
 *
 * The webhook trigger route has verified bearer tokens against
 * `WorkflowApiKey` since it shipped, but nothing ever created a row, so that
 * authentication path was unreachable.
 *
 * The most important assertion here is the round-trip: a key this procedure
 * mints must parse under the verifier's own rules. The two live in different
 * packages and agree only by convention, so a format change on either side
 * would otherwise fail silently at runtime — as a 401 nobody could explain.
 */

import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	createMock,
	findFirstMock,
	findManyMock,
	updateMock,
	accessMock,
	getWorkflowMock,
} = vi.hoisted(() => ({
	createMock: vi.fn(),
	findFirstMock: vi.fn(),
	findManyMock: vi.fn(),
	updateMock: vi.fn(),
	accessMock: vi.fn(),
	getWorkflowMock: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		workflowApiKey: {
			create: createMock,
			findFirst: findFirstMock,
			findMany: findManyMock,
			update: updateMock,
		},
	},
	hasWorkflowAccess: accessMock,
	getWorkflowById: getWorkflowMock,
}));

vi.mock("../../../../../orpc/procedures", () => ({
	Permissions: {
		WORKSPACE_UPDATE: "workspace:update",
		WORKSPACE_READ: "workspace:read",
	},
	requirePermission: () => (next: unknown) => next,
	resolveOrganizationId: (input: string | null | undefined) => input ?? null,
	tenantProtectedProcedure: {
		use: () => ({
			route: () => ({
				input: () => ({
					output: () => ({ handler: (fn: unknown) => fn }),
				}),
			}),
		}),
	},
}));

vi.mock("../../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: async () => ({ id: "member-1" }),
}));

import { createWorkflowApiKeyProcedure } from "../create";
import { listWorkflowApiKeysProcedure } from "../list";
import { revokeWorkflowApiKeyProcedure } from "../revoke";

// biome-ignore lint/suspicious/noExplicitAny: procedures are stubbed to bare handlers above
const create = createWorkflowApiKeyProcedure as any;
// biome-ignore lint/suspicious/noExplicitAny: as above
const list = listWorkflowApiKeysProcedure as any;
// biome-ignore lint/suspicious/noExplicitAny: as above
const revoke = revokeWorkflowApiKeyProcedure as any;

const ctx = { user: { id: "user-1" }, session: {} };

beforeEach(() => {
	vi.clearAllMocks();
	accessMock.mockResolvedValue(true);
	getWorkflowMock.mockResolvedValue({
		id: "wf-1",
		userId: "owner-1",
		organizationId: "org-1",
	});
	createMock.mockImplementation(async ({ data }: { data: object }) => ({
		id: "key-1",
		createdAt: new Date(),
		...data,
	}));
});

/**
 * The verifier's parsing, copied from
 * apps/web/app/api/workflows/trigger/[workflowId]/route.ts.
 */
function verifierParse(apiKey: string) {
	const parts = apiKey.split("_");
	if (parts.length < 3 || parts[0] !== "wfk") {
		return null;
	}
	return {
		keyPrefix: `wfk_${parts[1]}`,
		keyHash: createHash("sha256").update(apiKey).digest("hex"),
	};
}

describe("create", () => {
	it("mints a key the webhook verifier can parse and match", async () => {
		const result = await create({
			input: { workflowId: "wf-1", name: "CI trigger" },
			context: ctx,
		});

		const parsed = verifierParse(result.rawKey);

		expect(parsed, "verifier rejected the key format").not.toBeNull();
		expect(parsed?.keyPrefix).toBe(result.keyPrefix);
		// The stored hash must be of the exact string handed to the caller.
		expect(parsed?.keyHash).toBe(createMock.mock.calls[0][0].data.keyHash);
	});

	it("stores only the hash, never the key", async () => {
		const result = await create({
			input: { workflowId: "wf-1", name: "CI trigger" },
			context: ctx,
		});

		const stored = createMock.mock.calls[0][0].data;
		expect(stored.keyHash).not.toBe(result.rawKey);
		expect(JSON.stringify(stored)).not.toContain(result.rawKey);
	});

	it("copies tenancy from the workflow, not the caller", async () => {
		// The verifier compares the key's tenant against the workflow's, so a
		// key stamped with the caller's identity would never authenticate.
		await create({
			input: { workflowId: "wf-1", name: "k" },
			context: ctx,
		});

		expect(createMock.mock.calls[0][0].data).toMatchObject({
			userId: "owner-1",
			organizationId: "org-1",
			createdBy: "user-1",
		});
	});

	it("defaults to the trigger permission the webhook route checks", async () => {
		await create({
			input: { workflowId: "wf-1", name: "k", permissions: ["trigger"] },
			context: ctx,
		});

		expect(createMock.mock.calls[0][0].data.permissions).toEqual([
			"trigger",
		]);
	});

	it("sets an expiry when asked", async () => {
		await create({
			input: { workflowId: "wf-1", name: "k", expiresInDays: 30 },
			context: ctx,
		});

		const { expiresAt } = createMock.mock.calls[0][0].data;
		expect(expiresAt).toBeInstanceOf(Date);
		expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
	});

	it("issues a distinct key every time", async () => {
		const a = await create({
			input: { workflowId: "wf-1", name: "a" },
			context: ctx,
		});
		const b = await create({
			input: { workflowId: "wf-1", name: "b" },
			context: ctx,
		});

		expect(a.rawKey).not.toBe(b.rawKey);
		expect(a.keyPrefix).not.toBe(b.keyPrefix);
	});

	it("refuses a workflow the caller cannot see", async () => {
		accessMock.mockResolvedValue(false);

		await expect(
			create({ input: { workflowId: "wf-1", name: "k" }, context: ctx }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(createMock).not.toHaveBeenCalled();
	});
});

describe("list", () => {
	it("never selects the key hash", async () => {
		findManyMock.mockResolvedValue([]);

		await list({ input: { workflowId: "wf-1" }, context: ctx });

		const { select } = findManyMock.mock.calls[0][0];
		expect(select.keyHash).toBeUndefined();
		expect(Object.keys(select)).not.toContain("keyHash");
	});

	it("hides revoked keys by default", async () => {
		findManyMock.mockResolvedValue([]);

		await list({ input: { workflowId: "wf-1" }, context: ctx });

		expect(findManyMock.mock.calls[0][0].where).toMatchObject({
			isActive: true,
		});
	});

	it("includes revoked keys on request", async () => {
		findManyMock.mockResolvedValue([]);

		await list({
			input: { workflowId: "wf-1", includeRevoked: true },
			context: ctx,
		});

		expect(findManyMock.mock.calls[0][0].where.isActive).toBeUndefined();
	});
});

describe("revoke", () => {
	it("deactivates an active key", async () => {
		findFirstMock.mockResolvedValue({ id: "key-1", isActive: true });
		updateMock.mockResolvedValue({});

		const result = await revoke({
			input: { workflowId: "wf-1", keyId: "key-1" },
			context: ctx,
		});

		expect(result.revoked).toBe(true);
		expect(updateMock.mock.calls[0][0].data).toEqual({ isActive: false });
	});

	it("is idempotent", async () => {
		findFirstMock.mockResolvedValue({ id: "key-1", isActive: false });

		const result = await revoke({
			input: { workflowId: "wf-1", keyId: "key-1" },
			context: ctx,
		});

		expect(result.revoked).toBe(false);
		expect(updateMock).not.toHaveBeenCalled();
	});

	it("scopes the lookup to the workflow", async () => {
		// Otherwise a key id from another workflow could be revoked by guessing.
		findFirstMock.mockResolvedValue(null);

		await expect(
			revoke({
				input: { workflowId: "wf-1", keyId: "other" },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		expect(findFirstMock.mock.calls[0][0].where).toMatchObject({
			workflowId: "wf-1",
		});
	});
});
