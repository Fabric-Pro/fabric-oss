import { describe, expect, it } from "vitest";
import {
	buildTechnicalGraph,
	buildTechnicalGraphStreaming,
	type FileMeta,
	type FileRecord,
} from "../graph/build";

/**
 * The streaming builder is the memory-bounded core; the array builder
 * (`buildTechnicalGraph`) is a thin wrapper over it. These tests lock in the
 * HARD invariant that both produce IDENTICAL graphs (nodes + edges + module
 * depth + manifest), plus the streaming-only contract that an unreadable file
 * (reader returns null) is dropped exactly as the collector would have skipped
 * it. A mixed-language fixture (relative TS imports + C# namespace deps)
 * exercises file-file edges, module DEPENDS_ON aggregation, and namespace
 * resolution in one shot.
 */
const files: FileRecord[] = [
	{
		path: "src/a/foo.ts",
		content: `import { bar } from "../b/bar";\nexport function foo() { return bar(); }`,
	},
	{ path: "src/b/bar.ts", content: "export function bar() { return 1; }" },
	{ path: "src/b/baz.ts", content: "export const baz = 2;" },
	{
		path: "src/Core/Service.cs",
		content:
			"namespace App.Core;\nusing App.Data;\npublic class Service {}",
	},
	{
		path: "src/Data/Repo.cs",
		content: "namespace App.Data;\npublic class Repo {}",
	},
];

/** Canonicalise so any (non-existent) ordering difference can't mask a diff. */
function canonical(g: Awaited<ReturnType<typeof buildTechnicalGraph>>): string {
	const nodes = [...g.nodes].sort((a, b) => a.key.localeCompare(b.key));
	const edges = [...g.edges].sort((a, b) =>
		`${a.kind} ${a.source} ${a.target} ${a.weight}`.localeCompare(
			`${b.kind} ${b.source} ${b.target} ${b.weight}`,
		),
	);
	return JSON.stringify({
		moduleDepth: g.moduleDepth,
		manifest: Object.fromEntries(Object.entries(g.manifest).sort()),
		nodes,
		edges,
	});
}

describe("buildTechnicalGraphStreaming vs buildTechnicalGraph", () => {
	it("produces a byte-identical graph + manifest from a streaming reader", async () => {
		const contentByPath = new Map(files.map((f) => [f.path, f.content]));
		const streamed = await buildTechnicalGraphStreaming(
			files.map((f) => f.path),
			(p) => contentByPath.get(p) ?? null,
		);
		const inMemory = await buildTechnicalGraph(files);

		// Same node/edge/depth output...
		expect(canonical(streamed)).toEqual(canonical(inMemory));
		// ...and the streaming builder emits the path→hash manifest for free.
		expect(Object.keys(streamed.manifest).sort()).toEqual([
			"src/Core/Service.cs",
			"src/Data/Repo.cs",
			"src/a/foo.ts",
			"src/b/bar.ts",
			"src/b/baz.ts",
		]);
		// Identity holds against the wrapper too (preview/hash byte-for-byte).
		expect(streamed.nodes).toEqual(inMemory.nodes);
		expect(streamed.edges).toEqual(inMemory.edges);
	});

	it("drops a file whose reader returns null (unreadable/oversized), like a skipped collect", async () => {
		// bar.ts is 'missing' from disk → reader returns null → excluded from the
		// graph + manifest, and foo.ts's import of it no longer resolves to a file.
		const contentByPath = new Map(
			files
				.filter((f) => f.path !== "src/b/bar.ts")
				.map((f) => [f.path, f.content]),
		);
		const streamed = await buildTechnicalGraphStreaming(
			files.map((f) => f.path),
			(p) => contentByPath.get(p) ?? null,
		);
		// Equivalent to never having collected bar.ts at all.
		const expected = await buildTechnicalGraph(
			files.filter((f) => f.path !== "src/b/bar.ts"),
		);

		expect(canonical(streamed)).toEqual(canonical(expected));
		expect(streamed.nodes.some((n) => n.key === "src/b/bar.ts")).toBe(
			false,
		);
		expect("src/b/bar.ts" in streamed.manifest).toBe(false);
		// No dangling IMPORTS edge to the dropped file.
		expect(
			streamed.edges.some(
				(e) => e.kind === "IMPORTS" && e.target === "src/b/bar.ts",
			),
		).toBe(false);
	});

	it("skips a path with no detectable language without reading content twice", async () => {
		const reads: string[] = [];
		const contentByPath = new Map<string, string>([
			["src/x.ts", "export const x = 1;"],
			["README.md", "# hi"],
		]);
		const streamed = await buildTechnicalGraphStreaming(
			["README.md", "src/x.ts"],
			(p) => {
				reads.push(p);
				return contentByPath.get(p) ?? null;
			},
		);
		// README.md has no detectable source language → never read, never a node.
		expect(reads).toEqual(["src/x.ts"]);
		expect(
			streamed.nodes.filter((n) => n.kind === "FILE").map((n) => n.key),
		).toEqual(["src/x.ts"]);
	});
});

describe("buildTechnicalGraphStreaming — resume from a parse checkpoint", () => {
	const contentByPath = new Map(files.map((f) => [f.path, f.content]));
	const paths = files.map((f) => f.path);

	it("emits every parsed file's metadata for checkpointing (in batches)", async () => {
		const emitted: FileMeta[] = [];
		const batches: number[] = [];
		await buildTechnicalGraphStreaming(
			paths,
			(p) => contentByPath.get(p) ?? null,
			{
				checkpoint: {
					batchSize: 2,
					onExtracted: async (b) => {
						batches.push(b.length);
						emitted.push(...b);
					},
				},
			},
		);
		// All 5 files emitted, flushed in 2-2-1 batches (final partial flush).
		expect(emitted.map((m) => m.path).sort()).toEqual([...paths].sort());
		expect(batches).toEqual([2, 2, 1]);
	});

	it("reuses seeded files without re-reading them and stays byte-identical to a from-scratch build", async () => {
		const fresh = await buildTechnicalGraphStreaming(
			paths,
			(p) => contentByPath.get(p) ?? null,
		);

		// Capture each file's FileMeta exactly as a prior attempt would checkpoint.
		const captured: FileMeta[] = [];
		await buildTechnicalGraphStreaming(
			paths,
			(p) => contentByPath.get(p) ?? null,
			{
				checkpoint: {
					onExtracted: async (b) => {
						captured.push(...b);
					},
				},
			},
		);

		// Resume with the first 3 files seeded. The reader THROWS for them, proving
		// they are NOT re-read; only the remaining 2 are parsed fresh + re-emitted.
		const seededPaths = new Set(captured.slice(0, 3).map((m) => m.path));
		const seed = new Map(
			captured
				.filter((m) => seededPaths.has(m.path))
				.map((m) => [m.path, m]),
		);
		const reEmitted: FileMeta[] = [];
		const resumed = await buildTechnicalGraphStreaming(
			paths,
			(p) => {
				if (seededPaths.has(p)) {
					throw new Error(`seeded file was re-read: ${p}`);
				}
				return contentByPath.get(p) ?? null;
			},
			{
				checkpoint: {
					seed,
					onExtracted: async (b) => {
						reEmitted.push(...b);
					},
				},
			},
		);

		// Byte-identical graph despite half the files coming from the checkpoint.
		expect(canonical(resumed)).toEqual(canonical(fresh));
		expect(resumed.nodes).toEqual(fresh.nodes);
		expect(resumed.edges).toEqual(fresh.edges);
		// Only the non-seeded files were (re-)parsed and streamed out.
		expect(reEmitted.map((m) => m.path).sort()).toEqual(
			captured
				.filter((m) => !seededPaths.has(m.path))
				.map((m) => m.path)
				.sort(),
		);
	});
});
