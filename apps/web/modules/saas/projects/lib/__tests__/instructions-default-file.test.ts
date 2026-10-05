import { describe, expect, it } from "vitest";
import { defaultSelectedPath } from "../instructions-default-file";

const files = (...paths: string[]) => paths.map((path) => ({ path }));

describe("defaultSelectedPath", () => {
	it("opens the root CLAUDE.md", () => {
		expect(
			defaultSelectedPath(files("AGENTS.md", "CLAUDE.md", "README.md")),
		).toBe("CLAUDE.md");
	});

	it("falls back to the root AGENTS.md", () => {
		expect(defaultSelectedPath(files("README.md", "AGENTS.md"))).toBe(
			"AGENTS.md",
		);
	});

	it("chooses nothing when neither is at the root", () => {
		expect(
			defaultSelectedPath(
				files(
					"docs/CLAUDE.md",
					".claude/agents/AGENTS.md",
					"README.md",
				),
			),
		).toBeNull();
		expect(defaultSelectedPath([])).toBeNull();
	});
});
