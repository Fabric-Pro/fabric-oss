import { getCorrelationIdFromContext } from "@repo/utils/correlation-id";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentChatServerClient } from "../agent-chat-server-client";

const m = vi.hoisted(() => ({
	registry: vi.fn(),
	config: vi.fn(),
	observed: vi.fn(),
	wireAuditObservability: vi.fn(),
	lifecycle: vi.fn(),
	procedure: async (kind: "registry" | "config") => {
		const { ORPCError, os } = await import("@orpc/server");
		const { getCorrelationIdFromContext } = await import(
			"@repo/utils/correlation-id"
		);
		const { z } = await import("zod");
		return os
			.$context<{ headers: Headers }>()
			.input(
				z.object({
					id: z.string().optional(),
					organizationId: z.string().nullable().optional(),
				}),
			)
			.use(async ({ context, input, next, path }) => {
				m.lifecycle("procedure");
				if (context.headers.get("cookie") !== "session=example") {
					throw new ORPCError("UNAUTHORIZED");
				}
				if (
					input.organizationId !==
					context.headers.get("x-example-organization")
				) {
					throw new ORPCError("FORBIDDEN");
				}
				await Promise.resolve();
				m.observed({
					kind,
					path,
					input,
					contextKeys: Object.keys(context),
					correlationId: getCorrelationIdFromContext(),
					headerCorrelationId:
						context.headers.get("x-correlation-id"),
				});
				return next();
			})
			.handler(() => (kind === "registry" ? m.registry() : m.config()));
	},
}));

vi.mock("../../../../lib/audit", () => ({
	wireAuditObservability: m.wireAuditObservability,
}));

vi.mock("../../procedures/registry/get-registered-agent", async () => ({
	getRegisteredAgent: await m.procedure("registry"),
}));
vi.mock("../../../ai-config/procedures/resolution/get-status", async () => ({
	getAiConfigStatusProcedure: await m.procedure("config"),
}));

function requestHeaders(correlationId?: string) {
	const headers = new Headers({
		cookie: "session=example",
		"x-example-organization": "org-example",
	});
	if (correlationId) {
		headers.set("x-correlation-id", correlationId);
	}
	return headers;
}

beforeEach(() => {
	vi.clearAllMocks();
	m.wireAuditObservability.mockImplementation(() => m.lifecycle("audit"));
	m.registry.mockResolvedValue({
		id: "agent-example",
		createdAt: new Date(0),
	});
	m.config.mockResolvedValue({ isConfigured: false });
	vi.stubGlobal(
		"fetch",
		vi.fn(() => {
			throw new Error("Server chat reads must not use HTTP");
		}),
	);
});
afterEach(() => vi.unstubAllGlobals());

describe("agent chat server procedure clients", () => {
	it("initializes audit delivery before either procedure can refuse the request", async () => {
		const client = createAgentChatServerClient(new Headers());
		await expect(
			client.getRegisteredAgent({
				id: "agent-example",
				organizationId: "org-example",
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		await expect(
			client.getAiConfigStatus({ organizationId: "org-example" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(m.wireAuditObservability).toHaveBeenCalledOnce();
		expect(m.lifecycle.mock.calls).toEqual([
			["audit"],
			["procedure"],
			["procedure"],
		]);
		expect(m.registry).not.toHaveBeenCalled();
		expect(m.config).not.toHaveBeenCalled();
	});

	it("executes both procedure chains with their canonical paths and no HTTP", async () => {
		const client = createAgentChatServerClient(
			requestHeaders("example-correlation"),
		);
		await expect(
			client.getRegisteredAgent({
				id: "agent-example",
				organizationId: "org-example",
			}),
		).resolves.toEqual({ id: "agent-example", createdAt: new Date(0) });
		await expect(
			client.getAiConfigStatus({ organizationId: "org-example" }),
		).resolves.toEqual({ isConfigured: false });
		expect(m.observed.mock.calls.map(([value]) => value)).toEqual([
			{
				kind: "registry",
				path: ["agents", "registry", "get"],
				input: { id: "agent-example", organizationId: "org-example" },
				contextKeys: ["headers"],
				correlationId: "example-correlation",
				headerCorrelationId: "example-correlation",
			},
			{
				kind: "config",
				path: ["aiConfig", "resolution", "getStatus"],
				input: { organizationId: "org-example" },
				contextKeys: ["headers"],
				correlationId: "example-correlation",
				headerCorrelationId: "example-correlation",
			},
		]);
		expect(fetch).not.toHaveBeenCalled();
		expect(getCorrelationIdFromContext()).toBeUndefined();
	});

	it("keeps refusal behavior in the procedure chain", async () => {
		const unauthenticated = createAgentChatServerClient(new Headers());
		await expect(
			unauthenticated.getRegisteredAgent({
				id: "agent-example",
				organizationId: "org-example",
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		await expect(
			unauthenticated.getAiConfigStatus({
				organizationId: "org-example",
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		const client = createAgentChatServerClient(requestHeaders());
		await expect(
			client.getRegisteredAgent({
				id: "agent-example",
				organizationId: "other-org",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			client.getAiConfigStatus({ organizationId: "other-org" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.registry).not.toHaveBeenCalled();
		expect(m.config).not.toHaveBeenCalled();
	});

	it("preserves a rejected procedure and leaves correlation outside its scope unchanged", async () => {
		const failure = new Error("Synthetic registry failure");
		m.registry.mockRejectedValue(failure);
		const client = createAgentChatServerClient(requestHeaders());
		await expect(
			client.getRegisteredAgent({
				id: "agent-example",
				organizationId: "org-example",
			}),
		).rejects.toBe(failure);
		expect(getCorrelationIdFromContext()).toBeUndefined();
	});

	it("generates one correlation for both calls without changing the incoming headers", async () => {
		const incoming = requestHeaders();
		const client = createAgentChatServerClient(incoming);
		await Promise.all([
			client.getRegisteredAgent({
				id: "agent-example",
				organizationId: "org-example",
			}),
			client.getAiConfigStatus({ organizationId: "org-example" }),
		]);
		const observations = m.observed.mock.calls.map(([value]) => value);
		expect(observations[0].correlationId).toMatch(/^req_/);
		expect(observations[1].correlationId).toBe(
			observations[0].correlationId,
		);
		expect(observations[0].headerCorrelationId).toBe(
			observations[0].correlationId,
		);
		expect(incoming.has("x-correlation-id")).toBe(false);
	});

	it("keeps overlapping render requests in their own correlation scopes", async () => {
		const first = createAgentChatServerClient(
			requestHeaders("example-first"),
		);
		const second = createAgentChatServerClient(
			requestHeaders("example-second"),
		);
		await Promise.all([
			first.getRegisteredAgent({
				id: "agent-example",
				organizationId: "org-example",
			}),
			second.getAiConfigStatus({ organizationId: "org-example" }),
		]);
		expect(
			m.observed.mock.calls.map(([value]) => value.correlationId),
		).toEqual(["example-first", "example-second"]);
		expect(getCorrelationIdFromContext()).toBeUndefined();
	});
});
