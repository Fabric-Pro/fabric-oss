import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	credentials: vi.fn(),
	list: vi.fn(),
	warehouses: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	fetchCredentialsByIdAndProviderInTenant: mocks.credentials,
	listWorkflowIntegrationsInTenant: mocks.list,
}));
vi.mock("@repo/integrations", () => ({
	listDatabricksSqlWarehouses: mocks.warehouses,
}));
vi.mock("../../../../../orpc/procedures", () => {
	const builder: Record<string, unknown> = {};
	for (const method of ["use", "route", "input", "output"])
		builder[method] = () => builder;
	builder.handler = (handler: unknown) => ({ handler });
	return {
		tenantProtectedProcedure: builder,
		resolveOrganizationId: (org: unknown) => org,
		Permissions: { WORKSPACE_READ: "workspace.read" },
		requireInputOrgPermission: () => ({}),
	};
});

import {
	listDatabricksSqlConnectionsProcedure,
	listDatabricksSqlWarehousesProcedure,
} from "../list-databricks-sql-warehouses";

type Handler = {
	handler: (args: {
		input: { organizationId: string; integrationId?: string };
		context: { user: { id: string }; session: object };
	}) => Promise<unknown>;
};
const warehouses = (listDatabricksSqlWarehousesProcedure as unknown as Handler)
	.handler;
const connections = (
	listDatabricksSqlConnectionsProcedure as unknown as Handler
).handler;
const args = {
	input: {
		organizationId: "example-org",
		integrationId: "example-shared-connection",
	},
	context: { user: { id: "example-user" }, session: {} },
};
beforeEach(() => {
	vi.clearAllMocks();
	mocks.credentials.mockResolvedValue({
		DATABRICKS_HOST: "https://example.cloud.databricks.com",
	});
	mocks.warehouses.mockResolvedValue([
		{ id: "example-warehouse", name: "Example", state: "RUNNING" },
	]);
});
describe("Databricks SQL discovery authorization", () => {
	it("pins provider, exact shared connection, actor and organization before network discovery", async () => {
		await expect(warehouses(args)).resolves.toEqual({
			warehouses: [
				{ id: "example-warehouse", name: "Example", state: "RUNNING" },
			],
		});
		expect(mocks.credentials).toHaveBeenCalledExactlyOnceWith(
			"example-shared-connection",
			"DATABRICKS_SQL",
			"example-user",
			"example-org",
		);
	});
	it.each(["cross-org", "wrong-provider", "unshared", "revoked"])(
		"refuses %s connections without sending credentials",
		async () => {
			mocks.credentials.mockResolvedValue(null);
			await expect(warehouses(args)).rejects.toMatchObject({
				code: "NOT_FOUND",
			});
			expect(mocks.warehouses).not.toHaveBeenCalled();
		},
	);
	it("does not expose provider error bodies", async () => {
		mocks.warehouses.mockRejectedValue(new Error("example-secret"));
		await expect(warehouses(args)).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message:
				"Could not load warehouses. Check this connection's Databricks permissions.",
		});
	});
	it("lists own and explicitly shared connections through the tenant access helper, returning no credential data", async () => {
		mocks.list.mockResolvedValue([
			{
				id: "own",
				name: "Mine",
				userId: "example-user",
				credentials: "example-secret",
			},
			{
				id: "shared",
				name: "Team",
				userId: "example-colleague",
				credentials: "example-secret",
			},
		]);
		await expect(connections(args)).resolves.toEqual({
			connections: [
				{ id: "own", name: "Mine", shared: false },
				{ id: "shared", name: "Team", shared: true },
			],
		});
		expect(mocks.list).toHaveBeenCalledExactlyOnceWith({
			userId: "example-user",
			organizationId: "example-org",
			provider: "DATABRICKS_SQL",
		});
	});
});
