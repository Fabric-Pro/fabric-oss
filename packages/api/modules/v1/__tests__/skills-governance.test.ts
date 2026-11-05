import { SkillError } from "@repo/ai/skill-contracts";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExternalApiVariables } from "../../external-api/types";

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
vi.mock("../../skills/lib/skill-commands", () => ({
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
vi.mock("../../skills/lib/skill-authoring", () => ({
	assistSkillCommand: m.assist,
	previewSkillImportCommand: m.importPreview,
	createSkillImportCommand: m.importCreate,
	readSkillFileCommand: m.readFile,
	readSkillImportFileCommand: m.importReadFile,
}));
vi.mock("../../../lib/audit", () => ({ recordAuditFromRequest: m.audit }));
vi.mock("../helpers", () => ({
	ok: (data: unknown, meta?: unknown) => ({
		data,
		...(meta ? { meta } : {}),
	}),
	resolveV1Context: m.context,
}));
vi.mock("../../external-api/middleware/api-key-auth", () => ({
	requireScope:
		(scope: string) => async (c: any, next: () => Promise<void>) => {
			const scopes = c.get("externalApiContext").scopes;
			if (!scopes.includes(scope) && !scopes.includes("*")) {
				return c.json({ error: { code: "INSUFFICIENT_SCOPE" } }, 403);
			}
			await next();
		},
}));

import { registerSkillRoutes } from "../skills";

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
let scopes: string[] = [];
const app = new Hono<{ Variables: ExternalApiVariables }>();
app.use("*", async (c, next) => {
	c.set("externalApiContext", {
		keyType: "organization",
		keyId: "example-key",
		keyPrefix: "org_example",
		userId: "example-user",
		organizationId: "example-org",
		scopes,
	});
	await next();
});
registerSkillRoutes(app);
function request(op: (typeof operations)[number], override?: unknown) {
	const body =
		override ??
		(op.http === "GET" || op.http === "DELETE"
			? undefined
			: Object.fromEntries(
					Object.entries(op.input).filter(([key]) => key !== "id"),
				));
	return app.request(`https://example.com${op.path}`, {
		method: op.http,
		...(body === undefined
			? {}
			: {
					body: JSON.stringify(body),
					headers: { "Content-Type": "application/json" },
				}),
	});
}
afterEach(() => vi.unstubAllGlobals());
beforeEach(() => {
	vi.resetAllMocks();
	scopes = [
		"skills:read",
		"skills:write",
		"skills:publish",
		"governance:read",
		"governance:write",
	];
	m.context.mockResolvedValue({
		userId: "example-user",
		organizationId: "example-org",
	});
	for (const operation of operations) {
		m[operation.method as "get"].mockResolvedValue({
			skill: { id: "example-skill", content: "Authorized content" },
		});
	}
	m.list.mockResolvedValue({
		skills: [{ id: "example-skill", content: "Authorized content" }],
		total: 1,
		hasMore: false,
		nextCursor: null,
	});
});
describe("governed Skills REST transport", () => {
	it.each(operations)(
		"uses the authorized shared $method command with current actor",
		async (op) => {
			const response = await request(op);
			expect(response.status).toBe(200);
			const call = m[op.method as "get"].mock.calls[0];
			expect(call[0]).toEqual({
				userId: "example-user",
				organizationId: "example-org",
				external: true,
			});
			expect(call[1]).toMatchObject(op.input);
			if (op.write) {
				expect(call[2]).toEqual(expect.any(Function));
			}
			expect(response.headers.get("cache-control")).toBe(
				"private, no-store",
			);
		},
	);
	it.each(operations)("requires explicit $scope for $method", async (op) => {
		scopes = ["mcp:read", "mcp:write"];
		expect((await request(op)).status).toBe(403);
		expect(m[op.method as "get"]).not.toHaveBeenCalled();
	});
	it.each(operations)(
		"wildcard credentials do not bypass current authority for $method",
		async (op) => {
			scopes = ["*"];
			m[op.method as "get"].mockRejectedValue(
				new SkillError(
					"FORBIDDEN",
					"Current permission or policy refused",
				),
			);
			expect((await request(op)).status).toBe(403);
			expect(await (await request(op)).json()).toMatchObject({
				error: { code: "FORBIDDEN" },
			});
		},
	);
	it.each(
		operations.filter((op) => op.http !== "GET" && op.http !== "DELETE"),
	)("rejects actor and policy scope injection for $method", async (op) => {
		expect(
			(
				await request(op, {
					...op.input,
					userId: "other-user",
					scopes: ["*"],
					organizationId: "other-org",
				})
			).status,
		).toBe(400);
		expect(m[op.method as "get"]).not.toHaveBeenCalled();
	});
	it("write consent cannot implicitly publish or enable agent discovery", async () => {
		scopes = ["skills:write"];
		expect(
			(
				await request(operations[2], {
					...operations[2].input,
					isPublished: true,
					isDiscoverable: true,
				})
			).status,
		).toBe(403);
		expect(m.create).not.toHaveBeenCalled();
		scopes.push("skills:publish");
		expect(
			(
				await request(operations[2], {
					...operations[2].input,
					isPublished: true,
					isDiscoverable: true,
				})
			).status,
		).toBe(200);
	});
	it("keeps legacy array/content response and exposes an explicit complete page", async () => {
		const response = await request(operations[0]);
		expect(await response.json()).toMatchObject({
			data: [{ content: "Authorized content" }],
			meta: { total: 1, hasMore: false, nextCursor: null },
		});
		expect(m.list).toHaveBeenLastCalledWith(
			expect.anything(),
			expect.anything(),
			{ includeContent: true },
		);
		const page = await app.request("https://example.com/skills?page=1");
		expect(await page.json()).toMatchObject({
			data: { skills: expect.any(Array), total: 1 },
		});
		expect(m.list).toHaveBeenLastCalledWith(
			expect.anything(),
			expect.anything(),
			{ includeContent: false },
		);
	});
	it("imports are private drafts and refuse publication flags", async () => {
		expect(
			(
				await request(operations[12], {
					...operations[12].input,
					isPublished: true,
				})
			).status,
		).toBe(400);
		expect(m.importCreate).not.toHaveBeenCalled();
	});
	it("body IDs cannot override the path", async () => {
		expect(
			(await request(operations[3], { ...operations[3].input })).status,
		).toBe(400);
		expect(m.update).not.toHaveBeenCalled();
	});
	it("fails closed on an unresolved organization", async () => {
		m.context.mockResolvedValue({
			error: "Organization required",
			status: 403,
		});
		expect((await request(operations[1])).status).toBe(403);
		expect(m.get).not.toHaveBeenCalled();
	});
	it("applies raw payload caps before source/model work", async () => {
		expect(
			(
				await request(operations[2], {
					...operations[2].input,
					content: "x".repeat(1024 * 1024),
				})
			).status,
		).toBe(413);
		expect(
			(
				await request(operations[10], {
					...operations[10].input,
					message: "x".repeat(128 * 1024),
				})
			).status,
		).toBe(413);
		expect(
			(
				await request(operations[11], {
					source: {
						kind: "file",
						fileName: "example.zip",
						base64: "x".repeat(12 * 1024 * 1024),
					},
				})
			).status,
		).toBe(413);
		expect(m.create).not.toHaveBeenCalled();
		expect(m.assist).not.toHaveBeenCalled();
		expect(m.importPreview).not.toHaveBeenCalled();
	});
	it("records the actual key actor without copying source or instructions into audit", async () => {
		m.create.mockImplementation(async (_actor, _input, audit) => {
			await audit({
				action: "org.skill.created",
				organizationId: "example-org",
				resource: { type: "skill", id: "example-skill" },
				metadata: { version: 1 },
			});
			return { skill: { id: "example-skill" } };
		});
		await request(operations[2]);
		expect(m.audit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				actor: { type: "api_key", userId: "example-user" },
				metadata: { version: 1 },
			}),
		);
		expect(JSON.stringify(m.audit.mock.calls)).not.toContain(
			"Check tests and permissions",
		);
	});
	it("rejects invalid boolean catalog filters rather than selecting an unintended private view", async () => {
		const response = await app.request(
			"https://example.com/skills?isPublished=invalid",
		);
		expect(response.status).toBe(400);
		expect(m.list).not.toHaveBeenCalled();
	});
	it("reads an empty DELETE stream without cloning a foreign Request implementation", async () => {
		const NativeRequest = globalThis.Request;
		const raw = new NativeRequest(
			"https://example.com/skills/example-skill",
			{
				method: "DELETE",
				body: new ReadableStream({
					start(c) {
						c.close();
					},
				}),
				duplex: "half",
			} as RequestInit,
		);
		vi.stubGlobal(
			"Request",
			class extends NativeRequest {
				constructor(input: RequestInfo | URL, init?: RequestInit) {
					if (input === raw) {
						throw Error(
							"Foreign Request private state cannot be cloned",
						);
					}
					super(input, init);
				}
			},
		);
		const response = await app.fetch(raw);
		expect(response.status).toBe(200);
		expect(m.delete).toHaveBeenCalled();
	});
	it("reads chunked JSON without cloning the original request", async () => {
		const NativeRequest = globalThis.Request;
		const source = operations[2].input;
		const bytes = new TextEncoder().encode(JSON.stringify(source));
		const raw = new NativeRequest("https://example.com/skills", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: new ReadableStream({
				start(c) {
					c.enqueue(bytes.slice(0, 13));
					c.enqueue(bytes.slice(13));
					c.close();
				},
			}),
			duplex: "half",
		} as RequestInit);
		vi.stubGlobal(
			"Request",
			class extends NativeRequest {
				constructor(input: RequestInfo | URL, init?: RequestInit) {
					if (input === raw) {
						throw Error(
							"Foreign Request private state cannot be cloned",
						);
					}
					super(input, init);
				}
			},
		);
		expect((await app.fetch(raw)).status).toBe(200);
		expect(m.create).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining(source),
			expect.anything(),
		);
	});
	it("caps actual streamed bytes even when Content-Length underclaims them", async () => {
		let cancelled = false;
		const raw = new Request("https://example.com/skills/example-skill", {
			method: "DELETE",
			headers: { "content-length": "1" },
			body: new ReadableStream({
				start(c) {
					c.enqueue(new Uint8Array(1025));
				},
				cancel() {
					cancelled = true;
				},
			}),
			duplex: "half",
		} as RequestInit);
		expect((await app.fetch(raw)).status).toBe(413);
		expect(cancelled).toBe(true);
		expect(m.delete).not.toHaveBeenCalled();
	});
});
