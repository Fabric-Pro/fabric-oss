/**
 * No test starts the real `claude` or `codex`.
 *
 * `fabric instructions init` registers a project's MCP server with each coding
 * tool through that tool's own command line, which writes to the developer's
 * real configuration: Claude Code's `~/.claude.json` and Codex's global
 * `config.toml`. A test that reached them would leave an entry behind for every
 * run. This setup file, loaded for every test file, replaces the runner with one
 * that fails loudly, so a test that has not said what the tools answer cannot
 * touch the machine's own. A test that is about the registration mocks
 * `agent-run.js` itself, and the one that is about the runner itself unmocks it
 * and gives it a stand-in `PATH` made of files it wrote.
 */
import { vi } from "vitest";

vi.mock("../../src/lib/instructions/agent-run.js", () => ({
	createAgentRunner: () => {
		throw new Error(
			"A test reached the real claude or codex. Mock ../src/lib/instructions/agent-run.js, or pass --no-mcp.",
		);
	},
}));
