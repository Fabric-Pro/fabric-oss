import { type AnyProcedure, call, os } from "@orpc/server";
import {
	createOrganizationContext,
	createPersonalContext,
	getTenantContext,
	runWithTenantContext,
} from "@repo/database/src/tenant-context";
import { Permissions } from "@repo/permissions";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	membership: vi.fn(),
	preferences: vi.fn(),
	update: vi.fn(),
	page: vi.fn(),
	search: vi.fn(),
	removePattern: vi.fn(),
	deleteRow: vi.fn(),
	deleteVector: vi.fn(),
}));
vi.mock("@repo/database", async () => ({
	...(await import("@repo/database/src/tenant-context")),
	db: {},
	grantProjectAccess: vi.fn(),
	getOrganizationMembership: mocks.membership,
	getOrchestratorMemoryPreferences: mocks.preferences,
	updateOrchestratorMemoryPreferences: mocks.update,
	getEpisodesPage: mocks.page,
	searchEpisodicMemories: mocks.search,
	removeLearnedPattern: mocks.removePattern,
	deleteEpisodicMemory: mocks.deleteRow,
}));
vi.mock("@repo/rag/lib/vector-store/episodic-memory-store", () => ({
	deleteEpisodeEmbedding: mocks.deleteVector,
}));
vi.mock("@repo/logs", () => ({ logger: { warn: vi.fn() } }));
vi.mock("../../../../orpc/procedures", async () => {
	const permission = await import(
		"../../../../orpc/middleware/require-permission"
	);
	return {
		tenantProtectedProcedure: os.$context<{
			user: { id: string };
			session: { activeOrganizationId: string | null };
		}>(),
		Permissions,
		requirePermission: permission.requirePermission,
		requireInputOrgPermission: permission.requireInputOrgPermission,
		resolveOrganizationId: (
			input: string | null | undefined,
			session: { activeOrganizationId: string | null },
		) =>
			input === undefined
				? (session.activeOrganizationId ?? undefined)
				: (input ?? undefined),
	};
});

import {
	clearLearnedPatterns,
	deleteEpisode,
	deletePattern,
	getEpisodes,
	getPreferences,
	searchEpisodes,
	updatePreferences,
} from "../memory-preferences";

const procedures = {
	clearLearnedPatterns,
	deleteEpisode,
	deletePattern,
	getEpisodes,
	getPreferences,
	searchEpisodes,
	updatePreferences,
};

const userId = "example-user";
const sessionOrg = "example-session-org";
const pageOrg = "example-page-org";
const observations: Array<{
	requested: string | null;
	actual: string | null;
	userId: string | null;
}> = [];
function canRead(user: string, organizationId: string | undefined) {
	const tenant = getTenantContext();
	observations.push({
		requested: organizationId ?? null,
		actual: tenant.organizationId,
		userId: tenant.userId,
	});
	return (
		tenant.userId === user &&
		tenant.organizationId === (organizationId ?? null)
	);
}
function invoke(
	procedure: AnyProcedure,
	input: Record<string, unknown>,
	activeOrganizationId: string | null = sessionOrg,
) {
	const tenantContext = activeOrganizationId
		? createOrganizationContext(activeOrganizationId, userId)
		: createPersonalContext(userId);
	return runWithTenantContext(tenantContext, () =>
		call(procedure, input, {
			context: {
				user: { id: userId },
				session: { activeOrganizationId },
				tenantContext,
				activeOrganizationRole: "owner",
			},
		}),
	);
}

beforeEach(() => {
	vi.resetAllMocks();
	observations.length = 0;
	mocks.membership.mockResolvedValue({
		role: "owner",
		organization: { deletedAt: null },
	});
	mocks.preferences.mockImplementation(async (user, org) =>
		canRead(user, org)
			? { responseStyle: "concise", preferences: {} }
			: { preferences: {} },
	);
	mocks.update.mockImplementation(async (user, org) => {
		if (!canRead(user, org)) {
			throw new Error("Memory write has conflicting tenant context");
		}
		return { responseStyle: "concise", preferences: {} };
	});
	mocks.page.mockImplementation(async (user, org) =>
		canRead(user, org)
			? { episodes: [{ id: "example-episode" }], total: 1 }
			: { episodes: [], total: 0 },
	);
	mocks.search.mockImplementation(async ({ userId, organizationId }) =>
		canRead(userId, organizationId) ? [{ id: "example-episode" }] : [],
	);
	mocks.removePattern.mockImplementation(async (user, org) => {
		canRead(user, org);
	});
	mocks.deleteRow.mockImplementation(async (_id, user, org) =>
		canRead(user, org),
	);
	mocks.deleteVector.mockResolvedValue(true);
});

const cases = [
	{
		name: "getPreferences",
		input: {},
		result: {
			preferences: { responseStyle: "concise", preferences: {} },
			isDefault: false,
		},
	},
	{
		name: "updatePreferences",
		input: { responseStyle: "concise" },
		result: {
			success: true,
			preferences: { responseStyle: "concise", preferences: {} },
		},
	},
	{
		name: "clearLearnedPatterns",
		input: {},
		result: { success: true, message: "Learned patterns cleared" },
	},
	{
		name: "getEpisodes",
		input: { limit: 10, offset: 0 },
		result: { episodes: [{ id: "example-episode" }], total: 1 },
	},
	{
		name: "searchEpisodes",
		input: { query: "example" },
		result: { episodes: [{ id: "example-episode" }], query: "example" },
	},
	{
		name: "deletePattern",
		input: { pattern: "Use examples" },
		result: { success: true, message: "Pattern deleted" },
	},
	{
		name: "deleteEpisode",
		input: { episodeId: "example-episode" },
		result: { success: true, message: "Episode deleted" },
	},
] as const;

describe.each(cases)(
	"$name organization resolution",
	({ name, input, result }) => {
		it("uses the page organization's rows when the member's session names another organization", async () => {
			expect(
				await invoke(procedures[name], {
					...input,
					organizationId: pageOrg,
				}),
			).toEqual(result);
			expect(mocks.membership).toHaveBeenCalledWith(pageOrg, userId);
			expect(observations).toEqual([
				{ requested: pageOrg, actual: pageOrg, userId },
			]);
			expect(getTenantContext().type).toBe("none");
		});

		it("refuses a non-member before querying memory", async () => {
			mocks.membership.mockResolvedValue(null);
			await expect(
				invoke(procedures[name], { ...input, organizationId: pageOrg }),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(observations).toEqual([]);
			expect(mocks.deleteVector).not.toHaveBeenCalled();
		});

		it("rechecks membership when the page and session name the same organization", async () => {
			mocks.membership.mockResolvedValue(null);
			await expect(
				invoke(procedures[name], {
					...input,
					organizationId: sessionOrg,
				}),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(observations).toEqual([]);
		});

		it("checks permissions against the target organization's role", async () => {
			mocks.membership.mockResolvedValue({
				role: "viewer",
				organization: { deletedAt: null },
			});
			const request = invoke(procedures[name], {
				...input,
				organizationId: pageOrg,
			});
			if (
				name === "getPreferences" ||
				name === "getEpisodes" ||
				name === "searchEpisodes"
			) {
				expect(await request).toEqual(result);
				expect(observations).toEqual([
					{ requested: pageOrg, actual: pageOrg, userId },
				]);
			} else {
				await expect(request).rejects.toMatchObject({
					code: "FORBIDDEN",
				});
				expect(observations).toEqual([]);
			}
		});

		it("uses the verified page organization with an empty session pointer", async () => {
			expect(
				await invoke(
					procedures[name],
					{ ...input, organizationId: pageOrg },
					null,
				),
			).toEqual(result);
			expect(mocks.membership).toHaveBeenCalledWith(pageOrg, userId);
			expect(observations).toEqual([
				{ requested: pageOrg, actual: pageOrg, userId },
			]);
		});

		it("aligns an explicit organization-less request with its null filter", async () => {
			expect(
				await invoke(procedures[name], {
					...input,
					organizationId: null,
				}),
			).toEqual(result);
			expect(mocks.membership).not.toHaveBeenCalled();
			expect(observations).toEqual([
				{ requested: null, actual: null, userId },
			]);
		});
	},
);
