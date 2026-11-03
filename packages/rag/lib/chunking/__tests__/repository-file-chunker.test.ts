import { describe, expect, it } from "vitest";
import {
	chunkConfigByKeys,
	chunkDocByHeadings,
	chunkRepositoryFile,
	repositoryFileKind,
} from "../repository-file-chunker";

const joined = (chunks: Array<{ content: string }>) =>
	chunks.map((chunk) => chunk.content).join("");

describe("repositoryFileKind", () => {
	it("sorts docs, config and code by extension", () => {
		expect(repositoryFileKind("docs/README.md")).toBe("doc");
		expect(repositoryFileKind("notes.TXT")).toBe("doc");
		expect(repositoryFileKind("deploy/values.yaml")).toBe("config");
		expect(repositoryFileKind("package.json")).toBe("config");
		expect(repositoryFileKind("src/App.cs")).toBe("code");
		expect(repositoryFileKind("Makefile")).toBe("code");
	});
});

describe("chunkDocByHeadings", () => {
	const section = (title: string, level = 2) =>
		`${"#".repeat(level)} ${title}\n\n${`${title} text. `.repeat(120)}\n\n`;

	it("cuts at headings, keeps the heading path and covers the file", () => {
		const text = `# Guide\n\nIntro.\n\n${section("Setup")}${section("Docker", 3)}${section("Usage")}`;
		const chunks = chunkDocByHeadings(text);

		expect(joined(chunks)).toBe(text);
		expect(chunks.length).toBeGreaterThanOrEqual(3);
		const docker = chunks.find((chunk) =>
			chunk.content.startsWith("### Docker"),
		);
		expect(docker?.headings).toEqual(["Guide", "Setup", "Docker"]);
		const usage = chunks.find((chunk) =>
			chunk.content.startsWith("## Usage"),
		);
		expect(usage?.headings).toEqual(["Guide", "Usage"]);
		for (let i = 1; i < chunks.length; i++) {
			expect(chunks[i]?.startLine).toBe(
				(chunks[i - 1]?.endLine ?? 0) + 1,
			);
		}
	});

	it("ignores heading-like lines inside code fences", () => {
		const text = "# Title\n\n```bash\n# not a heading\necho hi\n```\n";
		const chunks = chunkDocByHeadings(text);
		expect(chunks).toHaveLength(1);
		expect(chunks[0]?.headings).toEqual(["Title"]);
	});

	it("joins small sections instead of emitting one chunk each", () => {
		const text = "# A\n\none\n\n# B\n\ntwo\n\n# C\n\nthree\n";
		const chunks = chunkDocByHeadings(text);
		expect(chunks).toHaveLength(1);
		expect(joined(chunks)).toBe(text);
	});

	it("cuts an oversized section by lines without losing text", () => {
		const text = `# Big\n\n${"word ".repeat(40)}\n`.repeat(40);
		const chunks = chunkDocByHeadings(`# Only\n\n${text}`);
		expect(joined(chunks)).toBe(`# Only\n\n${text}`);
		for (const chunk of chunks) {
			expect(chunk.content.length).toBeLessThanOrEqual(3000);
		}
	});
});

describe("chunkConfigByKeys", () => {
	it("cuts YAML at top-level keys and names them", () => {
		const block = (key: string) =>
			`${key}:\n${"  setting: value-that-is-long-enough\n".repeat(60)}`;
		const text = `# comment\n${block("services")}${block("volumes")}${block("networks")}`;
		const chunks = chunkConfigByKeys(text, "docker-compose.yml");

		expect(joined(chunks)).toBe(text);
		expect(chunks.length).toBeGreaterThanOrEqual(2);
		expect(chunks.flatMap((chunk) => chunk.keys ?? [])).toEqual([
			"services",
			"volumes",
			"networks",
		]);
	});

	it("cuts JSON at keys one level inside the root object", () => {
		const entries = Array.from(
			{ length: 30 },
			(_, i) =>
				`  "key${i}": {\n${'    "nested": "a value that takes up space in the file",\n'.repeat(4)}    "end": 1\n  }`,
		);
		const text = `{\n${entries.join(",\n")}\n}\n`;
		const chunks = chunkConfigByKeys(text, "package.json");

		expect(joined(chunks)).toBe(text);
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks[1]?.content.startsWith('  "key')).toBe(true);
	});

	it("cuts TOML at tables", () => {
		const text = `[package]\nname = "x"\n\n[dependencies]\nserde = "1"\n`;
		const chunks = chunkConfigByKeys(text, "Cargo.toml");
		expect(joined(chunks)).toBe(text);
		expect(chunks[0]?.keys).toEqual(["package", "dependencies"]);
	});
});

describe("chunkRepositoryFile", () => {
	it("returns the kind with the chunks", () => {
		expect(chunkRepositoryFile("a.md", "# A\n").kind).toBe("doc");
		expect(chunkRepositoryFile("a.yml", "a: 1\n").kind).toBe("config");
		const code = chunkRepositoryFile("a.cs", "class A {}\n");
		expect(code.kind).toBe("code");
		expect(joined(code.chunks)).toBe("class A {}\n");
	});

	it("returns no chunks for an empty file", () => {
		expect(chunkRepositoryFile("a.md", "").chunks).toEqual([]);
		expect(chunkRepositoryFile("a.json", "").chunks).toEqual([]);
	});
});
