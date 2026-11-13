/**
 * The v1 Coding Instructions set routes (spec 2026-11-11 §4.5): which scope
 * each needs, that the live permission is asked for before anything changes,
 * that a refused project is answered as the gate answers it, that a refusal
 * keeps its code, and that every change is audited. The queries are covered
 * against Postgres in `@repo/database`.
 */
import { Permissions } from "@repo/permissions";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => {
	class InstructionSetError extends Error {
		constructor(
			readonly code: string,
			message: string,
			readonly details?: Record<string, unknown>,
		) {
			super(message);
		}
	}
	return {
		InstructionSetError,
		scopes: [] as string[],
		resolveInstructionProject: vi.fn(),
		listInstructionSets: vi.fn(),
		createInstructionSet: vi.fn(),
		updateInstructionSet: vi.fn(),
		deleteInstructionSet: vi.fn(),
		recordAuditFromRequest: vi.fn(),
	};
});

vi.mock("@repo/database", () => ({
	InstructionSetError: m.InstructionSetError,
	listInstructionSets: m.listInstructionSets,
	createInstructionSet: m.createInstructionSet,
	updateInstructionSet: m.updateInstructionSet,
	deleteInstructionSet: m.deleteInstructionSet,
}));
vi.mock("../instruction-project-gate", () => ({
	resolveInstructionProject: m.resolveInstructionProject,
}));
vi.mock("../../../lib/audit", () => ({
	recordAuditFromRequest: m.recordAuditFromRequest,
}));
vi.mock("../../external-api/middleware/api-key-auth", () => ({
	requireScope:
		(scope: string) =>
		async (
			c: { json: (body: unknown, status: number) => Response },
			next: () => Promise<void>,
		) => {
			if (!m.scopes.includes(scope)) {
				return c.json(
					{ error: `Missing required scope: ${scope}` },
					403,
				);
			}
			return next();
		},
}));

const { registerInstructionSetRoutes } = await import(
	"../instruction-sets-routes"
);

const BASE = "/projects/project-example/instructions/sets";
const set = {
	id: "set-example",
	name: "Mobile apps",
	slug: "mobile-apps",
	isDefault: false,
	repositoryIntegrationIds: ["integration-web"],
	folder: "instructions/mobile-apps/",
	excludedFolders: [],
	createdAt: new Date("2026-11-11T10:00:00.000Z"),
	updatedAt: new Date("2026-11-11T10:00:00.000Z"),
};

function app() {
	const result = new Hono();
	result.use("*", async (c, next) => {
		c.set("externalApiContext", {
			keyType: "organization",
			userId: "user-example",
			organizationId: "org-example",
			scopes: m.scopes,
		});
		await next();
	});
	registerInstructionSetRoutes(result as never);
	return result;
}

function send(method: string, path: string, body?: unknown) {
	return app().request(path, {
		method,
		headers: { "content-type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
}

beforeEach(() => {
	m.scopes = ["instructions:read", "projects:write"];
	m.resolveInstructionProject.mockResolvedValue({
		userId: "user-example",
		organizationId: "org-example",
	});
});

afterEach(() => {
	vi.clearAllMocks();
});

describe("GET sets", () => {
	it("lists under instructions:read with the read permission", async () => {
		m.listInstructionSets.mockResolvedValue([set]);
		const response = await send("GET", BASE);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			data: {
				sets: [
					{
						id: "set-example",
						name: "Mobile apps",
						slug: "mobile-apps",
						isDefault: false,
						repositoryIntegrationIds: ["integration-web"],
						folder: "instructions/mobile-apps/",
						excludedFolders: [],
					},
				],
			},
		});
		expect(
			m.resolveInstructionProject.mock.calls[0]?.[2],
		).not.toHaveProperty("requiredPermission");
	});

	it("answers a project the gate refuses as the gate does, reading nothing", async () => {
		m.resolveInstructionProject.mockResolvedValue({
			error: { message: "Project not found" },
			status: 404,
		});
		const response = await send("GET", BASE);

		expect(response.status).toBe(404);
		expect(m.listInstructionSets).not.toHaveBeenCalled();
	});
});

describe("changing sets", () => {
	it("refuses instructions:write, the proposal-only scope, before any lookup", async () => {
		m.scopes = ["instructions:read", "instructions:write"];

		for (const [method, path] of [
			["POST", BASE],
			["PATCH", `${BASE}/set-example`],
			["DELETE", `${BASE}/set-example`],
		] as const) {
			const response = await send(method, path, { name: "Web" });
			expect(response.status, method).toBe(403);
		}
		expect(m.resolveInstructionProject).not.toHaveBeenCalled();
		expect(m.createInstructionSet).not.toHaveBeenCalled();
		expect(m.updateInstructionSet).not.toHaveBeenCalled();
		expect(m.deleteInstructionSet).not.toHaveBeenCalled();
	});

	it("asks for the live INSTRUCTION_UPDATE and changes nothing when it is missing", async () => {
		m.resolveInstructionProject.mockResolvedValue({
			error: { message: "No instruction:update permission" },
			status: 403,
		});
		const response = await send("POST", BASE, { name: "Web" });

		expect(response.status).toBe(403);
		expect(m.resolveInstructionProject.mock.calls[0]?.[2]).toMatchObject({
			requiredPermission: Permissions.INSTRUCTION_UPDATE,
		});
		expect(m.createInstructionSet).not.toHaveBeenCalled();
		expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
	});

	it("creates in the organization the gate resolved and audits it", async () => {
		m.createInstructionSet.mockResolvedValue(set);
		const response = await send("POST", BASE, {
			name: "Mobile apps",
			repositoryIntegrationIds: ["integration-web"],
			organizationId: "org-other",
		});

		expect(response.status).toBe(201);
		expect(m.createInstructionSet).toHaveBeenCalledWith({
			projectId: "project-example",
			organizationId: "org-example",
			userId: "user-example",
			name: "Mobile apps",
			slug: undefined,
			repositoryIntegrationIds: ["integration-web"],
		});
		expect(m.recordAuditFromRequest).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				action: "project.instructions.set_created",
				organizationId: "org-example",
				actor: { type: "api_key", userId: "user-example" },
				metadata: {
					slug: "mobile-apps",
					repositoryCount: 1,
					via: "api",
				},
			}),
		);
	});

	it("rejects a body with nothing to change", async () => {
		const response = await send("PATCH", `${BASE}/set-example`, {});

		expect(response.status).toBe(400);
		expect(m.updateInstructionSet).not.toHaveBeenCalled();
	});

	it("keeps a refusal's code and status", async () => {
		m.createInstructionSet.mockRejectedValue(
			new m.InstructionSetError("SLUG_TAKEN", "Taken."),
		);
		const taken = await send("POST", BASE, { name: "Web" });
		expect(taken.status).toBe(409);
		expect(await taken.json()).toEqual({
			error: { message: "Taken.", code: "SLUG_TAKEN" },
		});

		m.updateInstructionSet.mockRejectedValue(
			new m.InstructionSetError("REPOSITORY_NOT_FOUND", "Missing.", {
				repositoryIntegrationIds: ["integration-x"],
			}),
		);
		const missing = await send("PATCH", `${BASE}/set-example`, {
			repositoryIntegrationIds: ["integration-x"],
		});
		expect(missing.status).toBe(400);
		expect(await missing.json()).toMatchObject({
			error: {
				code: "REPOSITORY_NOT_FOUND",
				repositoryIntegrationIds: ["integration-x"],
			},
		});

		m.deleteInstructionSet.mockRejectedValue(
			new m.InstructionSetError("SET_NOT_FOUND", "Set not found."),
		);
		expect((await send("DELETE", `${BASE}/set-other`)).status).toBe(404);
		expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
	});

	it("deletes and audits", async () => {
		m.deleteInstructionSet.mockResolvedValue(set);
		const response = await send("DELETE", `${BASE}/set-example`);

		expect(response.status).toBe(200);
		expect(m.deleteInstructionSet).toHaveBeenCalledWith({
			projectId: "project-example",
			setId: "set-example",
		});
		expect(m.recordAuditFromRequest).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				action: "project.instructions.set_deleted",
				metadata: { slug: "mobile-apps", via: "api" },
			}),
		);
	});
});
