import { beforeEach, describe, expect, it, vi } from "vitest";

const findFirstMock = vi.fn();
const findManyMock = vi.fn();
vi.mock("../prisma/client", () => ({
	db: {
		workflowIntegration: {
			findFirst: (args: unknown) => findFirstMock(args),
			findMany: (args: unknown) => findManyMock(args),
		},
	},
}));

import {
	getWorkflowIntegrationByIdInTenant,
	listWorkflowIntegrationsInTenant,
} from "../prisma/queries/workflows/integrations";

const integrations = [
	{
		id: "org-integration",
		userId: "member-a",
		organizationId: "org-1",
		isActive: true,
		createdAt: new Date("2026-01-04"),
	},
	{
		id: "member-a-personal",
		userId: "member-a",
		organizationId: null,
		isActive: true,
		createdAt: new Date("2026-01-03"),
	},
	{
		id: "member-b-personal",
		userId: "member-b",
		organizationId: null,
		isActive: true,
		createdAt: new Date("2026-01-02"),
	},
	{
		id: "other-org-integration",
		userId: "member-b",
		organizationId: "org-2",
		isActive: true,
		createdAt: new Date("2026-01-01"),
	},
];

function mockIntegrationList() {
	findManyMock.mockImplementation(
		(args: {
			where: {
				userId?: string;
				organizationId?: string | null;
				isActive?: boolean;
			};
		}) =>
			integrations.filter(
				(integration) =>
					(args.where.userId === undefined ||
						integration.userId === args.where.userId) &&
					integration.organizationId === args.where.organizationId &&
					integration.isActive === args.where.isActive,
			),
	);
}

describe("getWorkflowIntegrationByIdInTenant", () => {
	beforeEach(() => findFirstMock.mockReset());

	it("looks up by organization in org context, without a userId filter", async () => {
		findFirstMock.mockResolvedValue({
			id: "int-1",
			provider: "DATABRICKS_VECTOR_SEARCH",
			userId: "other-user",
			organizationId: "org-1",
			isActive: true,
		});

		const integration = await getWorkflowIntegrationByIdInTenant(
			"int-1",
			"user-1",
			"org-1",
		);

		expect(findFirstMock).toHaveBeenCalledWith({
			where: {
				id: "int-1",
				organizationId: "org-1",
			},
		});
		expect(integration).toMatchObject({ id: "int-1" });
	});

	it("looks up by user in personal context, requiring organizationId: null", async () => {
		findFirstMock.mockResolvedValue({
			id: "int-2",
			provider: "DATABRICKS_VECTOR_SEARCH",
			userId: "user-1",
			organizationId: null,
			isActive: true,
		});

		const integration = await getWorkflowIntegrationByIdInTenant(
			"int-2",
			"user-1",
		);

		expect(findFirstMock).toHaveBeenCalledWith({
			where: {
				id: "int-2",
				userId: "user-1",
				organizationId: null,
			},
		});
		expect(integration).toMatchObject({ id: "int-2" });
	});
});

describe("listWorkflowIntegrationsInTenant", () => {
	beforeEach(() => {
		findManyMock.mockReset();
		mockIntegrationList();
	});

	it("lets one org member list an integration created by another member", async () => {
		const result = await listWorkflowIntegrationsInTenant({
			userId: "member-b",
			organizationId: "org-1",
		});

		expect(findManyMock).toHaveBeenCalledWith({
			where: {
				organizationId: "org-1",
				isActive: true,
			},
			orderBy: { createdAt: "desc" },
		});
		expect(result.map((integration) => integration.id)).toEqual([
			"org-integration",
		]);
	});

	it("keeps personal and organization integrations strictly isolated", async () => {
		const personalResult = await listWorkflowIntegrationsInTenant({
			userId: "member-b",
		});

		expect(findManyMock).toHaveBeenCalledWith({
			where: {
				userId: "member-b",
				organizationId: null,
				isActive: true,
			},
			orderBy: { createdAt: "desc" },
		});
		expect(personalResult.map((integration) => integration.id)).toEqual([
			"member-b-personal",
		]);
	});
});
