/**
 * The organization website fetch procedure (Fizzy #2946).
 *
 * The permission middleware is the REAL `requireInputOrgPermission`,
 * evaluated against the organization in the input, so a member-role and a
 * cross-organization FORBIDDEN are the gate's own answers. The handler then
 * narrows to admins and owners and reads the rollout gate for that same
 * organization. The attempt runner is replaced; its behaviour is covered in
 * `lib/__tests__/brand-fetch.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		getOrganizationMembership: vi.fn(),
		isFeatureEnabled: vi.fn(),
		runBrandSiteFetch: vi.fn(),
	},
}));

vi.mock("@repo/database", () => ({
	db: {
		project: { findUnique: vi.fn() },
		member: { findFirst: vi.fn() },
		projectMember: { findUnique: vi.fn() },
	},
	grantProjectAccess: vi.fn(),
	getTenantContext: vi.fn(() => ({ effectiveWriteOrgId: undefined })),
	getOrganizationMembership: mocks.getOrganizationMembership,
	isFeatureEnabled: mocks.isFeatureEnabled,
	resolveProjectTenant: vi.fn(),
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
		runBrandSiteFetch: mocks.runBrandSiteFetch,
	};
});

vi.mock("../../../../../orpc/procedures", async () => {
	const { Permissions } =
		await vi.importActual<typeof import("@repo/permissions")>(
			"@repo/permissions",
		);
	const { requireInputOrgPermission } = await vi.importActual<
		typeof import("../../../../../orpc/middleware/require-permission")
	>("../../../../../orpc/middleware/require-permission");
	const state: { middleware?: unknown; input?: unknown } = {};
	const chain: Record<string, unknown> = {};
	Object.assign(chain, {
		use: (mw: unknown) => {
			state.middleware = mw;
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
			__middleware: state.middleware,
			__input: state.input,
		}),
	});
	return {
		tenantProtectedProcedure: chain,
		requireInputOrgPermission,
		Permissions,
	};
});

import { fetchBrandSiteProcedure } from "../fetch-brand-site";

const ORG = "org_1";
const OTHER_ORG = "org_2";
const ATTEMPT = {
	status: "RUNNING",
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
	__middleware: (
		args: { context: unknown; next: () => Promise<unknown> },
		input: unknown,
	) => Promise<unknown>;
	__input: {
		parse: (value: unknown) => Record<string, unknown>;
	};
};

const roles = new Map<string, string>();

function context(userId: string) {
	return {
		user: { id: userId, name: "Admin", email: `${userId}@example.com` },
		session: { id: "session-1", activeOrganizationId: ORG },
		tenantContext: { userId, type: "organization", organizationId: ORG },
	};
}

/** Input validation, the real permission middleware, then the handler. */
async function call(
	rawInput: Record<string, unknown>,
	userId: string,
	signal?: AbortSignal,
): Promise<Record<string, unknown>> {
	const wired = fetchBrandSiteProcedure as unknown as Wired;
	const input = wired.__input.parse(rawInput);
	let output: Record<string, unknown> | undefined;
	await wired.__middleware(
		{
			context: context(userId),
			next: async () => {
				output = await wired.__handler({
					input,
					context: context(userId),
					signal,
				});
				return { output };
			},
		},
		input,
	);
	return output as Record<string, unknown>;
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
	roles.clear();
	roles.set(`${ORG}:user_owner`, "owner");
	roles.set(`${ORG}:user_admin`, "admin");
	roles.set(`${ORG}:user_member`, "member");
	roles.set(`${ORG}:user_viewer`, "viewer");
	roles.set(`${OTHER_ORG}:user_other_admin`, "admin");
	mocks.getOrganizationMembership.mockImplementation(
		async (organizationId: string, userId: string) => {
			const role = roles.get(`${organizationId}:${userId}`);
			return role ? { role, organization: { id: organizationId } } : null;
		},
	);
	mocks.isFeatureEnabled.mockResolvedValue(true);
	mocks.runBrandSiteFetch.mockResolvedValue(ATTEMPT);
});

describe("fetchBrandSiteProcedure", () => {
	it("an admin or owner runs the fetch of the stored website for the requested organization", async () => {
		const controller = new AbortController();

		const result = await call(
			{ organizationId: ORG },
			"user_admin",
			controller.signal,
		);
		await call({ organizationId: ORG, automatic: true }, "user_owner");

		expect(result).toEqual({ attempt: ATTEMPT });
		expect(mocks.runBrandSiteFetch).toHaveBeenNthCalledWith(1, {
			organizationId: ORG,
			userId: "user_admin",
			automatic: false,
			signal: controller.signal,
			context: expect.objectContaining({
				user: expect.objectContaining({ id: "user_admin" }),
			}),
		});
		expect(mocks.runBrandSiteFetch).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ userId: "user_owner", automatic: true }),
		);
	});

	it("a member or viewer is FORBIDDEN and nothing is fetched", async () => {
		expect(
			await rejection(call({ organizationId: ORG }, "user_member")),
		).toBe("FORBIDDEN");
		expect(
			await rejection(call({ organizationId: ORG }, "user_viewer")),
		).toBe("FORBIDDEN");
		expect(mocks.runBrandSiteFetch).not.toHaveBeenCalled();
	});

	it("an admin of another organization is FORBIDDEN", async () => {
		expect(
			await rejection(call({ organizationId: ORG }, "user_other_admin")),
		).toBe("FORBIDDEN");
		expect(mocks.runBrandSiteFetch).not.toHaveBeenCalled();
	});

	it("passes when either rollout is on, and answers NOT_FOUND when both are off", async () => {
		mocks.isFeatureEnabled.mockImplementation(
			async (flag: string) => flag === "PROPOSAL_ARTIFACT",
		);
		expect(await call({ organizationId: ORG }, "user_admin")).toEqual({
			attempt: ATTEMPT,
		});

		mocks.isFeatureEnabled.mockResolvedValue(false);
		expect(
			await rejection(call({ organizationId: ORG }, "user_admin")),
		).toBe("NOT_FOUND");
		expect(mocks.runBrandSiteFetch).toHaveBeenCalledTimes(1);
	});

	it("checks membership before the rollout gate, so a member learns nothing from it", async () => {
		mocks.isFeatureEnabled.mockResolvedValue(false);

		expect(
			await rejection(call({ organizationId: ORG }, "user_member")),
		).toBe("FORBIDDEN");
		expect(mocks.isFeatureEnabled).not.toHaveBeenCalled();
	});

	it("accepts no website: the stored one is the only one fetched", () => {
		const input = (
			fetchBrandSiteProcedure as unknown as Wired
		).__input.parse({
			organizationId: ORG,
			website: "https://attacker.example.net",
		});

		expect(input).toEqual({ organizationId: ORG });
	});
});
