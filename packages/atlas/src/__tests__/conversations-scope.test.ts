/**
 * Conversation scoping — one shared history across both graph views.
 *
 * Locks the contract: `listConversations` no longer filters by graph mode
 * (legacy BUSINESS and TECHNICAL rows all surface together) while the repo,
 * tenant (XOR), and owner-or-SHARED filters stay exactly as before; new
 * conversations persist the canonical mode value TECHNICAL; and
 * `getConversation` is BOUND to the permission-checked project — a
 * conversation id from a sibling project in the same tenant resolves null.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFindMany = vi.fn();
const mockFindFirst = vi.fn();
const mockCreate = vi.fn();
const mockUserFindMany = vi.fn();

vi.mock("@repo/database", () => ({
	db: {
		atlasConversation: {
			findMany: (...args: unknown[]) => mockFindMany(...args),
			findFirst: (...args: unknown[]) => mockFindFirst(...args),
			create: (...args: unknown[]) => mockCreate(...args),
		},
		user: {
			findMany: (...args: unknown[]) => mockUserFindMany(...args),
		},
	},
	Prisma: {},
}));

vi.mock("@repo/utils", () => ({
	decryptApiKey: vi.fn(),
}));

import {
	createConversation,
	getConversation,
	listConversations,
} from "../queries";

const orgCtx = { userId: "user-1", organizationId: "org-1" };
const personalCtx = { userId: "user-1", organizationId: null };

function makeRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "c1",
		mode: "TECHNICAL",
		title: "How does auth work?",
		visibility: "PRIVATE",
		userId: "user-1",
		updatedAt: new Date("2026-06-01T00:00:00Z"),
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mockUserFindMany.mockResolvedValue([
		{ id: "user-1", name: "User One", email: "one@example.com" },
	]);
});

describe("listConversations — mode-independent history", () => {
	it("does not filter by mode and returns BUSINESS + TECHNICAL rows together", async () => {
		mockFindMany.mockResolvedValue([
			makeRow({ id: "c1", mode: "TECHNICAL" }),
			makeRow({ id: "c2", mode: "BUSINESS" }),
		]);

		const summaries = await listConversations(orgCtx, {
			projectId: "p1",
			repositoryIntegrationId: "int-1",
		});

		const where = mockFindMany.mock.calls[0][0].where;
		expect(where).not.toHaveProperty("mode");
		expect(summaries.map((s) => s.id)).toEqual(["c1", "c2"]);
		expect(summaries.map((s) => s.mode)).toEqual(["TECHNICAL", "BUSINESS"]);
	});

	it("keeps the repo, org-tenant, and owner-or-SHARED filters intact", async () => {
		mockFindMany.mockResolvedValue([]);

		await listConversations(orgCtx, {
			projectId: "p1",
			repositoryIntegrationId: "int-1",
		});

		const where = mockFindMany.mock.calls[0][0].where;
		expect(where.projectId).toBe("p1");
		expect(where.repositoryIntegrationId).toBe("int-1");
		expect(where.organizationId).toBe("org-1");
		expect(where.OR).toEqual([
			{ userId: "user-1" },
			{ visibility: "SHARED" },
		]);
	});

	it("applies the personal XOR tenant filter (organizationId null) outside an org", async () => {
		mockFindMany.mockResolvedValue([]);

		await listConversations(personalCtx, {
			projectId: "p1",
			repositoryIntegrationId: null,
		});

		const where = mockFindMany.mock.calls[0][0].where;
		expect(where.userId).toBe("user-1");
		expect(where.organizationId).toBeNull();
		expect(where.repositoryIntegrationId).toBeNull();
	});
});

describe("createConversation — canonical mode", () => {
	it("writes mode TECHNICAL server-side", async () => {
		mockCreate.mockResolvedValue({
			...makeRow({ mode: "TECHNICAL" }),
			projectId: "p1",
			repositoryIntegrationId: "int-1",
			messages: [],
			createdAt: new Date("2026-06-01T00:00:00Z"),
		});

		const detail = await createConversation(orgCtx, {
			projectId: "p1",
			repositoryIntegrationId: "int-1",
		});

		expect(mockCreate).toHaveBeenCalledWith({
			data: expect.objectContaining({ mode: "TECHNICAL" }),
		});
		expect(detail.mode).toBe("TECHNICAL");
	});
});

describe("getConversation — project binding", () => {
	it("requires BOTH the conversation id and the permission-checked projectId in the WHERE", async () => {
		mockFindFirst.mockResolvedValue({
			...makeRow(),
			projectId: "p1",
			repositoryIntegrationId: "int-1",
			messages: [],
			createdAt: new Date("2026-06-01T00:00:00Z"),
		});

		const detail = await getConversation(orgCtx, {
			conversationId: "c1",
			projectId: "p1",
		});

		expect(mockFindFirst).toHaveBeenCalledWith({
			where: {
				id: "c1",
				projectId: "p1",
				organizationId: "org-1",
			},
		});
		expect(detail?.id).toBe("c1");
	});

	it("resolves null for a conversation id belonging to ANOTHER project (cross-project guard)", async () => {
		// The project-bound WHERE makes the DB return no row for a sibling
		// project's conversation — even a SHARED one in the same tenant.
		mockFindFirst.mockResolvedValue(null);

		const detail = await getConversation(orgCtx, {
			conversationId: "c-other-project",
			projectId: "p1",
		});

		expect(detail).toBeNull();
		expect(mockFindFirst.mock.calls[0][0].where.projectId).toBe("p1");
	});
});
