import { describe, expect, it } from "vitest";
import {
	instructionPathOf,
	repositoryWebUrl,
	resolveInstructionLink,
} from "../instruction-links";

describe("resolveInstructionLink", () => {
	const FILE = ".claude/skills/review/SKILL.md";

	it("resolves a relative path from the folder of the file holding it", () => {
		expect(resolveInstructionLink("./docs/a.md", FILE, "")).toEqual({
			kind: "path",
			repoPath: ".claude/skills/review/docs/a.md",
			hash: "",
		});
		expect(resolveInstructionLink("../README.md", FILE, "")).toEqual({
			kind: "path",
			repoPath: ".claude/skills/README.md",
			hash: "",
		});
	});

	it("reads a leading slash as the repository root, and keeps the fragment", () => {
		expect(
			resolveInstructionLink("/docs/a.md?plain=1#intro", FILE, ""),
		).toEqual({ kind: "path", repoPath: "docs/a.md", hash: "#intro" });
	});

	it("starts from where the instructions sit inside the repository", () => {
		expect(
			resolveInstructionLink("../README.md", "CLAUDE.md", "agents"),
		).toEqual({ kind: "path", repoPath: "README.md", hash: "" });
		expect(
			resolveInstructionLink("rules/a.md", "CLAUDE.md", "agents"),
		).toEqual({ kind: "path", repoPath: "agents/rules/a.md", hash: "" });
	});

	it("stops at the repository root instead of climbing out of it", () => {
		expect(resolveInstructionLink("../../x.md", "CLAUDE.md", "")).toEqual({
			kind: "path",
			repoPath: "x.md",
			hash: "",
		});
	});

	it("tells an address, an in-page anchor and a path apart", () => {
		expect(
			resolveInstructionLink("https://example.com/a", FILE, ""),
		).toEqual({ kind: "external", href: "https://example.com/a" });
		expect(resolveInstructionLink("//example.com/a", FILE, "").kind).toBe(
			"external",
		);
		expect(
			resolveInstructionLink("mailto:a@example.com", FILE, "").kind,
		).toBe("external");
		expect(resolveInstructionLink("#usage", FILE, "")).toEqual({
			kind: "anchor",
			hash: "#usage",
		});
	});
});

describe("instructionPathOf", () => {
	it("maps a repository path into the instructions folder, or to null outside it", () => {
		expect(instructionPathOf("agents/rules/a.md", "agents")).toBe(
			"rules/a.md",
		);
		expect(instructionPathOf("README.md", "agents")).toBeNull();
		expect(instructionPathOf("docs/a.md", "")).toBe("docs/a.md");
	});
});

describe("repositoryWebUrl", () => {
	const base = {
		repositoryUrl: "https://example.com/example-org/instructions.git/",
		ref: "feature/x y",
	};

	it("names the ref for each provider", () => {
		expect(repositoryWebUrl({ ...base, provider: "GITHUB" })).toBe(
			"https://example.com/example-org/instructions/tree/feature/x%20y",
		);
		expect(repositoryWebUrl({ ...base, provider: "GITLAB" })).toBe(
			"https://example.com/example-org/instructions/-/tree/feature/x%20y",
		);
		expect(repositoryWebUrl({ ...base, provider: "AZURE_DEVOPS" })).toBe(
			"https://example.com/example-org/instructions?version=GBfeature%2Fx+y",
		);
	});

	it("names a file at the ref for each provider", () => {
		expect(
			repositoryWebUrl({ ...base, provider: "GITHUB" }, "docs/a b.md"),
		).toBe(
			"https://example.com/example-org/instructions/blob/feature/x%20y/docs/a%20b.md",
		);
		expect(
			repositoryWebUrl({ ...base, provider: "GITLAB" }, "docs/a.md"),
		).toBe(
			"https://example.com/example-org/instructions/-/blob/feature/x%20y/docs/a.md",
		);
		expect(
			repositoryWebUrl(
				{ ...base, provider: "AZURE_DEVOPS" },
				"docs/a.md",
			),
		).toBe(
			"https://example.com/example-org/instructions?path=%2Fdocs%2Fa.md&version=GBfeature%2Fx+y",
		);
	});

	it("falls back to the repository's own address for a provider it does not know", () => {
		expect(
			repositoryWebUrl({ ...base, provider: "OTHER" }, "docs/a.md"),
		).toBe("https://example.com/example-org/instructions");
	});
});
