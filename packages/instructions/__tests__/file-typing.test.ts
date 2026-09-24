import { describe, expect, it } from "vitest";
import { fileTypingFor } from "../src/file-typing";

describe("fileTypingFor", () => {
	it.each([
		["CLAUDE.md", "text/markdown", true],
		[".cursor/rules/style.mdc", "text/markdown", true],
		["scripts/run.sh", "text/x-shellscript", true],
		[".gitignore", "application/octet-stream", true],
		["Makefile", "application/octet-stream", true],
		["assets/logo.png", "image/png", false],
		["bin/tool.exe", "application/octet-stream", false],
		["docs/Guide.MD", "text/markdown", true],
	] as const)("%s → %s (isText %s)", (path, mimeType, isText) => {
		expect(fileTypingFor(path)).toEqual({ mimeType, isText });
	});
});
