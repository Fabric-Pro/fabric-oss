import { ORPCError } from "@orpc/server";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExternalApiVariables } from "../../external-api/types";

const m = vi.hoisted(() => ({
	read: vi.fn(),
	styleRead: vi.fn(),
	styleSave: vi.fn(),
	company: vi.fn(),
	client: vi.fn(),
	audit: vi.fn(),
	context: vi.fn(),
	projectContext: vi.fn(),
}));
vi.mock("../../branding/lib/brand-commands", async () => ({
	...(await import("../../branding/lib/brand-contracts")),
	getArtifactBrandCommand: m.read,
	saveCompanyBrandCommand: m.company,
	saveClientBrandCommand: m.client,
}));
vi.mock("../../branding/lib/proposal-style-commands", () => ({
	getProposalStyleCommand: m.styleRead,
	saveProposalStyleCommand: m.styleSave,
}));
vi.mock("../contexts", () => ({ resolveContextProject: m.projectContext }));
vi.mock("../../../lib/audit", () => ({ recordAuditFromRequest: m.audit }));
vi.mock("../helpers", () => ({
	ok: (data: unknown) => ({ data }),
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

import { registerBrandRoutes } from "../branding";

const app = new Hono<{ Variables: ExternalApiVariables }>();
app.use("*", async (c, next) => {
	c.set("externalApiContext", {
		userId: "example-user",
		organizationId: "example-org",
		keyType: "organization",
		keyId: "example-key",
		keyPrefix: "example",
		scopes: (c.req.header("x-example-scopes") ?? "").split(","),
	});
	await next();
});
registerBrandRoutes(app);
const actor = { userId: "example-user", organizationId: "example-org" };
const request = (path: string, scope: string, body?: unknown) =>
	app.request(path, {
		method: body === undefined ? "GET" : "PUT",
		headers: {
			"x-example-scopes": scope,
			"Content-Type": "application/json",
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
beforeEach(() => {
	vi.clearAllMocks();
	m.context.mockResolvedValue(actor);
	m.projectContext.mockResolvedValue(actor);
	m.read.mockResolvedValue({ clientVersion: 0 });
	m.company.mockResolvedValue({ outcome: "applied", version: 1 });
	m.client.mockResolvedValue({ outcome: "applied", version: 1 });
});
describe("branding API", () => {
	it("requires the declared scope before invoking branding", async () => {
		const result = await request(
			"/projects/example-project/branding",
			"orgs:read",
		);
		expect(result.status).toBe(403);
		expect(m.read).not.toHaveBeenCalled();
	});
	it("passes project identity into tenant resolution and the canonical command", async () => {
		const result = await request(
			"/projects/example-project/branding",
			"projects:read",
		);
		expect(result.status).toBe(200);
		expect(result.headers.get("cache-control")).toBe("private, no-store");
		expect(m.projectContext.mock.calls[0][0]).toBe("example-project");
		expect(m.projectContext.mock.calls[0][2]).toEqual({
			org: undefined,
			personal: false,
		});
		expect(m.read).toHaveBeenCalledWith(actor, {
			projectId: "example-project",
		});
	});
	it("does not let a wildcard bypass the current actor check", async () => {
		m.company.mockRejectedValue(
			new ORPCError("FORBIDDEN", {
				message: "Administrator access required",
			}),
		);
		const result = await request("/branding/company", "*", {
			expectedVersion: 1,
			guidance: "Reviewed",
		});
		expect(result.status).toBe(403);
		expect(m.company).toHaveBeenCalledOnce();
	});
	it("requires an explicit reviewed version and rejects authority injection", async () => {
		for (const body of [
			{ guidance: "Reviewed" },
			{
				expectedVersion: 0,
				guidance: "Reviewed",
				organizationId: "example-other-org",
			},
		]) {
			const result = await request(
				"/branding/company",
				"orgs:write",
				body,
			);
			expect(result.status).toBe(400);
		}
		expect(m.company).not.toHaveBeenCalled();
	});
	it("uses path project identity for client save and audits the API-key actor", async () => {
		m.client.mockImplementation(async (_actor, _input, audit) => {
			audit({
				action: "project.recipient_brand.updated",
				category: "project",
				organizationId: "example-org",
				projectId: "example-project",
				resource: { type: "project", id: "example-project" },
			});
			return { outcome: "applied", version: 1 };
		});
		const result = await request(
			"/projects/example-project/branding/client",
			"projects:write",
			{
				expectedVersion: 0,
				name: "Example",
				colors: ["#123456"],
				website: null,
			},
		);
		expect(result.status).toBe(200);
		expect(m.client.mock.calls[0][1]).toMatchObject({
			projectId: "example-project",
			expectedVersion: 0,
		});
		expect(m.audit.mock.calls[0][1].actor).toEqual({
			type: "api_key",
			userId: "example-user",
		});
	});
	it("returns a conflict without pretending the save was applied", async () => {
		m.client.mockResolvedValue({ outcome: "conflict" });
		const result = await request(
			"/projects/example-project/branding/client",
			"projects:write",
			{ expectedVersion: 0, name: "Example", colors: [], website: null },
		);
		expect(await result.json()).toEqual({ data: { outcome: "conflict" } });
	});
	it("fails closed without an organization", async () => {
		m.context.mockResolvedValue({ ...actor, organizationId: null });
		expect((await request("/branding", "orgs:read")).status).toBe(403);
		expect(m.read).not.toHaveBeenCalled();
	});
	it("bounds text-write bodies", async () => {
		const result = await request("/branding/company", "orgs:write", {
			expectedVersion: 0,
			guidance: "x".repeat(20_000),
		});
		expect(result.status).toBe(413);
		expect(m.company).not.toHaveBeenCalled();
	});
	it("reads chunked bodies without cloning a Next/foreign Request", async () => {
		const request = new Request("http://example.com/branding/company", {
			method: "PUT",
			headers: {
				"x-example-scopes": "orgs:write",
				"Content-Type": "application/json",
			},
			body: new ReadableStream({
				start(controller) {
					controller.enqueue(
						new TextEncoder().encode(
							'{"expectedVersion":0,"guidance":"Reviewed"}',
						),
					);
					controller.close();
				},
			}),
			duplex: "half",
		} as RequestInit);
		request.clone = () => {
			throw Error("Foreign Request cannot be cloned");
		};
		expect((await app.fetch(request)).status).toBe(200);
		expect(m.company).toHaveBeenCalledOnce();
	});
	it("cancels under-declared oversized streams before mutation", async () => {
		const cancel = vi.fn();
		const request = new Request("http://example.com/branding/company", {
			method: "PUT",
			headers: {
				"x-example-scopes": "orgs:write",
				"Content-Length": "1",
			},
			body: new ReadableStream({
				start(controller) {
					controller.enqueue(new Uint8Array(20_000));
				},
				cancel,
			}),
			duplex: "half",
		} as RequestInit);
		expect((await app.fetch(request)).status).toBe(413);
		expect(cancel).toHaveBeenCalledOnce();
		expect(m.company).not.toHaveBeenCalled();
	});
});

describe("Proposal Style API parity", () => {
	it("requires read and write scopes independently and binds document identity from the route", async () => {
		const path =
			"/projects/example-project/documents/example-document/proposal-style";
		expect((await request(path, "orgs:read")).status).toBe(403);
		expect(m.styleRead).not.toHaveBeenCalled();
		expect((await request(path, "projects:read")).status).toBe(200);
		expect(m.styleRead).toHaveBeenCalledWith(actor, {
			projectId: "example-project",
			documentId: "example-document",
		});
		const input = {
			expectedUpdatedAt: null,
			brandSource: "CLIENT",
			coverStyle: "MINIMAL",
		};
		expect((await request(path, "projects:read", input)).status).toBe(403);
		expect((await request(path, "projects:write", input)).status).toBe(200);
		expect(m.styleSave).toHaveBeenCalledWith(
			actor,
			{
				...input,
				projectId: "example-project",
				documentId: "example-document",
			},
			expect.any(Function),
		);
	});
	it("rejects omitted CAS, authority injection and unsupported values before mutation", async () => {
		for (const input of [
			{ brandSource: "CLIENT" },
			{
				expectedUpdatedAt: null,
				brandSource: "CLIENT",
				organizationId: "example-other-org",
			},
			{ expectedUpdatedAt: null, coverStyle: "UNKNOWN" },
			{
				expectedUpdatedAt: null,
				documentId: "example-other-document",
				coverStyle: "LIGHT",
			},
		]) {
			expect(
				(
					await request(
						"/projects/example-project/documents/example-document/proposal-style",
						"projects:write",
						input,
					)
				).status,
			).toBe(400);
		}
		expect(m.styleSave).not.toHaveBeenCalled();
	});
	it("maps current-permission and CAS refusals without success writes", async () => {
		m.styleSave.mockRejectedValue(
			new ORPCError("CONFLICT", { message: "Style changed" }),
		);
		const result = await request(
			"/projects/example-project/documents/example-document/proposal-style",
			"*",
			{ expectedUpdatedAt: null, coverStyle: "LIGHT" },
		);
		expect(result.status).toBe(409);
		expect(m.styleSave).toHaveBeenCalledOnce();
		expect(m.audit).not.toHaveBeenCalled();
	});
});
