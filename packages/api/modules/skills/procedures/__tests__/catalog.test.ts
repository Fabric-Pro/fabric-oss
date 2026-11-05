import { SkillError } from "@repo/ai/skill-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";

const m = vi.hoisted(() => ({
	list: vi.fn(),
	get: vi.fn(),
	create: vi.fn(),
	update: vi.fn(),
	archive: vi.fn(),
	restore: vi.fn(),
	publish: vi.fn(),
	delete: vi.fn(),
	governanceGet: vi.fn(),
	governanceUpdate: vi.fn(),
	assist: vi.fn(),
	importPreview: vi.fn(),
	importCreate: vi.fn(),
	readFile: vi.fn(),
	importReadFile: vi.fn(),
	audit: vi.fn(),
	context: vi.fn(),
}));
vi.mock("../../lib/skill-commands", () => ({
	listSkillsCommand: m.list,
	getSkillCommand: m.get,
	createSkillCommand: m.create,
	updateSkillCommand: m.update,
	archiveSkillCommand: m.archive,
	restoreSkillCommand: m.restore,
	publishSkillCommand: m.publish,
	deleteSkillCommand: m.delete,
	getSkillGovernanceCommand: m.governanceGet,
	updateSkillGovernanceCommand: m.governanceUpdate,
}));
vi.mock("../../lib/skill-authoring", () => ({
	assistSkillCommand: m.assist,
	previewSkillImportCommand: m.importPreview,
	createSkillImportCommand: m.importCreate,
	readSkillFileCommand: m.readFile,
	readSkillImportFileCommand: m.importReadFile,
}));
vi.mock("../../../../lib/audit", () => ({ recordAuditFromRequest: m.audit }));
vi.mock("../../../../orpc/procedures", () => {
	function chain(permission?: string, schema?: z.ZodType) {
		return {
			use: (next: string) => chain(next),
			input: (next: z.ZodType) => chain(permission, next),
			output: () => chain(permission, schema),
			handler: (handler: unknown) => ({
				_permission: permission,
				_schema: schema,
				_handler: handler,
			}),
		};
	}
	return {
		tenantProtectedProcedure: chain(),
		Permissions: new Proxy({}, { get: (_, key) => String(key) }),
		requireInputOrgPermission: (
			permission: string,
			options: { requireOrganization: boolean },
		) => {
			if (!options.requireOrganization) {
				throw Error("Organization required");
			}
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

import { skillCatalogProcedures } from "../catalog";

const operations = [
	{
		method: "list",
		command: "listSkillsCommand",
		http: "GET",
		path: "/skills",
		input: {},
		scope: "skills:read",
		write: false,
		tool: "fabric_list_skills",
	},
	{
		method: "get",
		command: "getSkillCommand",
		http: "GET",
		path: "/skills/example-skill",
		input: { id: "example-skill" },
		scope: "skills:read",
		write: false,
		tool: "fabric_get_skill",
	},
	{
		method: "create",
		command: "createSkillCommand",
		http: "POST",
		path: "/skills",
		input: {
			name: "Example review",
			slug: "example-review",
			description: "Review the example change",
			content: "Check tests and permissions.",
		},
		scope: "skills:write",
		write: true,
		tool: "fabric_create_skill",
	},
	{
		method: "update",
		command: "updateSkillCommand",
		http: "PATCH",
		path: "/skills/example-skill",
		input: {
			id: "example-skill",
			expectedVersion: 2,
			name: "Improved review",
		},
		scope: "skills:write",
		write: true,
		tool: "fabric_update_skill",
	},
	{
		method: "archive",
		command: "archiveSkillCommand",
		http: "POST",
		path: "/skills/example-skill/archive",
		input: { id: "example-skill", expectedVersion: 2 },
		scope: "skills:write",
		write: true,
		tool: "fabric_archive_skill",
	},
	{
		method: "restore",
		command: "restoreSkillCommand",
		http: "POST",
		path: "/skills/example-skill/restore",
		input: { id: "example-skill", expectedVersion: 2 },
		scope: "skills:write",
		write: true,
		tool: "fabric_restore_skill",
	},
	{
		method: "publish",
		command: "publishSkillCommand",
		http: "POST",
		path: "/skills/example-skill/publish",
		input: {
			id: "example-skill",
			expectedVersion: 2,
			availability: "agents",
		},
		scope: "skills:publish",
		write: true,
		tool: "fabric_publish_skill",
	},
	{
		method: "delete",
		command: "deleteSkillCommand",
		http: "DELETE",
		path: "/skills/example-skill",
		input: { id: "example-skill" },
		scope: "skills:write",
		write: true,
		tool: "fabric_delete_skill",
	},
	{
		method: "governanceGet",
		command: "getSkillGovernanceCommand",
		http: "GET",
		path: "/skill-governance",
		input: {},
		scope: "governance:read",
		write: false,
		tool: "fabric_get_skill_governance",
	},
	{
		method: "governanceUpdate",
		command: "updateSkillGovernanceCommand",
		http: "PATCH",
		path: "/skill-governance",
		input: {
			expectedRevision: 0,
			policy: {
				create: "permitted_members",
				publish: "administrators",
				discover: "administrators",
			},
		},
		scope: "governance:write",
		write: true,
		tool: "fabric_update_skill_governance",
	},
	{
		method: "assist",
		command: "assistSkillCommand",
		http: "POST",
		path: "/skill-assistance",
		input: {
			draft: {
				name: "Example review",
				slug: "example-review",
				description: "Review the example change",
				content: "Check tests and permissions.",
			},
			message: "Improve clarity",
		},
		scope: "skills:write",
		write: true,
		tool: "fabric_assist_skill",
	},
	{
		method: "importPreview",
		command: "previewSkillImportCommand",
		http: "POST",
		path: "/skill-imports/preview",
		input: {
			source: {
				kind: "file",
				fileName: "example.md",
				base64: "RXhhbXBsZQ==",
			},
		},
		scope: "skills:write",
		write: true,
		tool: "fabric_preview_skill_import",
	},
	{
		method: "importCreate",
		command: "createSkillImportCommand",
		http: "POST",
		path: "/skill-imports",
		input: {
			source: {
				kind: "file",
				fileName: "example.md",
				base64: "RXhhbXBsZQ==",
			},
			candidateKey: "example.md",
			expectedHash:
				"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		},
		scope: "skills:write",
		write: true,
		tool: "fabric_create_skill_import",
	},
	{
		method: "readFile",
		command: "readSkillFileCommand",
		http: "GET",
		path: "/skills/example-skill/files?path=SKILL.md&expectedVersion=2",
		input: { id: "example-skill", path: "SKILL.md", expectedVersion: 2 },
		scope: "skills:read",
		write: false,
		tool: "fabric_read_skill_file",
	},
	{
		method: "importReadFile",
		command: "readSkillImportFileCommand",
		http: "POST",
		path: "/skill-imports/file",
		input: {
			source: {
				kind: "file",
				fileName: "example.md",
				base64: "RXhhbXBsZQ==",
			},
			candidateKey: "example.md",
			expectedHash:
				"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			path: "SKILL.md",
		},
		scope: "skills:write",
		write: true,
		tool: "fabric_read_skill_import_file",
	},
];
const context = {
	user: { id: "example-user" },
	session: { activeOrganizationId: "example-org" },
	headers: new Headers(),
};
function procedure(op: (typeof operations)[number]) {
	return (
		skillCatalogProcedures as unknown as Record<
			string,
			{
				_schema: z.ZodType;
				_permission: string;
				_handler: (args: {
					input: unknown;
					context: unknown;
				}) => Promise<unknown>;
			}
		>
	)[op.method];
}
beforeEach(() => {
	vi.resetAllMocks();
	for (const op of operations) {
		m[op.method as "get"].mockResolvedValue({
			skill: { id: "example-result" },
		});
	}
});
describe("governed Skills Portal oRPC adapters", () => {
	it.each(operations)(
		"resolves actor and org server-side for $method",
		async (op) => {
			const p = procedure(op);
			await p._handler({
				input: p._schema.parse({
					...op.input,
					organizationId: "example-org",
				}),
				context,
			});
			const args = m[op.method as "get"].mock.calls[0];
			expect(args[0]).toEqual({
				userId: "example-user",
				organizationId: "example-org",
			});
			expect(args[1]).toMatchObject(op.input);
			if (op.write) {
				expect(args[2]).toEqual(expect.any(Function));
			}
			expect(p._permission).toBe(
				op.method === "governanceUpdate"
					? "ORG_UPDATE"
					: op.method === "delete"
						? "SKILL_DELETE"
						: [
									"create",
									"assist",
									"importPreview",
									"importCreate",
									"importReadFile",
								].includes(op.method)
							? "SKILL_CREATE"
							: op.write
								? "SKILL_UPDATE"
								: "SKILL_READ",
			);
		},
	);
	it.each(operations)("rejects caller actor/scopes for $method", (op) => {
		expect(
			procedure(op)._schema.safeParse({
				...op.input,
				userId: "other",
				scopes: ["*"],
			}).success,
		).toBe(false);
	});
	it("keeps publication/discovery out of generic update", () => {
		expect(
			procedure(operations[3])._schema.safeParse({
				...operations[3].input,
				isDiscoverable: true,
			}).success,
		).toBe(false);
	});
	it("requires an organization and cannot restore personal tenancy", async () => {
		await expect(
			procedure(operations[1])._handler({
				input: { id: "example-skill", organizationId: null },
				context,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.get).not.toHaveBeenCalled();
	});
	it("translates current policy and stale version refusals", async () => {
		for (const code of ["FORBIDDEN", "CONFLICT"] as const) {
			m.update.mockRejectedValue(new SkillError(code, "Refused"));
			await expect(
				procedure(operations[3])._handler({
					input: operations[3].input,
					context,
				}),
			).rejects.toMatchObject({ code, message: "Refused" });
		}
	});
});
