/**
 * MCP App HTML is third-party content loaded through a blob: URL. A blob:
 * document inherits the creating page's origin, so `allow-same-origin` in the
 * iframe sandbox would hand a malicious MCP server the app's DOM, storage and
 * session-cookie API access. Both places that declare the sandbox (the iframe
 * attribute and the sandbox-proxy `sendSandboxResourceReady` payload) must use
 * the shared constant and that constant must not grant same-origin.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const FRAME_PATH = join(
	process.cwd(),
	"components/ai-elements/McpAppFrame.tsx",
);

describe("McpAppFrame iframe sandbox", () => {
	const source = readFileSync(FRAME_PATH, "utf-8");

	it("never grants allow-same-origin to MCP app content", () => {
		expect(source).not.toContain('allow-same-origin"');
		expect(source).not.toMatch(/sandbox\s*=\s*"[^"]*allow-same-origin/);
	});

	it("declares the sandbox once and uses it for both the iframe and the sandbox proxy", () => {
		const declaration = source.match(
			/const MCP_APP_IFRAME_SANDBOX = "([^"]+)";/,
		);
		expect(declaration).not.toBeNull();
		const flags = (declaration?.[1] ?? "").split(/\s+/);
		expect(flags).toContain("allow-scripts");
		expect(flags).not.toContain("allow-same-origin");
		expect(flags).not.toContain("allow-top-navigation");
		expect(source).toContain("sandbox={MCP_APP_IFRAME_SANDBOX}");
		expect(source).toContain("sandbox: MCP_APP_IFRAME_SANDBOX,");
	});
});
