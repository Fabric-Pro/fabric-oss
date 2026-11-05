import { call } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	instance: vi.fn(),
	version: vi.fn(),
	active: vi.fn(),
	memory: vi.fn(),
	boundary: vi.fn(),
	revalidate: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	db: {
		agentTemplateInstance: { findUnique: m.instance },
		agentMemoryFile: { findMany: m.memory },
	},
	getInstanceVersion: m.version,
	getActiveInstanceVersion: m.active,
	getInstanceVersionHistory: vi.fn(),
	memorySourceBoundary: m.boundary,
}));
vi.mock("../../../../../orpc/procedures", async () => {
	const { os } = await import("@orpc/server");
	return {
		tenantProtectedProcedure: os,
		Permissions: { AGENT_TEMPLATE_READ: "agent-template:read" },
		requireInputOrgPermission: () =>
			os.middleware(async ({ next }) => next()),
		resolveOrganizationId: (
			id: string | undefined,
			s: { activeOrganizationId: string },
		) => id ?? s.activeOrganizationId,
	};
});

import { getInstanceProcedure } from "../get";

const context = {
	user: { id: "example-reader" },
	session: { activeOrganizationId: "example-org" },
	headers: new Headers(),
};
const instance = {
	id: "example-instance",
	userId: "example-author",
	organizationId: "example-org",
	memoryFiles: [
		{
			id: "example-private-copy",
			content: "Private draft instructions",
			sourceSkillId: "example-private",
		},
	],
};
beforeEach(() => {
	vi.clearAllMocks();
	m.instance.mockResolvedValue(instance);
	m.version.mockResolvedValue(instance);
	m.active.mockResolvedValue(instance);
	m.boundary.mockImplementation(async (_actor, where) => ({
		where: { ...where, AND: [{ OR: [{ sourceSkillId: null }] }] },
		revalidate: m.revalidate,
	}));
	m.memory.mockResolvedValue([
		{
			id: "example-visible-copy",
			path: "skills/example.md",
			content: "Published source instructions",
			sourceSkillId: "example-published",
		},
	]);
});
describe("nested instance skill content retains source ACLs", () => {
	it.each([
		{ id: "example-instance" },
		{ sId: "example-stable", version: 1 },
		{ sId: "example-stable" },
	])(
		"source-scopes id and version readers before returning copied instructions: %j",
		async (input) => {
			const result = await call(getInstanceProcedure, input, { context });
			expect(JSON.stringify(result)).not.toContain(
				"Private draft instructions",
			);
			expect(result.instance.memoryFiles).toHaveLength(1);
			expect(m.boundary).toHaveBeenCalledWith(
				{ userId: "example-reader", organizationId: "example-org" },
				{
					agentInstanceId: "example-instance",
					organizationId: "example-org",
					fileType: "SKILL",
					isEnabled: true,
				},
			);
			expect(m.memory.mock.calls[0][0].where.AND).toEqual([
				{ OR: [{ sourceSkillId: null }] },
			]);
			expect(m.revalidate).toHaveBeenCalled();
			if ("id" in input) {
				expect(
					m.instance.mock.calls[0][0].include.memoryFiles,
				).toBeUndefined();
			}
		},
	);
	it("withholds nested copied content if source permission changes during the read", async () => {
		m.revalidate.mockRejectedValueOnce(new Error("Source access revoked"));
		await expect(
			call(getInstanceProcedure, { id: "example-instance" }, { context }),
		).rejects.toThrow("Source access revoked");
	});
	it("refuses another organization before reading source metadata", async () => {
		m.instance.mockResolvedValue({
			...instance,
			organizationId: "example-other-org",
		});
		await expect(
			call(getInstanceProcedure, { id: "example-instance" }, { context }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.memory).not.toHaveBeenCalled();
		expect(m.boundary).not.toHaveBeenCalled();
	});
});
