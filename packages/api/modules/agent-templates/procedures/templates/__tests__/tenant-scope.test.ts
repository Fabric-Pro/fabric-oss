import { ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (args: {
	input: Record<string, unknown>;
	context: {
		user: { id: string };
		session: { activeOrganizationId: string };
	};
}) => Promise<unknown>;

const { handlers, mocks } = vi.hoisted(() => ({
	handlers: {} as Record<string, Handler>,
	mocks: {
		getAgentTemplate: vi.fn(),
		updateAgentTemplate: vi.fn(),
		deleteAgentTemplate: vi.fn(),
		requireOrgMembership: vi.fn(),
		resolveOrganizationIdForCaller: vi.fn(),
	},
}));

vi.mock("@repo/database", () => ({
	getAgentTemplate: mocks.getAgentTemplate,
	updateAgentTemplate: mocks.updateAgentTemplate,
	deleteAgentTemplate: mocks.deleteAgentTemplate,
}));
vi.mock("../../../../organizations/lib/membership", () => ({
	requireOrgMembership: mocks.requireOrgMembership,
}));
vi.mock("../../../../../orpc/procedures", () => {
	const chain = (name: string) => {
		const value = {
			use: () => value,
			input: () => value,
			handler: (handler: Handler) => {
				handlers[name] = handler;
				return value;
			},
		};
		return value;
	};
	let adminProcedure = 0;
	return {
		tenantProtectedProcedure: chain("get"),
		adminProcedure: {
			use: () => chain(adminProcedure++ === 0 ? "update" : "delete"),
		},
		Permissions: new Proxy({}, { get: (_target, key) => String(key) }),
		requirePermission: vi.fn(),
		resolveOrganizationIdForCaller: mocks.resolveOrganizationIdForCaller,
	};
});

await import("../get");
await import("../update");
await import("../delete");

const context = {
	user: { id: "example-user" },
	session: { activeOrganizationId: "example-org-a" },
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getAgentTemplate.mockImplementation(
		(_id: string, access?: { organizationId: string }) =>
			access?.organizationId === "example-org-a"
				? null
				: {
						id: "example-template-b",
						scope: "ORGANIZATION",
						organizationId: "example-org-b",
					},
	);
	mocks.requireOrgMembership.mockResolvedValue({ role: "admin" });
	mocks.resolveOrganizationIdForCaller.mockResolvedValue("example-org-a");
	mocks.updateAgentTemplate.mockResolvedValue({ id: "example-template-b" });
	mocks.deleteAgentTemplate.mockResolvedValue(undefined);
});

async function expectNotFound(name: string) {
	const error = await handlers[name]({
		input: { id: "example-template-b", slugOrId: "example-template-b" },
		context,
	}).then(
		() => null,
		(caught: unknown) => caught,
	);
	expect(error).toBeInstanceOf(ORPCError);
	expect(error).toMatchObject({ code: "NOT_FOUND" });
	expect(mocks.getAgentTemplate).toHaveBeenCalledWith("example-template-b", {
		userId: "example-user",
		organizationId: "example-org-a",
	});
	if (name !== "get") {
		expect(mocks.resolveOrganizationIdForCaller).toHaveBeenCalledWith(
			undefined,
			context.session,
			"example-user",
		);
	}
}

describe("agent template procedure tenant scope", () => {
	it("returns NOT_FOUND when get names another organization's template", async () => {
		await expectNotFound("get");
	});

	it("returns NOT_FOUND before updating another organization's template", async () => {
		await expectNotFound("update");
		expect(mocks.updateAgentTemplate).not.toHaveBeenCalled();
	});

	it("returns NOT_FOUND before deleting another organization's template", async () => {
		await expectNotFound("delete");
		expect(mocks.deleteAgentTemplate).not.toHaveBeenCalled();
	});
});
