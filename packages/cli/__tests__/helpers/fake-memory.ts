/**
 * An in-memory Living Memory server for the mirror's tests: the folders, the
 * files the sync holds under them, and the writes submitted. It answers with
 * the shapes the SDK's `memory` resource returns, and lets a test script how a
 * write ends.
 */
import { createHash } from "node:crypto";
import {
	FabricError,
	FabricNotFoundError,
	type MemoryWriteOutcome,
	type MemoryWriteReceipt,
	type MemoryWriteTarget,
	type SubmitMemoryWriteInput,
} from "@fabricorg/sdk";
import { vi } from "vitest";
import { gitBlobOid } from "../../src/lib/git-blob.js";

const encode = (text: string) => new TextEncoder().encode(text);

export const sha256 = (text: string) =>
	createHash("sha256").update(text, "utf8").digest("hex");

export class FakeMemoryServer {
	targets: MemoryWriteTarget[] = [
		{ id: "t1", folder: "docs/ai", mode: "PULL_REQUEST", version: 1 },
	];
	/** The files the sync holds, by repository path. */
	files = new Map<string, string>();
	pageSize = 500;
	submitted: SubmitMemoryWriteInput[] = [];
	receipts = new Map<string, MemoryWriteReceipt | "missing">();
	uploads: Array<{ url: string; stagedKey: string; bytes: number }> = [];
	refuse:
		| ((
				input: SubmitMemoryWriteInput,
		  ) => Array<{ path?: string; code: string }> | null)
		| null = null;
	busy = false;
	/** Files whose listed hash is wrong, to test that a mismatch is refused. */
	corrupt = new Set<string>();

	readonly calls = {
		getTargets: 0,
		listFiles: 0,
		getFile: 0,
		getWrite: 0,
		submit: 0,
	};

	set(path: string, text: string): void {
		this.files.set(path, text);
	}

	blobOf(path: string): string {
		return gitBlobOid(encode(this.files.get(path) ?? ""));
	}

	/** How a submitted write ends, once the test decides. */
	settle(writeId: string, outcome: MemoryWriteOutcome | null): void {
		const submitted = this.submitted[Number(writeId.slice(1)) - 1];
		this.receipts.set(writeId, {
			writeId,
			status: outcome === null ? "PENDING" : outcome.status,
			digest: "d".repeat(64),
			targetId: submitted?.targetId ?? "t1",
			folder: this.targets[0]?.folder ?? "docs/ai",
			mode: "PULL_REQUEST",
			ref: "main",
			via: "CLI",
			entries: (submitted?.entries ?? []).map((entry) => ({
				path: entry.path,
				op: entry.op,
			})),
			outcome,
			createdAt: new Date(0).toISOString(),
			settledAt: outcome === null ? null : new Date(0).toISOString(),
		});
	}

	readonly memory = {
		getTargets: vi.fn(async () => {
			this.calls.getTargets++;
			return {
				sync: {
					ref: "main",
					lastAppliedCommitSha: "c".repeat(40),
					ingesting: true,
					repository: {
						provider: "GITHUB",
						owner: "example-org",
						name: "docs",
					},
				},
				targets: this.targets,
			};
		}),
		listFiles: vi.fn(
			async (
				_project: string,
				options: { targetId: string; after?: string; limit?: number },
			) => {
				this.calls.listFiles++;
				const target = this.targets.find(
					(t) => t.id === options.targetId,
				);
				if (target === undefined) {
					throw new FabricError("not found", 404, "NOT_FOUND");
				}
				const all = [...this.files.keys()]
					.filter((path) => path.startsWith(`${target.folder}/`))
					.sort()
					.filter(
						(path) =>
							options.after === undefined || path > options.after,
					);
				const limit = Math.min(
					options.limit ?? this.pageSize,
					this.pageSize,
				);
				const page = all.slice(0, limit);
				return {
					targetId: target.id,
					folder: target.folder,
					ref: "main",
					lastAppliedCommitSha: "c".repeat(40),
					files: page.map((path) => ({
						path,
						blobOid: this.blobOf(path),
						contentHash: sha256(this.files.get(path) as string),
						bytes: encode(this.files.get(path) as string).length,
					})),
					nextCursor:
						all.length > limit ? (page.at(-1) ?? null) : null,
				};
			},
		),
		getFile: vi.fn(
			async (
				_project: string,
				options: { targetId: string; path: string },
			) => {
				this.calls.getFile++;
				const content = this.files.get(options.path);
				if (content === undefined) {
					throw new FabricError("not found", 404, "NOT_FOUND");
				}
				return {
					targetId: options.targetId,
					ref: "main",
					lastAppliedCommitSha: "c".repeat(40),
					path: options.path,
					blobOid: this.blobOf(options.path),
					contentHash: this.corrupt.has(options.path)
						? "0".repeat(64)
						: sha256(content),
					bytes: encode(content).length,
					content,
				};
			},
		),
		createUploadUrls: vi.fn(
			async (_project: string, files: Array<{ bytes: number }>) => {
				const uploads = files.map((file, index) => ({
					stagedKey: `memory-writes/p/${this.uploads.length + index}`,
					url: `https://storage.example.com/put/${this.uploads.length + index}`,
					contentType: "text/plain",
					bytes: file.bytes,
				}));
				this.uploads.push(...uploads);
				return { expiresInSeconds: 600, uploads };
			},
		),
		submitWrite: vi.fn(
			async (_project: string, input: SubmitMemoryWriteInput) => {
				this.calls.submit++;
				if (this.busy) {
					throw new FabricError(
						"busy",
						429,
						"TOO_MANY_PENDING_WRITES",
						{ limit: 5 },
					);
				}
				const problems = this.refuse?.(input) ?? null;
				if (problems !== null) {
					throw new FabricError(
						"refused",
						400,
						"MEMORY_WRITE_REFUSED",
						{ problems },
					);
				}
				this.submitted.push(input);
				const writeId = `w${this.submitted.length}`;
				this.settle(writeId, null);
				return {
					writeId,
					status: "PENDING" as const,
					digest: "d".repeat(64),
					deduplicated: false,
				};
			},
		),
		getWrite: vi.fn(async (_project: string, writeId: string) => {
			this.calls.getWrite++;
			const receipt = this.receipts.get(writeId);
			if (receipt === undefined || receipt === "missing") {
				throw new FabricNotFoundError("Write");
			}
			return receipt;
		}),
	};

	/** Apply a committed write to the sync's files, as an ingested commit would. */
	ingest(input: SubmitMemoryWriteInput): void {
		for (const entry of input.entries) {
			if (entry.op === "DELETE") {
				this.files.delete(entry.path);
			} else if (entry.content !== undefined) {
				this.files.set(entry.path, entry.content);
			}
		}
	}
}
