/** Runs the mounted authorization middleware and input schema before each handler. */
import { ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Input = Record<string, unknown>;
type Context = Record<string, unknown>;
type Handler = (args: { input: Input; context: Context }) => Promise<unknown>;
type Middleware = (
	args: { context: Context; next: () => Promise<unknown> },
	input: unknown,
) => Promise<unknown>;
type Procedure = {
	middlewares: Middleware[];
	schema: { parse: (input: unknown) => Input };
	run: Handler;
};
const mocks = vi.hoisted(() => ({
	getOrganizationMembership: vi.fn(),
	getAgentTemplateInstance: vi.fn(),
	getAgentTemplate: vi.fn(),
	findInstance: vi.fn(),
	findUniqueInstance: vi.fn(),
	getActiveInstanceVersion: vi.fn(),
	getInstanceVersion: vi.fn(),
	getInstanceVersionHistory: vi.fn(),
	createAgentTemplateInstance: vi.fn(),
	updateAgentTemplateInstance: vi.fn(),
	archiveInstanceVersion: vi.fn(),
	restoreInstanceVersion: vi.fn(),
	deleteAgentTemplateInstance: vi.fn(),
	deleteAgentConversation: vi.fn(),
	archiveAgentConversation: vi.fn(),
	toggleConversationPin: vi.fn(),
	updateAgentConversation: vi.fn(),
	addMessageToConversation: vi.fn(),
	updateConversationTrajectory: vi.fn(),
}));
vi.mock("@repo/database", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/database")>()),
	...mocks,
	db: {
		agentTemplateInstance: {
			findFirst: mocks.findInstance,
			findUnique: mocks.findUniqueInstance,
		},
	},
	initializeMemoryFromTemplate: vi.fn(),
}));
vi.mock("../../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: mocks.getOrganizationMembership,
}));
vi.mock("../../../lib/validate-connections", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../lib/validate-connections")
	>()),
	validateAllConnections: vi.fn(async () => ({ valid: true })),
}));
vi.mock("../../../../agent-deployments/lib/sync-triggers", () => ({
	syncDeploymentTriggers: vi.fn(),
}));
vi.mock("../../../../../orpc/procedures", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../../../../orpc/procedures")>();
	const start = (mw: Middleware) => {
		const procedure = { middlewares: [mw] } as Procedure;
		const chain = {
			use: (next: Middleware) => {
				procedure.middlewares.push(next);
				return chain;
			},
			route: () => chain,
			output: () => chain,
			input: (schema: Procedure["schema"]) => {
				procedure.schema = schema;
				return chain;
			},
			handler: (run: Handler) => {
				procedure.run = run;
				return procedure;
			},
		};
		return chain;
	};
	return { ...actual, tenantProtectedProcedure: { use: start } };
});

const {
	updateInstanceProcedure,
	archiveInstanceProcedure,
	restoreInstanceProcedure,
} = await import("../update");
const { createInstanceProcedure } = await import("../create");
const { deleteInstanceProcedure } = await import("../delete");
const { getInstanceProcedure, getVersionHistoryProcedure } = await import(
	"../get"
);
const { restoreInstanceVersionProcedure } = await import(
	"../../../../agents/procedures/restore-instance-version"
);
const { deleteConversation, archiveConversation, togglePin } = await import(
	"../../../../agents/procedures/conversations/delete-conversation"
);
const { updateConversation, addMessage, updateTrajectory } = await import(
	"../../../../agents/procedures/conversations/update-conversation"
);
const ACTIVE = "example-org-a";
const TARGET = "example-org-b";
const USER = "example-user";
const writes = [
	mocks.createAgentTemplateInstance,
	mocks.updateAgentTemplateInstance,
	mocks.archiveInstanceVersion,
	mocks.restoreInstanceVersion,
	mocks.deleteAgentTemplateInstance,
	mocks.deleteAgentConversation,
	mocks.archiveAgentConversation,
	mocks.toggleConversationPin,
	mocks.updateAgentConversation,
	mocks.addMessageToConversation,
	mocks.updateConversationTrajectory,
];
const instanceCases = [
	{
		name: "update instance",
		procedure: updateInstanceProcedure,
		write: mocks.updateAgentTemplateInstance,
		input: { id: "example-instance" },
	},
	{
		name: "archive instance",
		procedure: archiveInstanceProcedure,
		write: mocks.archiveInstanceVersion,
		input: { id: "example-instance" },
	},
	{
		name: "restore template instance",
		procedure: restoreInstanceProcedure,
		write: mocks.restoreInstanceVersion,
		input: { id: "example-instance" },
	},
	{
		name: "delete instance",
		procedure: deleteInstanceProcedure,
		write: mocks.deleteAgentTemplateInstance,
		input: { id: "example-instance" },
	},
];
const restoreAgent = {
	name: "restore agent instance",
	procedure: restoreInstanceVersionProcedure,
	write: mocks.restoreInstanceVersion,
	input: { instanceId: "example-instance" },
};
const cases = [
	...instanceCases,
	restoreAgent,
	{
		name: "create instance",
		procedure: createInstanceProcedure,
		write: mocks.createAgentTemplateInstance,
		input: {
			templateId: "example-template",
			name: "Example",
			description: "Example agent",
			customInstructions: { role: "Help" },
		},
	},
	{
		name: "delete conversation",
		procedure: deleteConversation,
		write: mocks.deleteAgentConversation,
		input: { id: "example-conversation" },
	},
	{
		name: "archive conversation",
		procedure: archiveConversation,
		write: mocks.archiveAgentConversation,
		input: { id: "example-conversation" },
	},
	{
		name: "pin conversation",
		procedure: togglePin,
		write: mocks.toggleConversationPin,
		input: { id: "example-conversation" },
	},
	{
		name: "update conversation",
		procedure: updateConversation,
		write: mocks.updateAgentConversation,
		input: { id: "example-conversation", title: "Example" },
	},
	{
		name: "add message",
		procedure: addMessage,
		write: mocks.addMessageToConversation,
		input: {
			conversationId: "example-conversation",
			message: {
				id: "example-message",
				role: "user",
				content: "Hello",
				timestamp: "2026-10-19T00:00:00Z",
			},
		},
	},
	{
		name: "update trajectory",
		procedure: updateTrajectory,
		write: mocks.updateConversationTrajectory,
		input: {
			conversationId: "example-conversation",
			trajectory: {
				id: "example-trajectory",
				nodes: [],
				edges: [],
				startTime: "2026-10-19T00:00:00Z",
				status: "completed",
			},
		},
	},
];
function roles(available: Record<string, string>) {
	mocks.getOrganizationMembership.mockImplementation(async (org: string) =>
		available[org]
			? { role: available[org], organization: { deletedAt: null } }
			: null,
	);
}
async function invoke(procedure: unknown, raw: Input) {
	const p = procedure as Procedure;
	const input = p.schema.parse(raw);
	const context = {
		user: { id: USER },
		session: { activeOrganizationId: ACTIVE },
		activeOrganizationRole: "admin",
		tenantContext: {
			type: "organization",
			organizationId: ACTIVE,
			userId: USER,
		},
		headers: new Headers(),
	};
	const run = async (i: number): Promise<unknown> =>
		i === p.middlewares.length
			? { output: await p.run({ input, context }) }
			: p.middlewares[i]({ context, next: () => run(i + 1) }, input);
	return run(0);
}
async function refused(
	procedure: unknown,
	input: Input,
	code: string,
	message?: string,
) {
	const error = await invoke(procedure, input).then(
		() => null,
		(e: unknown) => e,
	);
	expect(error).toBeInstanceOf(ORPCError);
	expect(error).toMatchObject({ code, ...(message ? { message } : {}) });
	for (const write of writes) {
		expect(write).not.toHaveBeenCalled();
	}
}
beforeEach(() => {
	vi.clearAllMocks();
	expect(process.env.RBAC_DRY_RUN).toBeUndefined();
	roles({ [ACTIVE]: "admin", [TARGET]: "admin" });
	const instance = {
		id: "example-instance",
		userId: USER,
		organizationId: TARGET,
		status: "ARCHIVED",
		sId: "example-stable",
		name: "Example",
		version: 2,
	};
	mocks.getAgentTemplateInstance.mockResolvedValue(instance);
	mocks.findInstance.mockResolvedValue(instance);
	mocks.findUniqueInstance.mockResolvedValue(instance);
	mocks.getActiveInstanceVersion.mockResolvedValue(instance);
	mocks.getInstanceVersion.mockResolvedValue(instance);
	mocks.getInstanceVersionHistory.mockResolvedValue([instance]);
	mocks.getAgentTemplate.mockResolvedValue({ scope: "SYSTEM" });
	for (const write of writes) {
		write.mockResolvedValue({
			...instance,
			updatedAt: new Date("2026-10-19T00:00:00Z"),
			messages: [],
		});
	}
});
describe.each(cases)(
	"$name target organization authorization",
	({ procedure, input, write }) => {
		it("refuses session admin / target viewer", async () => {
			roles({ [ACTIVE]: "admin", [TARGET]: "viewer" });
			await refused(
				procedure,
				{ ...input, organizationId: TARGET },
				"FORBIDDEN",
			);
		});
		it("refuses explicit null organization", async () => {
			await refused(
				procedure,
				{ ...input, organizationId: null },
				"FORBIDDEN",
				"This operation requires an organization context",
			);
		});
		it("admits target admin", async () => {
			await invoke(procedure, { ...input, organizationId: TARGET });
			expect(write).toHaveBeenCalledTimes(1);
			if (procedure === restoreInstanceVersionProcedure) {
				expect(mocks.findInstance).toHaveBeenCalledWith(
					expect.objectContaining({
						where: {
							id: "example-instance",
							organizationId: TARGET,
						},
					}),
				);
			}
			if (
				write !== mocks.archiveInstanceVersion &&
				write !== mocks.restoreInstanceVersion &&
				write !== mocks.deleteAgentTemplateInstance
			) {
				expect(write).toHaveBeenCalledWith(
					expect.objectContaining({
						organizationId: TARGET,
						userId: USER,
					}),
				);
			}
		});
		it("uses the session organization when input omits it", async () => {
			mocks.getAgentTemplateInstance.mockResolvedValue({
				id: "example-instance",
				userId: "example-other-user",
				organizationId: ACTIVE,
				status: "ARCHIVED",
			});
			mocks.findInstance.mockResolvedValue({
				id: "example-instance",
				organizationId: ACTIVE,
				status: "ARCHIVED",
			});
			await invoke(procedure, input);
			if (procedure === restoreInstanceVersionProcedure) {
				expect(mocks.findInstance).toHaveBeenCalledWith(
					expect.objectContaining({
						where: {
							id: "example-instance",
							organizationId: ACTIVE,
						},
					}),
				);
			} else if (
				write !== mocks.archiveInstanceVersion &&
				write !== mocks.restoreInstanceVersion &&
				write !== mocks.deleteAgentTemplateInstance
			) {
				expect(write).toHaveBeenCalledWith(
					expect.objectContaining({
						organizationId: ACTIVE,
						userId: USER,
					}),
				);
			}
			expect(mocks.getOrganizationMembership).toHaveBeenCalledWith(
				ACTIVE,
				USER,
			);
			expect(write).toHaveBeenCalledTimes(1);
		});
	},
);
describe.each(instanceCases)("$name row boundary", ({ procedure, input }) => {
	it("hides rows outside the session organization when input omits it", async () => {
		await refused(procedure, input, "NOT_FOUND", "Instance not found");
	});
	it.each(["viewer", undefined])(
		"refuses a creator with role %s in the row organization",
		async (role) => {
			roles({ [ACTIVE]: "admin", ...(role ? { [TARGET]: role } : {}) });
			await refused(
				procedure,
				{ ...input, organizationId: TARGET },
				"FORBIDDEN",
			);
		},
	);
	it("refuses the former creator in the session organization", async () => {
		roles({});
		mocks.getAgentTemplateInstance.mockResolvedValue({
			userId: USER,
			organizationId: ACTIVE,
		});
		await refused(procedure, input, "FORBIDDEN");
	});
	it("hides missing rows", async () => {
		mocks.getAgentTemplateInstance.mockResolvedValue(null);
		await refused(procedure, input, "NOT_FOUND", "Instance not found");
	});
	it("hides personal rows", async () => {
		mocks.getAgentTemplateInstance.mockResolvedValue({
			userId: USER,
			organizationId: null,
		});
		await refused(procedure, input, "NOT_FOUND", "Instance not found");
	});
});
describe.each([instanceCases[2], restoreAgent])(
	"$name permission parity",
	({ procedure, input }) => {
		it("refuses member with AGENT_EXECUTE but without AGENT_TEMPLATE_MANAGE", async () => {
			roles({ [ACTIVE]: "admin", [TARGET]: "member" });
			await refused(
				procedure,
				{ ...input, organizationId: TARGET },
				"FORBIDDEN",
			);
		});
	},
);

it("reports BAD_REQUEST when the template instance is not archived", async () => {
	mocks.getAgentTemplateInstance.mockResolvedValue({
		organizationId: TARGET,
		status: "ACTIVE",
	});
	await refused(
		restoreInstanceProcedure,
		{ id: "example-instance", organizationId: TARGET },
		"BAD_REQUEST",
		"Can only restore archived versions",
	);
});

const readCases = [
	{
		name: "get instance by id",
		procedure: getInstanceProcedure,
		input: { id: "example-instance" },
	},
	{
		name: "get active instance by stable id",
		procedure: getInstanceProcedure,
		input: { sId: "example-stable" },
	},
	{
		name: "get specific instance version",
		procedure: getInstanceProcedure,
		input: { sId: "example-stable", version: 2 },
	},
	{
		name: "get version history",
		procedure: getVersionHistoryProcedure,
		input: { sId: "example-stable" },
	},
];
describe.each(readCases)(
	"$name read organization authorization",
	({ procedure, input }) => {
		it("refuses a former creator", async () => {
			roles({ [ACTIVE]: "admin" });
			await refused(
				procedure,
				{ ...input, organizationId: TARGET },
				"FORBIDDEN",
			);
			expect(mocks.getInstanceVersionHistory).not.toHaveBeenCalled();
		});
		it("admits a viewer in the row organization", async () => {
			roles({ [ACTIVE]: "admin", [TARGET]: "viewer" });
			const result = await invoke(procedure, {
				...input,
				organizationId: TARGET,
			});
			expect(result).toMatchObject({
				output:
					procedure === getVersionHistoryProcedure
						? {
								versions: [
									expect.objectContaining({
										organizationId: TARGET,
									}),
								],
							}
						: {
								instance: expect.objectContaining({
									organizationId: TARGET,
								}),
							},
			});
			expect(mocks.getOrganizationMembership).toHaveBeenCalledWith(
				TARGET,
				USER,
			);
		});
		it("hides rows in another organization", async () => {
			await refused(procedure, input, "NOT_FOUND", "Instance not found");
			expect(mocks.getInstanceVersionHistory).not.toHaveBeenCalled();
		});
		it("refuses explicit null organization", async () => {
			await refused(
				procedure,
				{ ...input, organizationId: null },
				"FORBIDDEN",
				"This operation requires an organization context",
			);
			expect(mocks.getInstanceVersionHistory).not.toHaveBeenCalled();
		});
	},
);
