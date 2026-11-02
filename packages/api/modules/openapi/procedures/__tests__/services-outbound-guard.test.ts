import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks } = vi.hoisted(() => ({
	handlers: [] as Array<
		(args: {
			input: Record<string, unknown>;
			context: { user: { id: string } };
		}) => Promise<unknown>
	>,
	mocks: {
		parse: vi.fn(),
		create: vi.fn(),
		update: vi.fn(),
		get: vi.fn(),
		syncTools: vi.fn(),
	},
}));

vi.mock("@repo/database", () => ({
	Prisma: { PrismaClientKnownRequestError: class extends Error {} },
	createOpenAPIService: mocks.create,
	updateOpenAPIService: mocks.update,
	getOpenAPIServiceById: mocks.get,
	syncOpenAPIServiceTools: mocks.syncTools,
	deleteOpenAPIService: vi.fn(),
	getOrganizationById: vi.fn(),
	listOpenAPIServicesForTenant: vi.fn(),
}));

vi.mock("@repo/openapi-tools", () => ({ parseOpenAPISpec: mocks.parse }));
vi.mock("@repo/utils", () => ({ encryptApiKey: vi.fn() }));
vi.mock("../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: vi.fn(),
}));
vi.mock("../../../../orpc/procedures", () => {
	const chainable = {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (handler: (typeof handlers)[number]) => {
			handlers.push(handler);
			return handler;
		},
	};
	return {
		tenantProtectedProcedure: chainable,
		requirePermission: () => ({}),
		Permissions: { ORG_OPENAPI_MANAGE: "manage", ORG_OPENAPI_READ: "read" },
	};
});

await import("../services");

const [onboard, , , update, , sync] = handlers;
const context = { user: { id: "example-user" } };

beforeEach(() => {
	vi.clearAllMocks();
	mocks.parse.mockResolvedValue({
		baseUrl: "https://api.example.com/v1",
		specHash: "example-hash",
		description: null,
		tools: [],
	});
	mocks.get.mockResolvedValue({
		id: "example-service",
		specUrl: "https://example.com/openapi.json",
		baseUrl: "https://api.example.com/v1",
	});
});

describe("OpenAPI service outbound URL guard", () => {
	it.each(["/api/v3", "http://localhost:8000"])(
		"asks for a public base URL when the spec server URL is %s",
		async (baseUrl) => {
			mocks.parse.mockResolvedValueOnce({
				baseUrl,
				specHash: "example-hash",
				tools: [],
			});
			await expect(
				onboard({
					input: {
						specUrl: "https://example.com/openapi.json",
						name: "Example API",
					},
					context,
				}),
			).rejects.toMatchObject({
				code: "BAD_REQUEST",
				message: expect.stringContaining("Supply a public base URL"),
			});
			expect(mocks.create).not.toHaveBeenCalled();
		},
	);

	it.each(["/api/v3", "http://localhost:8000"])(
		"onboards with an explicit public base URL when the spec server URL is %s",
		async (baseUrl) => {
			mocks.parse.mockResolvedValueOnce({
				baseUrl,
				specHash: "example-hash",
				tools: [],
			});
			mocks.create.mockResolvedValueOnce({ id: "example-service" });
			mocks.syncTools.mockResolvedValueOnce([]);
			await onboard({
				input: {
					specUrl: "https://example.com/openapi.json",
					name: "Example API",
					baseUrl: "https://api.example.com/v1",
				},
				context,
			});
			expect(mocks.create).toHaveBeenCalledWith(
				expect.objectContaining({
					baseUrl: "https://api.example.com/v1",
				}),
			);
		},
	);

	it("refuses a private override before onboarding writes", async () => {
		await expect(
			onboard({
				input: {
					specUrl: "https://example.com/openapi.json",
					name: "Example API",
					baseUrl: "http://10.0.0.1",
				},
				context,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.create).not.toHaveBeenCalled();
	});

	it("refuses a private base URL update", async () => {
		await expect(
			update({
				input: { id: "example-service", baseUrl: "http://localhost" },
				context,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.update).not.toHaveBeenCalled();
	});

	it.each(["/api/v3", "http://localhost:8000"])(
		"re-syncs with stored public base URL when the spec server URL is %s",
		async (baseUrl) => {
			mocks.parse.mockResolvedValueOnce({
				baseUrl,
				specHash: "example-hash",
				tools: [],
			});
			mocks.syncTools.mockResolvedValueOnce([]);
			await expect(
				sync({
					input: { id: "example-service" },
					context,
				}),
			).resolves.toMatchObject({ success: true, toolCount: 0 });
			expect(mocks.syncTools).toHaveBeenCalledOnce();
		},
	);

	it("refuses re-sync when the stored execution base URL is private", async () => {
		mocks.get.mockResolvedValueOnce({
			id: "example-service",
			specUrl: "https://example.com/openapi.json",
			baseUrl: "http://127.0.0.1",
		});
		await expect(
			sync({ input: { id: "example-service" }, context }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.syncTools).not.toHaveBeenCalled();
		expect(mocks.update).toHaveBeenLastCalledWith(
			expect.objectContaining({ data: { status: "ERROR" } }),
		);
	});
});
