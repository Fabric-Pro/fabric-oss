import { describe, expect, it } from "vitest";
import { validateMcpCommandArgs } from "../prisma/mcp-command-args";

const azureDevOps = { key: "azure-devops", isSystemProvided: true };

describe("MCP command arguments", () => {
	it.each(["a", "Example-Org-9", "a".repeat(50)])("accepts %s", (name) => {
		expect(validateMcpCommandArgs(azureDevOps, [name])).toEqual({
			ok: true,
		});
	});

	it.each([
		{ label: "zero arguments", args: [] },
		{ label: "two arguments", args: ["example-org", "another-org"] },
		{ label: "empty name", args: [""] },
		{ label: "overlong name", args: ["a".repeat(51)] },
		{ label: "leading hyphen", args: ["-example"] },
		{ label: "trailing hyphen", args: ["example-"] },
		{ label: "flag", args: ["--flag"] },
		{ label: "path", args: ["/"] },
		{ label: "URL", args: ["https://example.com/example-org"] },
		{ label: "non-ASCII letter", args: ["exämple-org"] },
		{ label: "embedded whitespace", args: ["example org"] },
		{ label: "terminal newline", args: ["example-org\n"] },
	])("refuses $label", ({ args }) => {
		expect(validateMcpCommandArgs(azureDevOps, args)).toMatchObject({
			ok: false,
		});
	});

	it.each([
		{ key: "example-server", isSystemProvided: true },
		{ key: "azure-devops", isSystemProvided: false },
		null,
	])("accepts only empty arguments without a policy (%j)", (server) => {
		expect(validateMcpCommandArgs(server, [])).toEqual({ ok: true });
		expect(validateMcpCommandArgs(server, ["example-org"])).toMatchObject({
			ok: false,
		});
	});
});
