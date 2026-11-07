import { ORPCError } from "@orpc/server";
import {
	type DeliverySourceOperation,
	deliverySourceRequiredScopes,
} from "@repo/api/modules/projects/lib/delivery-source-contracts";
import {
	FABRIC_DELIVERY_SOURCE_TOOL_DEFINITIONS,
	isFabricChatTool,
} from "@repo/temporal/fabric-gateway-tools";
import { NOT_FOR_PAGES } from "@repo/temporal/fabric-page-tool-definitions";
import { FABRIC_PORTAL_EXCLUDED_TOOL_NAMES } from "@repo/temporal/fabric-portal-tools";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	list: vi.fn(),
	inspect: vi.fn(),
	configure: vi.fn(),
	state: vi.fn(),
	capture: vi.fn(),
	status: vi.fn(),
	cancel: vi.fn(),
	observations: vi.fn(),
	evidence: vi.fn(),
}));
vi.mock("@repo/api/modules/projects/lib/delivery-source-commands", () => ({
	listDeliverySourceWatches: m.list,
	inspectDeliverySource: m.inspect,
	configureDeliverySource: m.configure,
	updateDeliverySourceState: m.state,
	startDeliverySourceCapture: m.capture,
	getDeliverySourceCaptureStatus: m.status,
	cancelDeliverySourceCapture: m.cancel,
	listDeliverySourceObservations: m.observations,
	getDeliverySourceEvidence: m.evidence,
}));

import { scopeSatisfied } from "../tool-scope";
import { createDeliverySourceTools } from "../tools/delivery-source-tools";
import type { GatewaySession } from "../types";

const family = createDeliverySourceTools();
const session = {
	userId: "example-user",
	organizationId: "example-org",
	credential: "organization-key",
	scopes: ["*"],
} as GatewaySession;
function call(
	operation: string,
	args: Record<string, unknown> = { projectId: "example-project" },
	actor = session,
) {
	const handler = family.handlers.get(`fabric_delivery_source_${operation}`);
	if (!handler) {
		throw Error("Missing handler");
	}
	return handler(args, actor);
}
beforeEach(() => {
	vi.clearAllMocks();
	m.list.mockResolvedValue({
		version: 1,
		availability: { state: "ENABLED", reason: null },
		watches: [],
		connections: [],
	});
});
describe("private-source MCP", () => {
	it("declares eleven functional tools with the same operation scopes as canonical transports", () => {
		expect(family.definitions).toHaveLength(11);
		for (const definition of FABRIC_DELIVERY_SOURCE_TOOL_DEFINITIONS) {
			const op = definition.name.slice(
				"fabric_delivery_source_".length,
			) as DeliverySourceOperation;
			const required = deliverySourceRequiredScopes(op);
			const scope = family.scopes[definition.name];
			expect([scope.scope, ...(scope.additionalScopes ?? [])]).toEqual(
				required,
			);
			expect(scope.exact).toBe(true);
			expect(
				scopeSatisfied(["mcp:read", "mcp:write"], scope, "oauth"),
			).toBe(false);
			expect(scopeSatisfied(required, scope, "oauth")).toBe(true);
			expect(NOT_FOR_PAGES.has(definition.name)).toBe(true);
			expect(FABRIC_PORTAL_EXCLUDED_TOOL_NAMES).toContain(
				definition.name,
			);
			expect(isFabricChatTool(definition.name)).toBe(false);
		}
	});
	it("repeats scope-before-binding, carries issued bindings and repeats wildcard current actor checks", async () => {
		expect(
			JSON.stringify(
				await call(
					"list",
					{ projectId: "foreign" },
					{ ...session, scopes: [], projectId: "example-project" },
				),
			),
		).toContain("INSUFFICIENT_SCOPE");
		expect(
			JSON.stringify(
				await call(
					"list",
					{ projectId: "foreign" },
					{ ...session, projectId: "example-project" },
				),
			),
		).toContain("NOT_FOUND");
		expect(m.list).not.toHaveBeenCalled();
		await call("list");
		expect(m.list).toHaveBeenCalledWith(
			{
				userId: "example-user",
				boundProjectId: undefined,
				organizationBinding: { organizationId: "example-org" },
			},
			{ projectId: "example-project" },
		);
		m.list.mockRejectedValue(
			new ORPCError("FORBIDDEN", {
				message: "Access revoked.",
				data: { code: "INSUFFICIENT_PERMISSION" },
			}),
		);
		expect(JSON.stringify(await call("list"))).toContain(
			"INSUFFICIENT_PERMISSION",
		);
	});
	it("keeps native sessions unbound by chrome and refuses runtime/Page calls", async () => {
		await call(
			"list",
			{ projectId: "example-project" },
			{ ...session, credential: "session" },
		);
		expect(m.list.mock.calls[0][0]).not.toHaveProperty(
			"organizationBinding",
		);
		for (const definition of family.definitions) {
			for (const invalid of [
				{ ...session, credential: "service" as const },
				{ ...session, pageProjectId: "example-project" },
			]) {
				const handler = family.handlers.get(definition.name);
				expect(
					(await handler?.({ projectId: "example-project" }, invalid))
						?.isError,
				).toBe(true);
			}
		}
	});
	it("fixes state actions to the tool and redacts unexpected failures and output", async () => {
		await call("pause", {
			projectId: "example-project",
			watchId: "example-watch",
			requestId: "example-request",
			expectedVersion: 1,
		});
		expect(m.state).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ action: "PAUSE" }),
		);
		m.state.mockClear();
		expect(
			(
				await call("pause", {
					projectId: "example-project",
					action: "RESUME",
				})
			).isError,
		).toBe(true);
		expect(m.state).not.toHaveBeenCalled();
		m.list.mockResolvedValueOnce({
			version: 1,
			watches: [],
			connections: [],
			token: "private-token",
		});
		expect(JSON.stringify(await call("list"))).not.toContain(
			"private-token",
		);
		m.list.mockRejectedValueOnce(Error("private-provider-token"));
		expect(JSON.stringify(await call("list"))).not.toContain(
			"private-provider-token",
		);
	});
});

it("retains coded unavailable and throttled statuses without leaking dependency details", async () => {
	for (const [code, status, reason] of [
		["SERVICE_UNAVAILABLE", 503, "PRIVATE_SOURCE_CAPTURE_UNAVAILABLE"],
		["TOO_MANY_REQUESTS", 429, "SOURCE_RATE_LIMITED"],
	] as const) {
		m.list.mockRejectedValueOnce(
			new ORPCError(code, {
				message: "Safe source refusal.",
				data: { code: reason },
			}),
		);
		const result = await call("list");
		expect(JSON.stringify(result)).toContain(reason);
		expect(JSON.stringify(result)).toContain(String(status));
	}
});
