/** Drives mounted permission middleware and handlers; only the builder and database edges are replaced. */
import { ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MISSING_ORGANIZATION_CONTEXT_ERROR_CODE } from "../../../../../lib/missing-organization-context";

type Handler = (args: {
	input: Record<string, unknown>;
	context: Record<string, unknown>;
}) => Promise<unknown>;
type Middleware = (
	options: { context: Record<string, unknown>; next: () => Promise<unknown> },
	input: unknown,
) => Promise<unknown>;

const mocks = vi.hoisted(() => ({
	createAgent: vi.fn(),
	createRegisteredAgent: vi.fn(),
	registerDynamic: vi.fn(),
	restoreInstanceVersion: vi.fn(),
	findInstance: vi.fn(),
	findRegisteredAgent: vi.fn(),
	getOrganizationMembership: vi.fn(),
	// Capture each procedure separately; the dynamic file also registers refresh.
	procedures: {} as Record<
		string,
		{ middlewares: unknown[]; handler: Handler | null }
	>,
}));

vi.mock("@repo/database", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/database")>()),
	createAgent: mocks.createAgent,
	createRegisteredAgent: mocks.createRegisteredAgent,
	restoreInstanceVersion: mocks.restoreInstanceVersion,
	db: {
		registeredAgent: {
			findFirst: mocks.findRegisteredAgent,
			create: mocks.registerDynamic,
		},
		agentTemplateInstance: { findFirst: mocks.findInstance },
	},
	getOrganizationMembership: mocks.getOrganizationMembership,
}));

vi.mock("../../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: async (
		organizationId: string,
		userId: string,
	) => await mocks.getOrganizationMembership(organizationId, userId),
}));

vi.mock("../../../../../orpc/procedures", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../../../../orpc/procedures")>();
	const startChain = (first: unknown) => {
		const procedure = {
			middlewares: [first] as unknown[],
			handler: null as Handler | null,
		};
		const chain: Record<string, unknown> = {};
		Object.assign(chain, {
			use: (mw: unknown) => {
				procedure.middlewares.push(mw);
				return chain;
			},
			route: (route: { path: string }) => {
				mocks.procedures[route.path] = procedure;
				return chain;
			},
			input: () => chain,
			output: () => chain,
			handler: (fn: Handler) => {
				procedure.handler = fn;
				return { _handler: fn };
			},
		});
		return chain;
	};
	return {
		...actual,
		protectedProcedure: { use: startChain },
		tenantProtectedProcedure: { use: startChain },
	};
});

// Permission denials must throw in this suite; do not silently enable dry run.
expect(process.env.RBAC_DRY_RUN).toBeUndefined();
await import("../create-registered-agent");
await import("../register-dynamic-agent");
await import("../../restore-instance-version");

const USER_ID = "example-user";
const ACTIVE_ORG = "example-active-org";
const TARGET_ORG = "example-target-org";

async function invoke(
	path: string,
	input: Record<string, unknown>,
	activeOrganizationId: string | null = ACTIVE_ORG,
) {
	const procedure = mocks.procedures[path];
	if (!procedure?.handler) {
		throw new Error(`Handler not captured: ${path}`);
	}
	const handler = procedure.handler;
	const context = {
		user: { id: USER_ID, email: "dev@example.com", name: "Dev" },
		session: { id: "example-session", activeOrganizationId },
		activeOrganizationRole: "member",
		tenantContext: {
			userId: USER_ID,
			type: "organization",
			organizationId: activeOrganizationId,
		},
		headers: new Headers(),
	};
	const run = async (index: number): Promise<unknown> => {
		if (index === procedure.middlewares.length) {
			return { output: await handler({ input, context }) };
		}
		return await (procedure.middlewares[index] as Middleware)(
			{ context, next: () => run(index + 1) },
			input,
		);
	};
	return await run(0);
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getOrganizationMembership.mockImplementation(async () => ({
		role: "member",
		organization: { deletedAt: null },
	}));
	mocks.createAgent.mockResolvedValue({
		id: "example-agent",
		agentId: "example-agent",
		status: "ACTIVE",
	});
	mocks.findRegisteredAgent.mockResolvedValue(null);
	mocks.registerDynamic.mockResolvedValue({
		id: "example-agent",
		agentId: "example-agent",
		status: "PENDING",
	});
	mocks.findInstance.mockResolvedValue({
		id: "example-instance",
		sId: "example-stable-id",
		status: "ARCHIVED",
	});
	mocks.restoreInstanceVersion.mockResolvedValue({
		id: "example-restored",
		sId: "example-stable-id",
		version: 2,
		status: "ACTIVE",
		name: "Example",
	});
});

const cases = [
	{
		name: "registry.create",
		path: "/agents/registry/create",
		input: {
			name: "example-agent",
			displayName: "Example agent",
			framework: "CUSTOM",
			scope: "USER",
			validateProtocol: false,
		},
		write: mocks.createAgent,
		data: false,
	},
	{
		name: "registry.registerDynamic",
		path: "/agents/registry/dynamic",
		input: {
			name: "example-agent",
			displayName: "Example agent",
			protocol: "CUSTOM",
			scope: "USER",
			deploymentUrl: "https://example.com/agent",
			skipValidation: true,
		},
		write: mocks.registerDynamic,
		data: true,
	},
	{
		name: "instances.restore",
		path: "/agents/instances/restore",
		input: { instanceId: "example-instance" },
		write: mocks.restoreInstanceVersion,
		data: false,
	},
];

function expectNoWrites() {
	expect(mocks.createAgent).not.toHaveBeenCalled();
	expect(mocks.createRegisteredAgent).not.toHaveBeenCalled();
	expect(mocks.registerDynamic).not.toHaveBeenCalled();
	expect(mocks.restoreInstanceVersion).not.toHaveBeenCalled();
	expect(mocks.findInstance).not.toHaveBeenCalled();
	expect(mocks.findRegisteredAgent).not.toHaveBeenCalled();
}

for (const scenario of cases) {
	describe(`agents.${scenario.name} authorization`, () => {
		it("refuses explicit null organization before database access", async () => {
			mocks.getOrganizationMembership.mockResolvedValue({
				role: "viewer",
				organization: { deletedAt: null },
			});
			await expect(
				invoke(scenario.path, {
					...scenario.input,
					organizationId: null,
				}),
			).rejects.toMatchObject({
				code: "FORBIDDEN",
				data: { errorCode: MISSING_ORGANIZATION_CONTEXT_ERROR_CODE },
			});
			expectNoWrites();
		});
		it("refuses an omitted organization without an active session organization", async () => {
			await expect(
				invoke(scenario.path, scenario.input, null),
			).rejects.toMatchObject({
				code: "FORBIDDEN",
				data: { errorCode: MISSING_ORGANIZATION_CONTEXT_ERROR_CODE },
			});
			expectNoWrites();
		});
		it("refuses a viewer of the target organization", async () => {
			mocks.getOrganizationMembership.mockImplementation(
				async (organizationId: string) => ({
					role: organizationId === TARGET_ORG ? "viewer" : "member",
					organization: { deletedAt: null },
				}),
			);
			await expect(
				invoke(scenario.path, {
					...scenario.input,
					organizationId: TARGET_ORG,
				}),
			).rejects.toMatchObject({
				code: "FORBIDDEN",
				message: expect.stringContaining(
					"Missing required permission:",
				),
			});
			expect(mocks.getOrganizationMembership).toHaveBeenCalledWith(
				TARGET_ORG,
				USER_ID,
			);
			expectNoWrites();
		});
		it("reaches the write for a permitted role in the target organization", async () => {
			if (scenario.name === "instances.restore") {
				mocks.getOrganizationMembership.mockResolvedValue({
					role: "admin",
					organization: { deletedAt: null },
				});
			}
			await invoke(scenario.path, {
				...scenario.input,
				organizationId: TARGET_ORG,
			});
			expect(mocks.getOrganizationMembership).toHaveBeenCalledWith(
				TARGET_ORG,
				USER_ID,
			);
			if (scenario.name === "instances.restore") {
				expect(mocks.findInstance).toHaveBeenCalledWith(
					expect.objectContaining({
						where: {
							id: "example-instance",
							organizationId: TARGET_ORG,
						},
					}),
				);
				expect(scenario.write).toHaveBeenCalledWith("example-instance");
			} else {
				const tenant = expect.objectContaining({
					userId: USER_ID,
					organizationId: TARGET_ORG,
				});
				expect(scenario.write).toHaveBeenCalledWith(
					scenario.data
						? expect.objectContaining({ data: tenant })
						: tenant,
				);
			}
		});
		it("uses the active session organization when input omits it", async () => {
			if (scenario.name === "instances.restore") {
				mocks.getOrganizationMembership.mockResolvedValue({
					role: "admin",
					organization: { deletedAt: null },
				});
			}
			await invoke(scenario.path, scenario.input);
			expect(mocks.getOrganizationMembership).toHaveBeenCalledWith(
				ACTIVE_ORG,
				USER_ID,
			);
			expect(scenario.write).toHaveBeenCalledOnce();
		});
		it("refuses a target organization without membership", async () => {
			mocks.getOrganizationMembership.mockResolvedValue(null);
			await expect(
				invoke(scenario.path, {
					...scenario.input,
					organizationId: TARGET_ORG,
				}),
			).rejects.toBeInstanceOf(ORPCError);
			expectNoWrites();
		});
	});
}
