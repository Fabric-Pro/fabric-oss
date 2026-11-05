import archiver from "archiver";
import { describe, expect, it, vi } from "vitest";
import { readSkillPackage, safeSkillPackagePath } from "../skill-package";

const md =
	"---\nname: delivery-brief\ndescription: Use when preparing a weekly delivery update.\n---\n# Delivery brief\nUse references/checklist.md and produce a cited summary.";
async function zip(
	files: Array<[string, string | Buffer]>,
	symlink: boolean | string = false,
) {
	const a = archiver("zip", { zlib: { level: 9 } });
	const chunks: Buffer[] = [];
	const result = new Promise<Buffer>((resolve, reject) => {
		a.on("data", (c: Buffer) => chunks.push(c));
		a.on("error", reject);
		a.on("end", () => resolve(Buffer.concat(chunks)));
	});
	for (const [name, data] of files) {
		a.append(data, { name });
	}
	if (symlink) {
		a.symlink(
			typeof symlink === "string" ? symlink : "escape",
			"../outside",
		);
	}
	await a.finalize();
	return result;
}
const source = (data: Buffer, fileName = "example.skill") => ({
	kind: "file" as const,
	fileName,
	base64: data.toString("base64"),
});
describe("review-only skill package parsing", () => {
	it("reads standard SKILL.md with purpose and bounded runtime manifest", async () => {
		const bytes = await zip([
			["delivery/SKILL.md", md],
			["delivery/references/checklist.md", "# Check risks and sources"],
			["delivery/scripts/check.py", 'print("example")'],
		]);
		const result = await readSkillPackage(source(bytes));
		expect(result.preview.candidates).toHaveLength(1);
		expect(result.preview.candidates[0]).toMatchObject({
			key: "delivery/SKILL.md",
			draft: {
				name: "delivery-brief",
				slug: "delivery-brief",
				description: "Use when preparing a weekly delivery update.",
			},
			files: [
				{
					path: "references/checklist.md",
					contentType: "text/markdown",
				},
				{ path: "scripts/check.py", contentType: "text/x-python" },
			],
		});
		expect(result.preview.source.sha256).toMatch(/^[a-f0-9]{64}$/);
		expect(result.preview.candidates[0].warnings.join(" ")).toContain(
			"does not execute scripts",
		);
	});
	it("imports plain SKILL.md without turning metadata into runtime authority", async () => {
		const r = await readSkillPackage(
			source(
				Buffer.from(
					md.replace("---\n#", "allowed-tools: [shell]\n---\n#"),
				),
				"SKILL.md",
			),
		);
		expect(r.preview.candidates[0].warnings.join(" ")).toContain(
			"not applied",
		);
		expect(r.preview.candidates[0].draft.content).not.toContain(
			"allowed-tools",
		);
	});
	it("keeps nested skill files within their own candidate", async () => {
		const bytes = await zip([
			["repo/SKILL.md", md],
			["repo/root.txt", "root"],
			[
				"repo/child/SKILL.md",
				md.replace("delivery-brief", "child-skill"),
			],
			["repo/child/references/check.md", "child"],
		]);
		const r = await readSkillPackage(source(bytes));
		expect(r.preview.candidates[0].files.map((f) => f.path)).toEqual([
			"root.txt",
		]);
		expect(r.preview.candidates[1].files.map((f) => f.path)).toEqual([
			"references/check.md",
		]);
	});
	it.each([
		"../secret",
		"/absolute",
		"a/../../b",
		"C:\\secret",
		"a\\secret",
		"a/./x",
		"a/\0x",
	])("rejects unsafe resource path %j", (path) =>
		expect(() => safeSkillPackagePath(path)).toThrow(),
	);
	it("rejects corrupt CRC instead of accepting changed archive contents", async () => {
		const b = Buffer.from(await zip([["SKILL.md", md]]));
		const central = b.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
		b[central + 16] ^= 1;
		await expect(readSkillPackage(source(b))).rejects.toThrow(/corrupt/);
	});
	it("rejects duplicate archive paths", async () => {
		await expect(
			readSkillPackage(
				source(
					await zip([
						["SKILL.md", md],
						["SKILL.md", md],
					]),
				),
			),
		).rejects.toThrow(/duplicate/);
	});
	it("rejects symlink and credential entries without reading their targets", async () => {
		await expect(
			readSkillPackage(source(await zip([["SKILL.md", md]], true))),
		).rejects.toThrow(/symbolic/);
		await expect(
			readSkillPackage(
				source(
					await zip([
						["SKILL.md", md],
						[".env", "EXAMPLE=not-a-secret"],
					]),
				),
			),
		).rejects.toThrow(/credential/);
	});
	it("bounds decompression and Markdown size", async () => {
		await expect(
			readSkillPackage(
				source(
					await zip([
						["SKILL.md", md],
						["huge.txt", Buffer.alloc(2 * 1024 * 1024 + 1, 65)],
					]),
				),
			),
		).rejects.toThrow(/limits/);
		await expect(
			readSkillPackage(
				source(Buffer.alloc(128 * 1024 + 1, 65), "SKILL.md"),
			),
		).rejects.toThrow(/128 KiB/);
	});
	it.each([
		"not-frontmatter",
		"---\nname: only-name\n---\nBody",
		"---\nname: a\nname: b\ndescription: duplicate\n---\nBody",
		"---\nname: &name example\ndescription: *name\n---\nBody",
	])("refuses invalid or aliased frontmatter", async (value) => {
		await expect(
			readSkillPackage(source(Buffer.from(value), "SKILL.md")),
		).rejects.toThrow();
	});
	it("rejects noncanonical base64 and unsupported files", async () => {
		await expect(
			readSkillPackage({
				kind: "file",
				fileName: "SKILL.md",
				base64: "YW Jj",
			}),
		).rejects.toThrow(/encoding/);
		await expect(
			readSkillPackage(source(Buffer.from(md), "example.exe")),
		).rejects.toThrow(/Upload/);
	});
	it.each([
		"http://github.com/example/skills",
		"https://example.com/a/b",
		"https://user:pass@github.com/example/skills",
		"https://github.com/example/skills?token=example",
		"https://github.com/example/skills/tree/main",
	])("refuses repository source %s before network access", async (url) => {
		const fetcher = vi.fn();
		await expect(
			readSkillPackage({ kind: "github", url }, fetcher),
		).rejects.toThrow();
		expect(fetcher).not.toHaveBeenCalled();
	});
	it("pins a public repository to a verified commit and never follows redirects or sends credentials", async () => {
		const bytes = await zip([["repo-commit/delivery/SKILL.md", md]]);
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ sha: "a".repeat(40) })),
			)
			.mockResolvedValueOnce(new Response(bytes));
		const r = await readSkillPackage(
			{
				kind: "github",
				url: "https://github.com/example/skills",
				ref: "main",
			},
			fetcher,
		);
		expect(r.preview.source).toMatchObject({
			repository: "https://github.com/example/skills",
			commit: "a".repeat(40),
		});
		expect(fetcher.mock.calls[1][0]).toBe(
			`https://codeload.github.com/example/skills/zip/${"a".repeat(40)}`,
		);
		expect(
			fetcher.mock.calls.every(
				(c) =>
					c[1].redirect === "error" &&
					!("Authorization" in c[1].headers),
			),
		).toBe(true);
	});
	it("imports repository skill folders without following unrelated metadata links", async () => {
		const bytes = await zip(
			[
				["repo/skills/one/SKILL.md", md],
				["repo/skills/one/references/check.md", "Example reference"],
				["repo/.env", "EXAMPLE=not-imported"],
				["repo/README.md", "Not skill data"],
			],
			"repo/CLAUDE.md",
		);
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ sha: "b".repeat(40) })),
			)
			.mockResolvedValueOnce(new Response(bytes));
		const r = await readSkillPackage(
			{ kind: "github", url: "https://github.com/example/skills" },
			fetcher,
		);
		expect(r.entries.map((e) => e.path)).toEqual([
			"repo/skills/one/SKILL.md",
			"repo/skills/one/references/check.md",
		]);
		expect(r.preview.warnings.join(" ")).toContain(
			"Unrelated repository files and links are excluded",
		);
	});
	it("refuses links within a repository skill instead of silently omitting resources", async () => {
		const bytes = await zip(
			[["repo/skills/one/SKILL.md", md]],
			"repo/skills/one/references/linked.md",
		);
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ sha: "b".repeat(40) })),
			)
			.mockResolvedValueOnce(new Response(bytes));
		await expect(
			readSkillPackage(
				{ kind: "github", url: "https://github.com/example/skills" },
				fetcher,
			),
		).rejects.toThrow(/symbolic links/);
	});
	it("bounds repository resources per candidate while allowing a collection over128 files", async () => {
		const files: Array<[string, string | Buffer]> = [
			["repo/one/SKILL.md", md],
			["repo/two/SKILL.md", md],
		];
		for (let i = 0; i < 70; i++) {
			files.push(
				[`repo/one/references/${i}.md`, "Reference"],
				[`repo/two/references/${i}.md`, "Reference"],
			);
		}
		const bytes = await zip(files);
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ sha: "b".repeat(40) })),
			)
			.mockResolvedValueOnce(new Response(bytes));
		const r = await readSkillPackage(
			{ kind: "github", url: "https://github.com/example/skills" },
			fetcher,
		);
		expect(r.preview.candidates).toHaveLength(2);
		expect(r.preview.candidates.every((c) => c.files.length === 70)).toBe(
			true,
		);
		const excessive = await zip([
			["repo/SKILL.md", md],
			...Array.from(
				{ length: 129 },
				(_, i) =>
					[`repo/references/${i}.md`, "Reference"] as [
						string,
						string,
					],
			),
		]);
		const tooMany = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ sha: "b".repeat(40) })),
			)
			.mockResolvedValueOnce(new Response(excessive));
		await expect(
			readSkillPackage(
				{ kind: "github", url: "https://github.com/example/skills" },
				tooMany,
			),
		).rejects.toThrow(/128-file/);
	});
	it("keeps other reviewed repository skills selectable when one candidate exceeds the file cap", async () => {
		const bytes = await zip([
			["repo/large/SKILL.md", md],
			["repo/small/SKILL.md", md],
			...Array.from(
				{ length: 129 },
				(_, i) =>
					[`repo/large/references/${i}.md`, "Reference"] as [
						string,
						string,
					],
			),
		]);
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ sha: "b".repeat(40) })),
			)
			.mockResolvedValueOnce(new Response(bytes));
		const r = await readSkillPackage(
			{ kind: "github", url: "https://github.com/example/skills" },
			fetcher,
		);
		expect(r.preview.candidates.map((c) => c.key)).toEqual([
			"repo/small/SKILL.md",
		]);
		expect(r.preview.warnings.join(" ")).toContain(
			"Skipped repo/large/SKILL.md",
		);
	});
	it.each([".env.local", "references/.env.production", ".ENV.secrets"])(
		"rejects credential environment variant %s",
		async (path) => {
			const bytes = await zip([
				["SKILL.md", md],
				[path, "EXAMPLE=not-a-secret"],
			]);
			await expect(readSkillPackage(source(bytes))).rejects.toThrow(
				/credential/,
			);
		},
	);
});
