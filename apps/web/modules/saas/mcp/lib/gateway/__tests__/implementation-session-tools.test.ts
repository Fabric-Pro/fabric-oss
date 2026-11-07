import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { GatewaySession } from "../types";

const m = vi.hoisted(() => ({
	list: vi.fn(),
	get: vi.fn(),
	start: vi.fn(),
	cancel: vi.fn(),
	followup: vi.fn(),
	messages: vi.fn(),
	audit: vi.fn(),
}));
vi.mock("@repo/database", () => ({ recordAudit: m.audit }));
vi.mock("@repo/api/modules/coding-runs/lib/implementation-commands", () => ({
	listImplementationSessions: m.list,
	getImplementationSession: m.get,
	startImplementationSession: m.start,
	cancelImplementationSession: m.cancel,
	followUpImplementationSession: m.followup,
	getImplementationMessages: m.messages,
}));

import { createImplementationSessionTools } from "../tools/implementation-session-tools";

const session = {
	userId: "example-user",
	organizationId: "example-org",
	credential: "api_key",
	scopes: ["agents:read", "agents:execute"],
} as GatewaySession;
const family = createImplementationSessionTools();
const call = (
	name: string,
	args: Record<string, unknown> = { projectId: "example-project" },
	actor = session,
) => family.handlers.get(`fabric_${name}`)?.(args, actor);
beforeEach(() => {
	vi.clearAllMocks();
	for (const fn of [
		m.list,
		m.get,
		m.start,
		m.cancel,
		m.followup,
		m.messages,
	]) {
		fn.mockResolvedValue({ status: "RUNNING" });
	}
});
describe("implementation-session MCP parity", () => {
	it.each([
		["list_implementation_sessions", "list"],
		["get_implementation_session", "get"],
		["start_implementation_session", "start"],
		["cancel_implementation_session", "cancel"],
		["follow_up_implementation_session", "followup"],
		["get_implementation_messages", "messages"],
	] as const)("uses shared command for %s", async (tool, command) => {
		expect(await call(tool)).not.toMatchObject({ isError: true });
		expect(m[command].mock.calls[0][0]).toEqual({
			userId: "example-user",
			organizationId: "example-org",
		});
		expect(m[command].mock.calls[0][1]).toEqual({
			projectId: "example-project",
		});
	});
	it("checks scope and current permission even for wildcard keys", async () => {
		expect(
			await call("start_implementation_session", undefined, {
				...session,
				scopes: ["agents:read"],
			}),
		).toMatchObject({ isError: true });
		expect(m.start).not.toHaveBeenCalled();
		m.start.mockRejectedValue(
			new ORPCError("FORBIDDEN", {
				message: "Current project role revoked",
			}),
		);
		expect(
			await call("start_implementation_session", undefined, {
				...session,
				scopes: ["*"],
			}),
		).toMatchObject({ isError: true });
		expect(m.start).toHaveBeenCalledOnce();
	});
	it("refuses project-bound escapes and missing organization", async () => {
		expect(
			await call("list_implementation_sessions", undefined, {
				...session,
				projectId: "other-project",
			}),
		).toMatchObject({ isError: true });
		expect(
			await call("list_implementation_sessions", undefined, {
				...session,
				organizationId: undefined,
			}),
		).toMatchObject({ isError: true });
		expect(m.list).not.toHaveBeenCalled();
	});
	it("reports invalid schemas distinctly and sanitizes unknown provider errors", async () => {
		m.start.mockRejectedValueOnce(new z.ZodError([]));
		expect(
			JSON.stringify(await call("start_implementation_session")),
		).toContain("BAD_REQUEST");
		m.start.mockRejectedValueOnce(new Error("private provider endpoint"));
		const result = JSON.stringify(
			await call("start_implementation_session"),
		);
		expect(result).toContain("UNAVAILABLE");
		expect(result).not.toContain("private provider");
	});
	it("requires confirmation for writes and advertises all six controls", () => {
		expect(family.definitions).toHaveLength(6);
		expect(
			family.definitions.find(
				(definition) =>
					definition.name ===
					"fabric_follow_up_implementation_session",
			)?.annotations,
		).toMatchObject({ readOnlyHint: false, idempotentHint: false });
		for (const scope of Object.values(family.scopes)) {
			expect(scope.exact).toBe(true);
		}
		for (const definition of family.definitions.filter(
			(x) => !x.annotations?.readOnlyHint,
		)) {
			expect(definition._meta).toMatchObject({ "fabric/confirm": true });
		}
	});
});
