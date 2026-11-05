import { SkillError } from "@repo/ai/skill-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";

const m = vi.hoisted(() => ({
	get: vi.fn(),
	increment: vi.fn(),
	handler: undefined as unknown as (args: {
		input: unknown;
		context: unknown;
	}) => Promise<unknown>,
	schema: undefined as unknown as z.ZodType,
	permission: "",
}));
vi.mock("@repo/database", () => ({ incrementSkillUseCount: m.increment }));
vi.mock("../../lib/skill-commands", () => ({ getSkillCommand: m.get }));
vi.mock("../../../../orpc/procedures", () => {
	const chain = {
		use: () => chain,
		route: () => chain,
		input: (schema: z.ZodType) => {
			m.schema = schema;
			return chain;
		},
		handler: (handler: typeof m.handler) => {
			m.handler = handler;
			return { _handler: handler };
		},
	};
	return {
		tenantProtectedProcedure: chain,
		Permissions: { SKILL_READ: "skill:read" },
		requireInputOrgPermission: (
			permission: string,
			options: { requireOrganization: boolean },
		) => {
			if (!options.requireOrganization) {
				throw Error("Organization required");
			}
			m.permission = permission;
			return permission;
		},
		resolveOrganizationId: (
			input: string | null | undefined,
			session: { activeOrganizationId?: string },
		) =>
			input === null
				? undefined
				: (input ?? session.activeOrganizationId),
	};
});
import "../execute";
const context = {
	user: { id: "example-user" },
	session: { activeOrganizationId: "example-org" },
};
const skill = {
	id: "example-skill",
	slug: "example-skill",
	name: "Example skill",
	description: "Check the change",
	content: "Check tests and permissions.",
	archivedAt: null,
};
beforeEach(() => {
	vi.clearAllMocks();
	m.get.mockResolvedValue({ skill });
	m.increment.mockResolvedValue(undefined);
});
describe("execute skill compatibility delegates current visibility to the shared command", () => {
	it("loads visible content without executing files or bypassing publication visibility", async () => {
		expect(m.permission).toBe("skill:read");
		expect(
			await m.handler({ input: { id: "example-skill" }, context }),
		).toEqual({
			id: skill.id,
			slug: skill.slug,
			name: skill.name,
			description: skill.description,
			content: skill.content,
		});
		expect(m.get).toHaveBeenCalledWith(
			{ userId: "example-user", organizationId: "example-org" },
			{ id: "example-skill" },
		);
		expect(m.increment).toHaveBeenCalledWith("example-skill");
	});
	it.each(["SYSTEM", "ORGANIZATION"])(
		"retains explicit authorized use of a %s skill",
		async (scope) => {
			m.get.mockResolvedValue({ skill: { ...skill, scope } });
			expect(
				await m.handler({ input: { id: "example-skill" }, context }),
			).toMatchObject({ content: skill.content });
		},
	);
	it.each(["NOT_FOUND", "FORBIDDEN"] as const)(
		"does not increment usage on current %s visibility/permission refusal",
		async (code) => {
			m.get.mockRejectedValue(new SkillError(code, "Skill unavailable"));
			await expect(
				m.handler({ input: { id: "example-skill" }, context }),
			).rejects.toMatchObject({ code, message: "Skill unavailable" });
			expect(m.increment).not.toHaveBeenCalled();
		},
	);
	it("refuses archived content before recording a use", async () => {
		m.get.mockResolvedValue({
			skill: { ...skill, archivedAt: "2026-01-01T00:00:00.000Z" },
		});
		await expect(
			m.handler({ input: { id: "example-skill" }, context }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.increment).not.toHaveBeenCalled();
	});
	it("never restores a personal/null organization branch", async () => {
		await expect(
			m.handler({
				input: { id: "example-skill", organizationId: null },
				context,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.get).not.toHaveBeenCalled();
		expect(m.increment).not.toHaveBeenCalled();
	});
	it("rejects actor, permission and content overrides through the input contract", () => {
		expect(
			m.schema.safeParse({
				id: "example-skill",
				userId: "other-user",
				scope: "SYSTEM",
				content: "Injected",
			}).success,
		).toBe(false);
	});
});
