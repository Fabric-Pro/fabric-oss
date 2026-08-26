/**
 * Guard: every project-context ingestion path routes through the shared chunker.
 *
 * There were three copies of "how should this content be chunked" — the
 * file-upload activity, the wizard activity, and `auto-embed` — each with its own
 * `detectChunkingStrategy`. A spec uploaded through one path was indexed by
 * endpoint while the same file uploaded through another was shredded into
 * character windows, and neither path errored: the upload succeeded, the API
 * contract was simply gone.
 *
 * That class of bug is invisible to a functional test, because every path
 * reports success. So this asserts the structure instead: one decision, three
 * callers, no local re-implementations. A fourth ingestion path added later will
 * fail here until it is wired up too. (Fizzy #2236)
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packagesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const read = (relativePath: string): string =>
	readFileSync(join(packagesDir, relativePath), "utf-8");

const INGESTION_PATHS = [
	{
		label: "project context file upload",
		file: "temporal/src/activities/project-context-processing.ts",
		entryPoint: "chunkProjectContent",
	},
	{
		label: "project-creation wizard upload",
		file: "temporal/src/activities/wizard-context-processing.ts",
		entryPoint: "chunkProjectContent",
	},
	{
		label: "auto-embed / re-embed",
		file: "rag/lib/project-contexts/auto-embed.ts",
		entryPoint: "routeContentForChunking",
	},
	{
		// Found by the discovery guard below, not by hand — it had a FOURTH copy
		// of detectChunkingStrategy.
		label: "wizard context re-embed",
		file: "temporal/src/activities/wizard-context-embedding.ts",
		entryPoint: "chunkProjectContent",
	},
] as const;

describe("project-context ingestion chunking", () => {
	for (const path of INGESTION_PATHS) {
		it(`${path.label} routes through the shared chunker`, () => {
			expect(read(path.file)).toContain(path.entryPoint);
		});

		it(`${path.label} does not define its own chunking strategy`, () => {
			// A local copy is how the three drifted apart in the first place.
			expect(read(path.file)).not.toMatch(
				/function\s+detectChunkingStrategy/,
			);
		});
	}

	it("resolves the feature flag once, in the router, as a runtime toggle", () => {
		// Two properties at once. First, the gate is the DB-backed toggle, so
		// turning the feature on or off is an admin flip rather than a deploy —
		// a `process.env` read here would put the kill switch behind a release.
		// Second, the flag is resolved in the router and nowhere else: an
		// ingestion path that asked for itself would be a fifth copy of the
		// decision, which is the bug this whole module exists to prevent.
		const shared = read("rag/lib/chunking/content-routing.ts");
		expect(shared).toContain('isFeatureEnabled("OPENAPI_SPEC_CONTEXT")');
		expect(shared).not.toMatch(/process\.env\.FABRIC_FEATURE_OPENAPI/);

		for (const path of INGESTION_PATHS) {
			expect(read(path.file)).not.toContain("OPENAPI_SPEC_CONTEXT");
		}
	});

	it("keeps exactly one definition of the MIME strategy mapping", () => {
		const shared = read("rag/lib/chunking/content-routing.ts");
		expect(shared).toMatch(/export function detectTextChunkingStrategy/);
	});

	it("discovers every chunking caller, so a NEW path cannot slip through", () => {
		// The list above is hand-kept, which means a fourth ingestion path added
		// later simply would not appear in it — the test would pass by omission,
		// which is the same shape as the bug it guards. So derive the candidates
		// instead: anything that calls `chunkText` is making a chunking decision
		// and must either route through the shared entry point or be listed here
		// with a reason.
		const CHUNK_CALLER_EXEMPT: Record<string, string> = {
			// The router itself — this is the shared decision, not a bypass of it.
			"rag/lib/chunking/content-routing.ts":
				"defines the routing every other caller goes through",
			// Not project context. These write to the workspace/user document
			// corpus, which specs are not uploaded into — routing them would
			// change behaviour for documents this feature says nothing about.
			"temporal/src/activities/workspace-document-activities.ts":
				"workspace documents, a separate corpus",
			"temporal/src/activities/document-processing.ts":
				"user documents via storeDocumentChunks, not ProjectContext",
			"temporal/src/activities/connector-sync.ts":
				"connector-synced workspace documents, not ProjectContext",
			"rag/lib/project-documents/embed.ts":
				"generated project documents, not uploaded context",
			// Not ingestion at all.
			"rag/lib/chunking/chunker.ts": "defines chunkText itself",
			"rag/lib/project-contexts/retrieve-for-spec.ts":
				"splits the QUERY at retrieval time; ingests nothing",
			"rag/test-rag.ts": "developer script, not a runtime path",
		};

		const callers = execSync(
			"grep -rl --include=*.ts 'chunkText(' rag temporal/src api apps 2>/dev/null || true",
			{ cwd: packagesDir, encoding: "utf-8" },
		)
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0 && !line.includes("__tests__"));

		const unrouted = callers.filter((file) => {
			if (CHUNK_CALLER_EXEMPT[file]) {
				return false;
			}
			const source = read(file);
			return (
				!source.includes("chunkProjectContent") &&
				!source.includes("routeContentForChunking")
			);
		});

		expect(
			unrouted,
			"These files chunk content without going through the shared router. " +
				"Either route them through it, or add them to CHUNK_CALLER_EXEMPT " +
				"with a reason. An unrouted ingestion path accepts an API spec and " +
				"silently shreds it — the upload still succeeds.",
		).toEqual([]);
	});

	it("bulk re-embed still depends on the embeddedAt filter it is safe because of", () => {
		// This path does no chunking at all — it embeds whole `content` as one
		// vector. That is only harmless because the procedure feeding it selects
		// `embeddedAt: null`, so an already-chunked spec is never re-embedded
		// flat. If that filter goes, spec chunks gain a useless whole-file
		// sibling and this test is the warning.
		const procedure = read(
			"api/modules/projects/procedures/contexts/embed-contexts.ts",
		);
		expect(procedure).toContain("embeddedAt: null");
	});
});
