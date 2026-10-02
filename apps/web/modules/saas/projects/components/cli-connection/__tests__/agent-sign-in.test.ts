/**
 * The keyless connect entries, decoded the way each tool decodes them. The
 * formats are each tool's own (cited in `lib/agent-sign-in.ts`); what is pinned
 * here is that every entry names the gateway and carries no credential.
 */

import { describe, expect, it } from "vitest";
import {
	buildClaudeCodeCommand,
	buildCodexCommands,
	buildCursorInstallLink,
	buildPortableMcpConfiguration,
	buildVsCodeInstallLink,
	oauthLoginLine,
} from "../lib/agent-sign-in";

const ORIGIN = "https://app.example.com";
const GATEWAY = `${ORIGIN}/api/mcp-gateway`;

describe("keyless connect entries", () => {
	it("adds the gateway to Claude Code over HTTP", () => {
		expect(buildClaudeCodeCommand(ORIGIN)).toBe(
			`claude mcp add --transport http fabric ${GATEWAY}`,
		);
	});

	it("builds a VS Code install link whose payload is the URL-encoded server JSON", () => {
		const link = buildVsCodeInstallLink(ORIGIN);
		const prefix = "vscode:mcp/install?";

		expect(link.startsWith(prefix)).toBe(true);
		expect(
			JSON.parse(decodeURIComponent(link.slice(prefix.length))),
		).toEqual({ name: "fabric", type: "http", url: GATEWAY });
	});

	it("builds a Cursor install link whose config is the base64 server JSON", () => {
		const url = new URL(buildCursorInstallLink(ORIGIN));

		expect(`${url.protocol}//${url.host}${url.pathname}`).toBe(
			"cursor://anysphere.cursor-deeplink/mcp/install",
		);
		expect(url.searchParams.get("name")).toBe("fabric");
		expect(JSON.parse(atob(url.searchParams.get("config") ?? ""))).toEqual({
			url: GATEWAY,
		});
	});

	it("adds the server to Codex and then signs it in", () => {
		expect(buildCodexCommands(ORIGIN).split("\n")).toEqual([
			`codex mcp add fabric --url ${GATEWAY}`,
			"codex mcp login fabric",
		]);
	});

	it("gives any other client the server alone, with no Authorization header to commit", () => {
		const configuration = buildPortableMcpConfiguration(ORIGIN);

		expect(JSON.parse(configuration)).toEqual({
			mcpServers: { fabric: { type: "http", url: GATEWAY } },
		});
		expect(configuration).not.toMatch(/authorization|bearer|headers/i);
	});

	it("signs the CLI in through the browser, with no key on the line", () => {
		expect(oauthLoginLine(ORIGIN)).toBe(
			`fabric auth login --base-url ${ORIGIN}`,
		);
	});
});
