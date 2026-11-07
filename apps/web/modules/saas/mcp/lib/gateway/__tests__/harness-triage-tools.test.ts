import { ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const commands = vi.hoisted(() =>
	Object.fromEntries(
		["list", "start", "status", "result", "cancel", "review"].map((op) => [
			op,
			vi.fn(),
		]),
	),
);
vi.mock("@repo/api/modules/projects/lib/harness-triage-commands", async () => {
	const { triageRequiredScopes } = await import(
		"@repo/api/modules/projects/lib/harness-triage-contracts"
	);
	return {
		privateTriageCommands: commands,
		requireTriageScopes: (
			credential: { kind: string; scopes: string[] },
			op: Parameters<typeof triageRequiredScopes>[0],
		) => {
			if (
				credential.kind !== "SESSION" &&
				triageRequiredScopes(op).some(
					(scope) =>
						!credential.scopes.includes(scope) &&
						!credential.scopes.includes("*"),
				)
			) {
				throw new ORPCError("FORBIDDEN");
			}
		},
	};
});

import { createHarnessTriageTools } from "../tools/harness-triage-tools";
import type { GatewaySession } from "../types";

const session = {
	sessionId: "example-session",
	userId: "example-user",
	organizationId: "example-org",
	userName: "Example user",
	email: "dev@example.com",
	role: "user",
	credential: "organization-key",
	scopes: ["*"],
	keyIdentity: {
		credentialKind: "ORGANIZATION_API_KEY",
		credentialId: "example-key",
	},
} as GatewaySession;
const call = (
	op: string,
	args: Record<string, unknown> = {},
	actor = session,
) =>
	createHarnessTriageTools().handlers.get(`fabric_triage_${op}`)!(
		{ projectId: "example-project", ...args },
		actor,
	);
beforeEach(() => {
	vi.resetAllMocks();
	for (const command of Object.values(commands)) {
		command.mockResolvedValue({ version: 1 });
	}
});

describe("private triage MCP authorization boundary", () => {
	it.each(["list", "start", "status", "result", "cancel", "review"])(
		"exposes %s through the canonical operation with authenticated identity",
		async (op) => {
			const out = await call(op);
			expect(out.isError).not.toBe(true);
			expect(commands[op]).toHaveBeenCalledWith(
				expect.objectContaining({
					userId: session.userId,
					organizationBinding: {
						organizationId: session.organizationId,
					},
					credential: {
						kind: "ORGANIZATION_API_KEY",
						id: "example-key",
						scopes: ["*"],
					},
				}),
				{ projectId: "example-project" },
			);
			expect(out.structuredContent).toEqual({
				version: 1,
				projectId: "example-project",
			});
		},
	);
	it.each(["service", "organization-key"])(
		"refuses %s without a verified key identity",
		async (credential) => {
			const result = await call("result", {}, {
				...session,
				credential,
				keyIdentity: undefined,
			} as GatewaySession);
			expect(result.isError).toBe(true);
			expect(commands.result).not.toHaveBeenCalled();
		},
	);
	it("refuses missing scopes before object lookup", async () => {
		const result = await call(
			"result",
			{},
			{ ...session, scopes: ["projects:read"] },
		);
		expect(JSON.stringify(result)).toContain("INSUFFICIENT_SCOPE");
		expect(commands.result).not.toHaveBeenCalled();
	});
	it("refuses crossing the MCP project binding", async () => {
		const result = await call(
			"result",
			{},
			{ ...session, projectId: "example-other-project" },
		);
		expect(JSON.stringify(result)).toContain("NOT_FOUND");
		expect(commands.result).not.toHaveBeenCalled();
	});
	it("keeps sanitized operation error codes distinguishable", async () => {
		commands.result.mockRejectedValue(
			new ORPCError("FORBIDDEN", {
				message: "Current access is unavailable.",
				data: { code: "INSUFFICIENT_PERMISSION" },
			}),
		);
		expect(JSON.stringify(await call("result"))).toContain(
			"INSUFFICIENT_PERMISSION",
		);
	});
});
