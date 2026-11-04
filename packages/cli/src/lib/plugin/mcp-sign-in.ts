/**
 * The MCP step of `fabric instructions init --mcp-sign-in`, as the checklist
 * shows it. The plugin's MCP server is listed in Claude Code as
 * `plugin:<plugin>:fabric`; it is signed in only when the rendered plugin names
 * `fabric mcp header` as its `headersHelper` (`render.ts`), which Claude Code
 * runs at every connection and then does not fall back to its own OAuth.
 */
import type { Summary } from "../summary.js";
import { CLAUDE_PLUGIN_MCP_SERVER, pluginNameFor } from "./layout.js";

/** How the MCP gateway sign-in of `init --mcp-sign-in` went. */
export type McpSignIn = "signed-in" | "already" | "no-browser" | "failed";

/** The name Claude Code lists the plugin's MCP server under in `/mcp`. */
export function pluginMcpServerName(projectId: string): string {
	return `plugin:${pluginNameFor(projectId)}:${CLAUDE_PLUGIN_MCP_SERVER}`;
}

/**
 * The MCP step of the checklist. "Signed in" only when the plugin Claude Code
 * loads asks this CLI for its header; otherwise the one step that does sign it
 * in, for the server name `/mcp` shows.
 */
export function reportMcpSignIn(
	summary: Summary,
	input: {
		signIn: McpSignIn;
		/** Whether the rendered Claude Code plugin carries the header command; `null` when none was rendered. */
		headersHelper: boolean | null;
		serverName: string;
	},
): void {
	const label = "MCP sign-in";
	if (input.headersHelper === null) {
		return;
	}
	const step = `In Claude Code, run /mcp → ${input.serverName} → Authenticate.`;
	if (input.headersHelper) {
		summary.add(
			"ok",
			label,
			input.signIn === "already"
				? "already signed in"
				: "signed in (connects next session)",
			[
				`Claude Code's ${input.serverName} server takes its sign-in from this CLI; it connects at the next session.`,
			],
		);
		return;
	}
	const why =
		input.signIn === "no-browser"
			? "The sign-in needs a terminal and a browser"
			: input.signIn === "failed"
				? "The browser sign-in did not finish"
				: "The plugin could not be given this CLI's sign-in";
	summary.add("action", label, "needs sign-in (see below)", [
		`${why}, so ${input.serverName} signs in through Claude Code. ${step}`,
	]);
	summary.todo(step);
}
