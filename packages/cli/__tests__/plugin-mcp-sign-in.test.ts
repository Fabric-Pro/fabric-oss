/**
 * The Coding Instructions plugin's MCP server takes its sign-in from the CLI:
 * `fabric mcp header` is the server's `headersHelper`, and `init` says the
 * server is signed in only when the plugin it rendered carries that command.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const token = vi.hoisted(() => ({
	access: vi.fn<
		(
			origin: string,
			projectId: string,
			signal?: AbortSignal,
		) => Promise<string | null>
	>(),
}));
vi.mock("../src/lib/oauth/mcp-token.js", () => ({
	mcpAccessToken: token.access,
	hasMcpSignIn: () => false,
}));

import { buildMcpCommand } from "../src/commands/mcp/index.js";
import { reportMcpSignIn } from "../src/lib/plugin/mcp-sign-in.js";
import { renderSummary, Summary } from "../src/lib/summary.js";

const PROJECT = "cmexampleproject0123456789";
const SERVER = "plugin:example:fabric";
const ACCESS_TOKEN = "example-access-token-0123456789";

describe("fabric mcp header", () => {
	let stdout: string[];
	let stderr: string[];

	beforeEach(() => {
		stdout = [];
		stderr = [];
		process.exitCode = undefined;
		vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
			stdout.push(String(chunk));
			return true;
		});
		vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
			stderr.push(String(chunk));
			return true;
		});
		vi.spyOn(console, "log").mockImplementation(() => undefined);
		vi.spyOn(console, "error").mockImplementation(() => undefined);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		token.access.mockReset();
		process.exitCode = undefined;
	});

	const header = (baseUrl = "https://example.com/some/path") =>
		buildMcpCommand().parseAsync([
			"node",
			"fabric",
			"header",
			"--project",
			PROJECT,
			"--base-url",
			baseUrl,
		]);

	it("prints the Authorization header as one JSON object and nothing else", async () => {
		token.access.mockResolvedValue(ACCESS_TOKEN);

		await header();

		expect(token.access).toHaveBeenCalledWith(
			"https://example.com",
			PROJECT,
			expect.any(AbortSignal),
		);
		expect(stdout.join("")).toBe(
			`${JSON.stringify({ Authorization: `Bearer ${ACCESS_TOKEN}` })}\n`,
		);
		expect(stderr.join("")).not.toContain(ACCESS_TOKEN);
		expect(console.log).not.toHaveBeenCalled();
		expect(console.error).not.toHaveBeenCalled();
		expect(process.exitCode ?? 0).toBe(0);
	});

	it("prints an empty object when there is no sign-in, so Claude Code signs in itself", async () => {
		token.access.mockResolvedValue(null);

		await header();

		expect(stdout.join("")).toBe("{}\n");
		expect(process.exitCode ?? 0).toBe(0);
	});

	it("prints an empty object, and no error text, when the refresh fails or the address is not one", async () => {
		token.access.mockRejectedValue(new Error(`refused ${ACCESS_TOKEN}`));
		await header();
		await header("not a url");

		expect(stdout.join("")).toBe("{}\n{}\n");
		expect(stderr.join("")).toBe("");
		expect(process.exitCode ?? 0).toBe(0);
	});
});

describe("the MCP step of init's checklist", () => {
	const lines = (summary: Summary) =>
		renderSummary(summary, { ascii: true }).split("\n");

	it("is signed in when the rendered plugin asks this CLI for the header", () => {
		const summary = new Summary();

		reportMcpSignIn(summary, {
			signIn: "signed-in",
			headersHelper: true,
			serverName: SERVER,
		});

		expect(summary.steps).toEqual([
			expect.objectContaining({
				status: "ok",
				label: "MCP sign-in",
				detail: "signed in (connects next session)",
			}),
		]);
		expect(summary.next).toEqual([]);
	});

	it("says already signed in for an earlier sign-in", () => {
		const summary = new Summary();

		reportMcpSignIn(summary, {
			signIn: "already",
			headersHelper: true,
			serverName: SERVER,
		});

		expect(summary.steps[0]?.detail).toBe("already signed in");
	});

	it.each([
		["signed-in", "could not be given this CLI's sign-in"],
		["already", "could not be given this CLI's sign-in"],
		["failed", "did not finish"],
		["no-browser", "needs a terminal and a browser"],
	] as const)(
		"needs the /mcp step when the plugin has no header command (%s)",
		(signIn, why) => {
			const summary = new Summary();

			reportMcpSignIn(summary, {
				signIn,
				headersHelper: false,
				serverName: SERVER,
			});

			const step = summary.steps[0];
			expect(step?.status).toBe("action");
			expect(step?.detail).toBe("needs sign-in (see below)");
			expect(step?.details.join(" ")).toContain(why);
			expect(summary.next).toEqual([
				{
					text: `In Claude Code, run /mcp → ${SERVER} → Authenticate.`,
				},
			]);
			expect(lines(summary)).toContain(
				"[!]  MCP sign-in  needs sign-in (see below)",
			);
			expect(lines(summary)).toContain(
				`  1. In Claude Code, run /mcp → ${SERVER} → Authenticate.`,
			);
		},
	);

	it("adds no step when no Claude Code plugin was set up", () => {
		const summary = new Summary();

		reportMcpSignIn(summary, {
			signIn: "signed-in",
			headersHelper: null,
			serverName: SERVER,
		});

		expect(summary.steps).toEqual([]);
	});
});
