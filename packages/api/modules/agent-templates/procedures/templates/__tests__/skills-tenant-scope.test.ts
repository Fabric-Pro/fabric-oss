import { ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (args: {
	input: { templateId: string; skillId: string; sortOrder?: number };
	context: {
		user: { id: string };
		session: { activeOrganizationId: string };
	};
}) => Promise<unknown>;

const { handlers, mocks } = vi.hoisted(() => ({
	handlers: {} as Record<string, Handler>,
	mocks: {
		getAgentTemplate: vi.fn(),
		legacyFindUnique: vi.fn(),
		getSkillById: vi.fn(),
		attachSkillToTemplate: vi.fn(),
		detachSkillFromTemplate: vi.fn(),
		listTemplateSkills: vi.fn(),
		requireOrgMembership: vi.fn(),
	},
}));

vi.mock("@repo/database", () => ({
	getAgentTemplate: mocks.getAgentTemplate,
	getSkillById: mocks.getSkillById,
	attachSkillToTemplate: mocks.attachSkillToTemplate,
	detachSkillFromTemplate: mocks.detachSkillFromTemplate,
	listTemplateSkills: mocks.listTemplateSkills,
}));
vi.mock("@repo/database/prisma/client", () => ({
	db: { agentTemplate: { findUnique: mocks.legacyFindUnique } },
}));
vi.mock("../../../../organizations/lib/membership", () => ({
	requireOrgMembership: mocks.requireOrgMembership,
}));
vi.mock("../../../../../orpc/procedures", () => {
	const names = ["attach", "detach", "list"];
	let index = 0;
	const root = {
		use: () => {
			const name = names[index++];
			const chain = {
				input: () => chain,
				handler: (handler: Handler) => {
					handlers[name] = handler;
					return chain;
				},
			};
			return chain;
		},
	};
	return {
		tenantProtectedProcedure: root,
		Permissions: new Proxy({}, { get: (_target, key) => String(key) }),
		requirePermission: vi.fn(),
	};
});

await import("../skills-attach");
await import("../skills-detach");
await import("../skills-list");

const context = {
	user: { id: "example-user" },
	session: { activeOrganizationId: "example-org-a" },
};

beforeEach(() => {
	vi.clearAllMocks();
	const otherTemplate = {
		id: "example-template-b",
		scope: "ORGANIZATION",
		organizationId: "example-org-b",
	};
	mocks.legacyFindUnique.mockResolvedValue(otherTemplate);
	mocks.getAgentTemplate.mockResolvedValue(null);
	mocks.requireOrgMembership.mockResolvedValue({ role: "admin" });
	mocks.getSkillById.mockResolvedValue({ scope: "SYSTEM" });
	mocks.attachSkillToTemplate.mockResolvedValue({ id: "example-link" });
	mocks.listTemplateSkills.mockResolvedValue([]);
});

describe.each(["attach", "detach", "list"])(
	"%s template skills tenant scope",
	(name) => {
		it("returns NOT_FOUND for another organization's template", async () => {
			const error = await handlers[name]({
				input: {
					templateId: "example-template-b",
					skillId: "example-skill",
				},
				context,
			}).then(
				() => null,
				(caught: unknown) => caught,
			);

			expect(error).toBeInstanceOf(ORPCError);
			expect(error).toMatchObject({ code: "NOT_FOUND" });
			expect(mocks.getAgentTemplate).toHaveBeenCalledWith(
				"example-template-b",
				{
					userId: "example-user",
					organizationId: "example-org-a",
				},
			);
			expect(mocks.attachSkillToTemplate).not.toHaveBeenCalled();
			expect(mocks.detachSkillFromTemplate).not.toHaveBeenCalled();
			expect(mocks.listTemplateSkills).not.toHaveBeenCalled();
		});
	},
);
