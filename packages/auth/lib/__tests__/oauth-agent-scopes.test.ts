import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	read: vi.fn(),
	execute: vi.fn(),
	schedule: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	canReadOrganizationAgents: m.read,
	canExecuteOrganizationAgents: m.execute,
	canScheduleOrganizationAgents: m.schedule,
}));

import { authorizeOAuthAgentScopes } from "../oauth-agent-scopes";
import { OAUTH_DEFAULT_SCOPES, OAUTH_SCOPES } from "../oauth-scopes";

beforeEach(() => {
	vi.resetAllMocks();
	m.read.mockResolvedValue(true);
	m.execute.mockResolvedValue(true);
	m.schedule.mockResolvedValue(true);
});
describe("explicit agent OAuth grants", () => {
	it.each(["agents:read", "agents:execute", "agents:schedule"])(
		"offers %s only by explicit consent, never by default",
		(scope) => {
			expect(OAUTH_SCOPES).toContain(scope);
			expect(OAUTH_DEFAULT_SCOPES).not.toContain(scope);
		},
	);
	it("checks live grant permissions even when a previous consent exists", async () => {
		const scopes = ["agents:read", "agents:execute", "agents:schedule"];
		await authorizeOAuthAgentScopes(
			"example-user",
			"example-org",
			scopes,
			false,
		);
		m.schedule.mockResolvedValue(false);
		await expect(
			authorizeOAuthAgentScopes(
				"example-user",
				"example-org",
				scopes,
				false,
			),
		).rejects.toMatchObject({ status: "FORBIDDEN" });
		expect(m.schedule).toHaveBeenCalledTimes(2);
	});
	it("cannot grant persistent work without its execution ceiling", async () => {
		await expect(
			authorizeOAuthAgentScopes(
				"example-user",
				"example-org",
				["agents:schedule"],
				false,
			),
		).rejects.toMatchObject({ status: "FORBIDDEN" });
		expect(m.schedule).not.toHaveBeenCalled();
	});
	it("refuses project-bound controls before a permission read", async () => {
		await expect(
			authorizeOAuthAgentScopes(
				"example-user",
				"example-org",
				["agents:read"],
				true,
			),
		).rejects.toMatchObject({ status: "FORBIDDEN" });
		expect(m.read).not.toHaveBeenCalled();
	});
	it.each(["read", "execute", "schedule"] as const)(
		"refuses revoked %s permission at grant time",
		async (permission) => {
			m[permission].mockResolvedValue(false);
			await expect(
				authorizeOAuthAgentScopes(
					"example-user",
					"example-org",
					["agents:read", "agents:execute", "agents:schedule"],
					false,
				),
			).rejects.toMatchObject({ status: "FORBIDDEN" });
		},
	);
	it("leaves existing coding-instruction defaults unchanged", async () => {
		await authorizeOAuthAgentScopes(
			"example-user",
			"example-org",
			OAUTH_DEFAULT_SCOPES,
			true,
		);
		expect(m.read).not.toHaveBeenCalled();
		expect(m.execute).not.toHaveBeenCalled();
	});
});
