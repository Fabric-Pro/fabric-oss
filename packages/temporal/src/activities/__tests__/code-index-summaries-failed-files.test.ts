/**
 * How many files a summaries batch left without a summary.
 *
 * The workflow reports this count on the Job Hub card, so it has to count
 * files, not error strings: an unreadable file is one error for one file, but a
 * failed embed call is one error for every file in the batch.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/job-progress", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		jobStep: vi.fn(),
		jobIncrement: vi.fn(),
		jobHeartbeat: vi.fn(),
	};
});

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@temporalio/activity", () => ({
	Context: { current: () => ({ heartbeat: vi.fn() }) },
	heartbeat: vi.fn(),
}));

const rag = vi.hoisted(() => ({
	generateEmbeddings: vi.fn(),
	upsert: vi.fn(),
}));

vi.mock("@repo/rag/lib/embedding", () => ({
	generateEmbeddings: rag.generateEmbeddings,
}));
vi.mock("@repo/rag/lib/embedding/sparse", () => ({
	generateSparseVector: vi.fn(() => ({ indices: [], values: [] })),
}));
vi.mock("@repo/rag/lib/collection-manager", () => ({
	getCollectionLayout: vi.fn(async () => ({})),
	getCollectionName: vi.fn(() => "project-contexts"),
}));
vi.mock("@repo/rag/lib/project-contexts/client", () => ({
	qdrantClient: { upsert: rag.upsert },
}));
vi.mock("@repo/rag/lib/utils", () => ({
	generatePointId: vi.fn((id: string) => id),
}));

import { generateFileSummariesActivity } from "../code-indexing";

let dir: string;

function file(name: string, content?: string) {
	const absolutePath = path.join(dir, name);
	if (content !== undefined) {
		fs.writeFileSync(absolutePath, content);
	}
	return { relativePath: name, absolutePath, language: "typescript" };
}

const INPUT = {
	projectId: "proj-1",
	repositoryIntegrationId: "repo-1",
	userId: "user-1",
	organizationId: "org-1",
	repoName: "example-org/example-repo",
};

beforeEach(() => {
	vi.clearAllMocks();
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "code-index-summaries-"));
	rag.generateEmbeddings.mockImplementation(async (texts: string[]) => ({
		embeddings: texts.map(() => [0.1, 0.2]),
	}));
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("generateFileSummariesActivity — failedFiles", () => {
	it("is zero when every file is summarized", async () => {
		const result = await generateFileSummariesActivity({
			...INPUT,
			files: [
				file("a.ts", "export const a = 1;"),
				file("b.ts", "let b;"),
			],
		});

		expect(result).toMatchObject({ summariesCreated: 2, failedFiles: 0 });
	});

	it("counts each unreadable file once", async () => {
		const result = await generateFileSummariesActivity({
			...INPUT,
			files: [file("a.ts", "export const a = 1;"), file("missing.ts")],
		});

		expect(result).toMatchObject({ summariesCreated: 1, failedFiles: 1 });
		expect(result.errors).toHaveLength(1);
	});

	it("counts every file a failed embed call left behind, not one error", async () => {
		rag.generateEmbeddings.mockRejectedValue(new Error("rate limited"));

		const result = await generateFileSummariesActivity({
			...INPUT,
			files: [
				file("a.ts", "export const a = 1;"),
				file("b.ts", "let b;"),
				file("c.ts", "let c;"),
				file("missing.ts"),
			],
		});

		expect(result.errors).toHaveLength(2);
		expect(result).toMatchObject({ summariesCreated: 0, failedFiles: 4 });
	});

	it("does not count an empty file, which has nothing to summarize", async () => {
		const result = await generateFileSummariesActivity({
			...INPUT,
			files: [
				file("a.ts", "export const a = 1;"),
				file("empty.ts", "  "),
			],
		});

		expect(result).toMatchObject({ summariesCreated: 1, failedFiles: 0 });
	});
});
