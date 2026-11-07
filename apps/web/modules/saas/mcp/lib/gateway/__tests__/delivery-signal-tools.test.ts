import { ORPCError } from "@orpc/server";
import { FABRIC_DELIVERY_SIGNAL_TOOL_DEFINITIONS } from "@repo/temporal/fabric-gateway-tools";
import { NOT_FOR_PAGES } from "@repo/temporal/fabric-page-tool-definitions";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { scopeSatisfied } from "../tool-scope";
import type { GatewaySession } from "../types";

const m = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), sources: vi.fn() }));
vi.mock(
	"@repo/api/modules/projects/lib/delivery-signals",
	async (original) => ({
		...(await original<Record<string, unknown>>()),
		listDeliverySignals: m.list,
		getDeliverySignal: m.get,
	}),
);
vi.mock("@repo/api/modules/projects/lib/delivery-signal-sources", () => ({
	getDeliverySignalSourceConfiguration: m.sources,
}));

import { createDeliverySignalTools } from "../tools/delivery-signal-tools";

const family = createDeliverySignalTools();
const session = {
	userId: "example-user",
	organizationId: "example-org",
	credential: "organization-key",
	scopes: ["projects:read", "features:read"],
} as GatewaySession;
const call = (name: string, args: Record<string, unknown>, actor = session) => {
	const handler = family.handlers.get(name);
	if (!handler) {
		throw Error("Missing handler");
	}
	return handler(args, actor);
};
beforeEach(() => {
	vi.clearAllMocks();
	m.list.mockResolvedValue({ version: 1, items: [] });
	m.get.mockResolvedValue({ id: "example-item" });
	m.sources.mockResolvedValue({ version: 1, items: [] });
});
describe("delivery history MCP authorization", () => {
	it("declares three functional read tools with exact paired consent", () => {
		expect(family.definitions).toHaveLength(3);
		for (const definition of family.definitions) {
			expect(definition.annotations?.readOnlyHint).toBe(true);
			const scope = family.scopes[definition.name];
			expect(scope.exact).toBe(true);
			expect(scopeSatisfied(["mcp:read"], scope, "oauth")).toBe(false);
			expect(
				scopeSatisfied(["projects:read"], scope, "organization-key"),
			).toBe(false);
			expect(scopeSatisfied(["*"], scope, "organization-key")).toBe(true);
			expect(NOT_FOR_PAGES.has(definition.name)).toBe(true);
		}
	});
	it("calls the same canonical queries with server-bound actors and minimized results", async () => {
		const result = await call("fabric_list_delivery_signals", {
			projectId: "example-project",
			limit: 5,
		});
		expect(result.isError).not.toBe(true);
		expect(m.list).toHaveBeenCalledWith(
			{
				userId: "example-user",
				boundProjectId: undefined,
				organizationBinding: { organizationId: "example-org" },
			},
			{ projectId: "example-project", limit: 5 },
		);
		await call("fabric_get_delivery_signal", {
			projectId: "example-project",
			id: "example-item",
		});
		expect(m.get).toHaveBeenCalled();
	});
	it("applies scope-before-binding order, including wildcard live permission refusal", async () => {
		const response = await call(
			"fabric_list_delivery_signals",
			{ projectId: "other-project" },
			{ ...session, projectId: "example-project", scopes: [] },
		);
		expect(JSON.stringify(response)).toContain("INSUFFICIENT_SCOPE");
		expect(m.list).not.toHaveBeenCalled();
		const bound = await call(
			"fabric_list_delivery_signals",
			{ projectId: "other-project" },
			{ ...session, projectId: "example-project" },
		);
		expect(JSON.stringify(bound)).toContain("NOT_FOUND");
		m.list.mockRejectedValue(
			new ORPCError("FORBIDDEN", {
				message: "Current access denied.",
				data: { code: "INSUFFICIENT_PERMISSION" },
			}),
		);
		const revoked = await call(
			"fabric_list_delivery_signals",
			{ projectId: "example-project" },
			{ ...session, scopes: ["*"] },
		);
		expect(JSON.stringify(revoked)).toContain("INSUFFICIENT_PERMISSION");
	});
	it("requires additional integrations consent and omits runtime/Page calls", async () => {
		expect(
			JSON.stringify(
				await call("fabric_get_delivery_signal_sources", {
					projectId: "example-project",
				}),
			),
		).toContain("INSUFFICIENT_SCOPE");
		expect(m.sources).not.toHaveBeenCalled();
		await call(
			"fabric_get_delivery_signal_sources",
			{ projectId: "example-project" },
			{ ...session, scopes: ["*"] },
		);
		expect(m.sources).toHaveBeenCalledTimes(1);
		for (const definition of FABRIC_DELIVERY_SIGNAL_TOOL_DEFINITIONS) {
			for (const invalid of [
				{ ...session, credential: "service" as const, scopes: ["*"] },
				{ ...session, pageProjectId: "example-project", scopes: ["*"] },
			]) {
				expect(
					(
						await call(
							definition.name,
							{ projectId: "example-project" },
							invalid,
						)
					).isError,
				).toBe(true);
			}
		}
	});
	it("preserves both native cause fields, never an unexpected provider error", async () => {
		m.list.mockRejectedValue(
			new ORPCError("FORBIDDEN", {
				message: "This organization has been deleted",
				data: { errorCode: "ORGANIZATION_DELETED" },
			}),
		);
		expect(
			JSON.stringify(
				await call("fabric_list_delivery_signals", {
					projectId: "example-project",
				}),
			),
		).toContain("ORGANIZATION_DELETED");
		m.list.mockRejectedValue(Error("private-credential"));
		expect(
			JSON.stringify(
				await call("fabric_list_delivery_signals", {
					projectId: "example-project",
				}),
			),
		).not.toContain("private-credential");
	});
});
