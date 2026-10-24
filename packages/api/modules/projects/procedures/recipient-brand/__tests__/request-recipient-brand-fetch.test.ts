/**
 * The recipient website fetch procedure (Fizzy #2946).
 *
 * Everything in front of the attempt runner is real: the project permission
 * decision, the rollout gate read from the project row, and the recipient
 * brand's write gate with its organization member check. The runner is
 * replaced; its behaviour is covered in `lib/__tests__/brand-fetch.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks, world } = vi.hoisted(() => ({
	world: {
		projectMembers: new Map<string, { role: string; acceptedAt: Date }>(),
		orgMembers: new Map<string, string>(),
	},
	mocks: {
		isFeatureEnabled: vi.fn(),
		runRecipientBrandFetch: vi.fn(),
	},
}));

vi.mock("@repo/database", async () => {
	const actual =
		await vi.importActual<typeof import("@repo/database")>(
			"@repo/database",
		);
	return {
		...actual,
		db: {
			project: {
				findUnique: async () => ({
					id: "proj_1",
					organizationId: "org_1",
					userId: "user_editor",
					deletedAt: null,
				}),
			},
			projectMember: {
				findUnique: async ({
					where,
				}: {
					where: { projectId_userId: { userId: string } };
				}) => {
					const row = world.projectMembers.get(
						where.projectId_userId.userId,
					);
					return row ? { ...row, expiresAt: null } : null;
				},
			},
			member: {
				findFirst: async ({ where }: { where: { userId: string } }) => {
					const role = world.orgMembers.get(where.userId);
					return role ? { role } : null;
				},
			},
		},
		grantProjectAccess: vi.fn(),
		isFeatureEnabled: mocks.isFeatureEnabled,
		resolveProjectTenant: async () => ({
			organizationId: "org_1",
			userId: null,
		}),
		hasProjectAccess: async () => true,
		canEditProject: async (_projectId: string, userId: string) =>
			world.orgMembers.get(userId) === "member" ||
			world.projectMembers.get(userId)?.role === "EDITOR",
		isOrganizationMember: async (userId: string) =>
			world.orgMembers.has(userId),
	};
});

vi.mock("@repo/storage", () => ({ getStorageProvider: () => ({}) }));

vi.mock("@repo/config", () => ({
	config: {
		storage: { bucketNames: { projectContexts: "project-contexts" } },
	},
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../../../../lib/brand-fetch", async () => {
	const { z } = await import("zod");
	return {
		brandFetchAttemptSchema: z.object({
			status: z.string(),
			failureCode: z.string().nullable(),
			website: z.string(),
			requestedAt: z.date(),
		}),
		runRecipientBrandFetch: mocks.runRecipientBrandFetch,
	};
});

vi.mock("../../../../../orpc/procedures", async () => {
	const { Permissions } =
		await vi.importActual<typeof import("@repo/permissions")>(
			"@repo/permissions",
		);
	const state: { permission?: string; input?: unknown } = {};
	const chain: Record<string, unknown> = {};
	Object.assign(chain, {
		use: (mw: { __permission?: string }) => {
			state.permission = mw.__permission ?? state.permission;
			return chain;
		},
		route: () => chain,
		input: (schema: unknown) => {
			state.input = schema;
			return chain;
		},
		output: () => chain,
		handler: (fn: unknown) => ({
			__handler: fn,
			__permission: state.permission,
			__input: state.input,
		}),
	});
	return {
		tenantProtectedProcedure: chain,
		requireProjectPermission: (permission: string) => ({
			__permission: permission,
		}),
		Permissions,
	};
});

const { assertProjectPermission } = await vi.importActual<
	typeof import("../../../../../orpc/middleware/require-permission")
>("../../../../../orpc/middleware/require-permission");

import { requestRecipientBrandFetchProcedure } from "../request-recipient-brand-fetch";

const EDITOR = "user_editor";
const GUEST_EDITOR = "user_guest_editor";
const VIEWER = "user_viewer";
const ATTEMPT = {
	status: "SUCCEEDED",
	failureCode: null,
	website: "https://example.com",
	requestedAt: new Date("2026-10-22T10:00:00Z"),
};

type Wired = {
	__handler: (args: {
		input: Record<string, unknown>;
		context: unknown;
		signal?: AbortSignal;
	}) => Promise<Record<string, unknown>>;
	__permission: string;
	__input: { parse: (value: unknown) => Record<string, unknown> };
};

const wired = requestRecipientBrandFetchProcedure as unknown as Wired;

async function call(
	rawInput: Record<string, unknown>,
	userId = EDITOR,
	signal?: AbortSignal,
): Promise<Record<string, unknown>> {
	const input = wired.__input.parse(rawInput);
	await assertProjectPermission(
		input.projectId as string,
		userId,
		wired.__permission as Parameters<typeof assertProjectPermission>[2],
	);
	return wired.__handler({
		input,
		context: {
			user: {
				id: userId,
				name: "Editor",
				email: `${userId}@example.com`,
			},
			session: { id: "session-1", activeOrganizationId: "org_1" },
		},
		signal,
	});
}

async function rejection(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		return (error as { code?: string }).code ?? String(error);
	}
	throw new Error("expected a rejection");
}

beforeEach(() => {
	vi.clearAllMocks();
	world.orgMembers.clear();
	world.projectMembers.clear();
	world.orgMembers.set(EDITOR, "member");
	world.projectMembers.set(GUEST_EDITOR, {
		role: "EDITOR",
		acceptedAt: new Date("2026-01-01"),
	});
	world.projectMembers.set(VIEWER, {
		role: "VIEWER",
		acceptedAt: new Date("2026-01-01"),
	});
	mocks.isFeatureEnabled.mockResolvedValue(true);
	mocks.runRecipientBrandFetch.mockResolvedValue(ATTEMPT);
});

describe("requestRecipientBrandFetchProcedure", () => {
	it("declares DOCUMENT_UPDATE", () => {
		expect(wired.__permission).toBe("document:update");
	});

	it("a member with edit access runs the fetch in the project's owning organization", async () => {
		const controller = new AbortController();

		const result = await call(
			{ projectId: "proj_1", automatic: true },
			EDITOR,
			controller.signal,
		);

		expect(result).toEqual({ attempt: ATTEMPT });
		expect(mocks.runRecipientBrandFetch).toHaveBeenCalledWith({
			projectId: "proj_1",
			organizationId: "org_1",
			userId: EDITOR,
			automatic: true,
			signal: controller.signal,
			context: expect.objectContaining({
				user: expect.objectContaining({ id: EDITOR }),
			}),
		});
	});

	it("a project guest with an editor role is FORBIDDEN and nothing is fetched", async () => {
		expect(
			await rejection(call({ projectId: "proj_1" }, GUEST_EDITOR)),
		).toBe("FORBIDDEN");
		expect(mocks.runRecipientBrandFetch).not.toHaveBeenCalled();
	});

	it("a viewer is FORBIDDEN and nothing is fetched", async () => {
		expect(await rejection(call({ projectId: "proj_1" }, VIEWER))).toBe(
			"FORBIDDEN",
		);
		expect(mocks.runRecipientBrandFetch).not.toHaveBeenCalled();
	});

	it("with both rollouts off answers NOT_FOUND", async () => {
		mocks.isFeatureEnabled.mockResolvedValue(false);

		expect(await rejection(call({ projectId: "proj_1" }))).toBe(
			"NOT_FOUND",
		);
		expect(mocks.runRecipientBrandFetch).not.toHaveBeenCalled();
	});

	it("accepts no website: the stored one is the only one fetched", async () => {
		await call({
			projectId: "proj_1",
			website: "https://attacker.example.net",
		});

		expect(
			mocks.runRecipientBrandFetch.mock.calls[0]?.[0],
		).not.toHaveProperty("website");
		expect(
			wired.__input.parse({
				projectId: "proj_1",
				website: "https://attacker.example.net",
			}),
		).toEqual({ projectId: "proj_1" });
	});
});
