import { SkillError } from "@repo/ai/skill-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewaySession } from "../types";

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
vi.mock("@repo/api/modules/skills/lib/skill-commands", () => ({
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
vi.mock("@repo/api/modules/skills/lib/skill-authoring", () => ({
	assistSkillCommand: m.assist,
	previewSkillImportCommand: m.importPreview,
	createSkillImportCommand: m.importCreate,
	readSkillFileCommand: m.readFile,
	readSkillImportFileCommand: m.importReadFile,
}));
vi.mock("@repo/database", () => ({ recordAudit: m.audit }));

import { scopeSatisfied } from "../tool-scope";
import { createSkillTools } from "../tools/skill-tools";

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
const family = createSkillTools();
const session: GatewaySession = {
	sessionId: "example-session",
	userId: "example-user",
	organizationId: "example-org",
	userName: "Example",
	email: "dev@example.com",
	role: "user",
	credential: "organization-key",
	scopes: [
		"skills:read",
		"skills:write",
		"skills:publish",
		"governance:read",
		"governance:write",
	],
	createdAt: new Date(0),
	expiresAt: new Date(100000),
};
function invoke(
	op: (typeof operations)[number],
	input: Record<string, unknown> = op.input,
	override: Partial<GatewaySession> = {},
) {
	const handler = family.handlers.get(op.tool);
	if (!handler) {
		throw Error("Missing skill handler");
	}
	return handler(input, { ...session, ...override });
}
beforeEach(() => {
	vi.resetAllMocks();
	for (const op of operations) {
		m[op.method as "get"].mockResolvedValue({ id: "example-result" });
	}
});
describe("governed Skills MCP transport", () => {
	it.each(operations)(
		"dispatches $method to the shared current-actor command",
		async (op) => {
			expect((await invoke(op)).isError).not.toBe(true);
			const args = m[op.method as "get"].mock.calls[0];
			expect(args[0]).toEqual({
				userId: "example-user",
				organizationId: "example-org",
				external: true,
			});
			expect(args[1]).toMatchObject(op.input);
		},
	);
	it.each(operations)(
		"requires explicit $scope instead of an MCP umbrella",
		async (op) => {
			expect(
				(
					await invoke(op, op.input, {
						scopes: ["mcp:read", "mcp:write"],
					})
				).isError,
			).toBe(true);
			expect(
				scopeSatisfied(
					["mcp:write"],
					{ scope: op.scope, kind: op.write ? "write" : "read" },
					"organization-key",
				),
			).toBe(false);
			expect(m[op.method as "get"]).not.toHaveBeenCalled();
		},
	);
	it.each(operations)(
		"does not bypass live permissions or governance for wildcard $method",
		async (op) => {
			m[op.method as "get"].mockRejectedValue(
				new SkillError("FORBIDDEN", "Current owner or policy denied"),
			);
			const result = await invoke(op, op.input, { scopes: ["*"] });
			expect(result.isError).toBe(true);
			expect(JSON.stringify(result)).toContain("FORBIDDEN");
		},
	);
	it.each([
		{ projectId: "example-project" },
		{ pinnedProjectId: "example-project" },
		{ pageProjectId: "example-project" },
		{ credential: "service" as const },
		{ organizationId: undefined },
	])(
		"forbids owner/governance methods on a bound/service connection %j",
		async (override) => {
			for (const op of operations) {
				expect((await invoke(op, op.input, override)).isError).toBe(
					true,
				);
				expect(m[op.method as "get"]).not.toHaveBeenCalled();
			}
		},
	);
	it("forbids actor/scopes injection and publication on imports", async () => {
		for (const op of operations) {
			expect(
				(
					await invoke(op, {
						...op.input,
						userId: "other",
						scopes: ["*"],
					})
				).isError,
			).toBe(true);
		}
		expect(
			(
				await invoke(operations[12], {
					...operations[12].input,
					isPublished: true,
				})
			).isError,
		).toBe(true);
	});
	it("requires a separate publication scope on create", async () => {
		expect(
			(
				await invoke(
					operations[2],
					{ ...operations[2].input, isPublished: true },
					{ scopes: ["skills:write"] },
				)
			).isError,
		).toBe(true);
		expect(m.create).not.toHaveBeenCalled();
	});
	it("bounds source inputs before source/model work", async () => {
		expect(
			(
				await invoke(operations[11], {
					source: {
						kind: "file",
						fileName: "example.zip",
						base64: "x".repeat(12 * 1024 * 1024),
					},
				})
			).isError,
		).toBe(true);
		expect(m.importPreview).not.toHaveBeenCalled();
	});
	it("requires confirmation on mutations and marks permanent deletion destructive", () => {
		for (const name of [
			"fabric_create_skill",
			"fabric_update_skill",
			"fabric_archive_skill",
			"fabric_restore_skill",
			"fabric_publish_skill",
			"fabric_delete_skill",
			"fabric_update_skill_governance",
			"fabric_assist_skill",
			"fabric_create_skill_import",
		]) {
			expect(
				family.definitions.find((x) => x.name === name)?._meta?.[
					"fabric/confirm"
				],
			).toBe(true);
		}
		expect(
			family.definitions.find((x) => x.name === "fabric_delete_skill")
				?.annotations?.destructiveHint,
		).toBe(true);
		expect(family.definitions.map((x) => x.name)).toEqual(
			operations.map((x) => x.tool),
		);
	});
	it("defaults automatic discovery to agent availability without hiding authorized manual catalogs", async () => {
		await invoke(operations[0]);
		expect(m.list.mock.calls[0][1]).toMatchObject({ isDiscoverable: true });
		m.list.mockClear();
		await invoke(operations[0], { tab: "drafts" });
		expect(m.list.mock.calls[0][1]).toMatchObject({ tab: "drafts" });
		expect(m.list.mock.calls[0][1].isDiscoverable).toBeUndefined();
		m.list.mockClear();
		await invoke(operations[0], {
			tab: "organization",
			isDiscoverable: false,
		});
		expect(m.list.mock.calls[0][1]).toMatchObject({
			tab: "organization",
			isDiscoverable: false,
		});
	});
});
