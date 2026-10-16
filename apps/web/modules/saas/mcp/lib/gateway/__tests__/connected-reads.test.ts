/**
 * A page reads the viewer's own connected servers, and only what the server
 * itself calls read-only.
 *
 * Both checks come from the server and not from a guess at a tool's name: the
 * author's server when the declaration is saved, the viewer's server when it is
 * run. A viewer who has no such server gets `not_connected` for the page to
 * show, and a result is capped because it goes to a page's script.
 *
 * Run with: pnpm --filter web test modules/saas/mcp/lib/gateway/__tests__/connected-reads
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getConnectedServers: vi.fn(),
	executeConnectedServerTool: vi.fn(),
}));

vi.mock("../tool-aggregator", () => ({
	getConnectedServers: mocks.getConnectedServers,
	executeConnectedServerTool: mocks.executeConnectedServerTool,
}));

import { PAGE_CONNECTED_RESULT_MAX_BYTES } from "@repo/temporal/fabric-page-tool-definitions";
import {
	connectedDeclarationRefusal,
	locateConnectedTool,
	readConnectedTool,
} from "../connected-reads";
import type { ConnectedServerInfo, GatewaySession } from "../types";

const owner = { userId: "user-1", organizationId: "org-1" };

const session: GatewaySession = {
	sessionId: "sess-1",
	userId: "user-1",
	organizationId: "org-1",
	projectId: null,
	userName: "Example Viewer",
	email: "viewer@example.com",
	role: "user",
	credential: "session",
	scopes: ["*"],
	createdAt: new Date("2026-01-01T00:00:00Z"),
	expiresAt: new Date("2026-01-02T00:00:00Z"),
};

function server(
	displayName: string,
	toolPrefix: string,
	tools: ConnectedServerInfo["tools"],
): ConnectedServerInfo {
	return { configId: `config-${toolPrefix}`, displayName, toolPrefix, tools };
}

const github = server("GitHub", "gh", [
	{ name: "list_issues", annotations: { readOnlyHint: true } },
	{ name: "create_issue", annotations: { readOnlyHint: false } },
	{ name: "get_repo" },
]);
const custom = server("Acme Tracker", "acme", [
	{ name: "list_tickets", annotations: { readOnlyHint: true } },
]);

function text(value: string) {
	return { content: [{ type: "text" as const, text: value }] };
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getConnectedServers.mockResolvedValue([github, custom]);
	mocks.executeConnectedServerTool.mockResolvedValue(text('{"issues":[]}'));
});

describe("locateConnectedTool", () => {
	it("finds a tool the server marks read-only, by the provider's catalogue key", () => {
		expect(
			locateConnectedTool([github, custom], "github", "list_issues"),
		).toEqual({
			status: "found",
			server: github,
		});
	});

	it("finds a server that has no catalogue key by custom:<prefix>", () => {
		expect(
			locateConnectedTool(
				[github, custom],
				"custom:acme",
				"list_tickets",
			),
		).toEqual({ status: "found", server: custom });
	});

	it("does not take a tool for a read because of its name or a missing annotation", () => {
		for (const tool of ["create_issue", "get_repo"]) {
			expect(
				locateConnectedTool([github], "github", tool).status,
				tool,
			).toBe("not_read_only");
		}
	});

	it("tells a server the person has not connected from a tool the server does not have", () => {
		expect(locateConnectedTool([custom], "github", "list_issues")).toEqual({
			status: "not_connected",
		});
		expect(locateConnectedTool([github], "github", "nope")).toEqual({
			status: "tool_not_found",
		});
	});

	it("reads the tool from whichever of two servers of one provider offers it", () => {
		const second = server("GitHub Enterprise", "ghe", [
			{ name: "list_runs", annotations: { readOnlyHint: true } },
		]);

		expect(
			locateConnectedTool([github, second], "github", "list_runs"),
		).toEqual({
			status: "found",
			server: second,
		});
	});
});

describe("connectedDeclarationRefusal: saving a page with connected reads", () => {
	it("needs nothing from the author's servers when the page declares none", async () => {
		expect(await connectedDeclarationRefusal([], owner)).toBeNull();
		expect(mocks.getConnectedServers).not.toHaveBeenCalled();
	});

	it("accepts a tool the author's own server marks read-only", async () => {
		expect(
			await connectedDeclarationRefusal(
				[{ provider: "github", tool: "list_issues" }],
				owner,
			),
		).toBeNull();
		expect(mocks.getConnectedServers).toHaveBeenCalledWith(owner);
	});

	it("refuses an author who has the provider not connected, naming why", async () => {
		const refusal = await connectedDeclarationRefusal(
			[{ provider: "linear", tool: "list_issues" }],
			owner,
		);

		expect(refusal).toContain("connected:linear/list_issues");
		expect(refusal).toContain("someone who has linear connected");
	});

	it("refuses a tool the author's server does not have", async () => {
		expect(
			await connectedDeclarationRefusal(
				[{ provider: "github", tool: "nope" }],
				owner,
			),
		).toBe("Your github server has no tool nope.");
	});

	it("refuses a tool the author's server does not mark read-only", async () => {
		expect(
			await connectedDeclarationRefusal(
				[{ provider: "github", tool: "create_issue" }],
				owner,
			),
		).toBe(
			"create_issue is not marked read-only by your github server, so a page cannot declare it.",
		);
	});

	it("refuses the page for the first declaration that fails, though others would pass", async () => {
		const refusal = await connectedDeclarationRefusal(
			[
				{ provider: "github", tool: "list_issues" },
				{ provider: "github", tool: "create_issue" },
			],
			owner,
		);

		expect(refusal).toContain("create_issue");
	});
});

describe("readConnectedTool: a page runs its declared read", () => {
	const read = (overrides: Record<string, unknown> = {}) =>
		readConnectedTool({
			provider: "github",
			tool: "list_issues",
			args: { repo: "example/repo" },
			session,
			...overrides,
		} as Parameters<typeof readConnectedTool>[0]);

	it("runs the tool on the viewer's own server, as the viewer's session, with the page's arguments", async () => {
		const result = await read();

		expect(mocks.getConnectedServers).toHaveBeenCalledWith(session);
		expect(mocks.executeConnectedServerTool).toHaveBeenCalledWith(
			"gh__list_issues",
			{ repo: "example/repo" },
			session,
			[github, custom],
		);
		expect(result).toEqual(text('{"issues":[]}'));
	});

	it("answers not_connected, which is not an error, when the viewer has no such server", async () => {
		mocks.getConnectedServers.mockResolvedValue([custom]);

		const result = await read();

		expect(result.isError).toBeUndefined();
		expect(JSON.parse(result.content[0].text)).toEqual({
			error: "not_connected",
			provider: "github",
		});
		expect(mocks.executeConnectedServerTool).not.toHaveBeenCalled();
	});

	it("refuses a tool the viewer's own server does not mark read-only, whatever the page declared", async () => {
		const result = await read({ tool: "create_issue" });

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("not marked read-only");
		expect(mocks.executeConnectedServerTool).not.toHaveBeenCalled();
	});

	it("refuses a tool the viewer's server does not have", async () => {
		const result = await read({ tool: "nope" });

		expect(result.isError).toBe(true);
		expect(mocks.executeConnectedServerTool).not.toHaveBeenCalled();
	});

	it("hands the viewer's session on unchanged, so its server selection still limits the call", async () => {
		const limited: GatewaySession = {
			...session,
			serverSelection: [{ server: "acme", tools: ["list_tickets"] }],
		};

		await read({ session: limited });

		expect(mocks.executeConnectedServerTool.mock.calls[0][2]).toBe(limited);
	});

	it("returns a result up to the cap", async () => {
		const body = "x".repeat(PAGE_CONNECTED_RESULT_MAX_BYTES);
		mocks.executeConnectedServerTool.mockResolvedValue(text(body));

		const result = await read();

		expect(result.isError).toBeUndefined();
		expect(result.content[0].text).toHaveLength(
			PAGE_CONNECTED_RESULT_MAX_BYTES,
		);
	});

	it("refuses a result over the cap, and counts bytes and not characters", async () => {
		mocks.executeConnectedServerTool.mockResolvedValue(
			text("é".repeat(PAGE_CONNECTED_RESULT_MAX_BYTES / 2 + 1)),
		);

		const result = await read();

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Ask for less.");
	});

	it("passes the connected server's own error on, as the server said it", async () => {
		mocks.executeConnectedServerTool.mockResolvedValue({
			content: [{ type: "text", text: '{"error":"rate limited"}' }],
			isError: true,
		});

		const result = await read();

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toBe('{"error":"rate limited"}');
	});
});
