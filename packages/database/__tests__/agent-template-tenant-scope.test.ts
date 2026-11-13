import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findMany: vi.fn(),
	count: vi.fn(),
	findFirst: vi.fn(),
	findUnique: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: {
		agentTemplate: {
			findMany: mocks.findMany,
			count: mocks.count,
			findFirst: mocks.findFirst,
			findUnique: mocks.findUnique,
		},
	},
}));

import {
	getAgentTemplate,
	getAgentTemplateBySlug,
	listAgentTemplates,
} from "../prisma/queries/agent-templates";

const access = {
	userId: "example-user",
	organizationId: "example-org",
} as const;
const visibleScope = {
	OR: [
		{ scope: "SYSTEM" },
		{ scope: "ORGANIZATION", organizationId: "example-org" },
	],
};
const searchClause = {
	OR: [
		{ name: { contains: "review", mode: "insensitive" } },
		{ displayName: { contains: "review", mode: "insensitive" } },
		{ description: { contains: "review", mode: "insensitive" } },
	],
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.findMany.mockResolvedValue([]);
	mocks.count.mockResolvedValue(0);
	mocks.findFirst.mockResolvedValue(null);
});

describe("listAgentTemplates tenant scope", () => {
	it("keeps the verified tenant predicate when scope narrows the result", async () => {
		await listAgentTemplates({ ...access, scope: "ORGANIZATION" });

		expect(mocks.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					isPublished: true,
					AND: [visibleScope, { scope: "ORGANIZATION" }],
				},
			}),
		);
		expect(mocks.count).toHaveBeenCalledWith({
			where: {
				isPublished: true,
				AND: [visibleScope, { scope: "ORGANIZATION" }],
			},
		});
	});

	it("keeps the verified tenant predicate when search narrows the result", async () => {
		await listAgentTemplates({ ...access, search: "review" });

		expect(mocks.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					isPublished: true,
					AND: [visibleScope, searchClause],
				},
			}),
		);
	});

	it("keeps tenant, scope, and search as independent required clauses", async () => {
		await listAgentTemplates({
			...access,
			scope: "ORGANIZATION",
			search: "review",
		});

		expect(mocks.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					isPublished: true,
					AND: [
						visibleScope,
						{ scope: "ORGANIZATION" },
						searchClause,
					],
				},
			}),
		);
	});

	it("uses only SYSTEM and the caller's USER templates in personal context", async () => {
		await listAgentTemplates({
			userId: "example-user",
			organizationId: null,
		});

		expect(mocks.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					isPublished: true,
					AND: [
						{
							OR: [
								{ scope: "SYSTEM" },
								{ scope: "USER", userId: "example-user" },
							],
						},
					],
				},
			}),
		);
	});
});

describe("single AgentTemplate tenant scope", () => {
	it("combines id-or-slug lookup with SYSTEM or the caller's organization", async () => {
		await getAgentTemplate("example-template", access);

		expect(mocks.findFirst).toHaveBeenCalledWith({
			where: {
				AND: [
					visibleScope,
					{
						OR: [
							{ id: "example-template" },
							{ slug: "example-template" },
						],
					},
				],
			},
		});
	});

	it("combines a slug lookup with the same tenant predicate", async () => {
		await getAgentTemplateBySlug("example-template", access);

		expect(mocks.findFirst).toHaveBeenCalledWith({
			where: {
				AND: [visibleScope, { slug: "example-template" }],
			},
		});
	});

	it("fails closed when an undefined organization reaches the runtime boundary", async () => {
		await getAgentTemplate("example-template", {
			userId: "example-user",
			organizationId: undefined as never,
		});

		expect(mocks.findFirst).toHaveBeenCalledWith({
			where: {
				AND: [
					{ id: { in: [] } },
					{
						OR: [
							{ id: "example-template" },
							{ slug: "example-template" },
						],
					},
				],
			},
		});
	});
});
