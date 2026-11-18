import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	heartbeat: vi.fn(),
	extract: vi.fn(),
	findFirst: vi.fn(),
	send: vi.fn(),
}));
vi.mock("@temporalio/activity", () => ({
	heartbeat: mocks.heartbeat,
	Context: {
		current: () => ({ cancellationSignal: new AbortController().signal }),
	},
}));
vi.mock("@aws-sdk/client-s3", () => ({
	S3Client: class {
		send = mocks.send;
	},
	GetObjectCommand: class {},
}));
vi.mock("@repo/database", () => ({
	db: { chatDocument: { findFirst: mocks.findFirst } },
	tenantWhere: () => ({}),
}));
vi.mock("@repo/ai", () => ({
	getSystemEmbeddingRAGProviderConfig: vi.fn().mockResolvedValue({}),
}));
vi.mock("@repo/rag", () => ({
	extractionFactory: { extract: mocks.extract },
	chunkText: () => [],
	generateEmbeddings: vi.fn(),
	storeChunk: vi.fn(),
}));

import { processAndStoreChunks } from "../document-processing";
import { HEARTBEAT_TICK_MS } from "../lib/activity-liveness";

beforeEach(() => {
	vi.useFakeTimers();
	vi.clearAllMocks();
	mocks.findFirst.mockResolvedValue({
		s3Path: "file",
		filename: "file.txt",
		mimeType: "text/plain",
	});
	mocks.send.mockResolvedValue({
		Body: { transformToByteArray: async () => new Uint8Array([1]) },
	});
});
afterEach(() => vi.useRealTimers());

it.each(["success", "failure"])(
	"heartbeats during extraction and stops after %s",
	async (outcome) => {
		let resolve!: (value: unknown) => void;
		let reject!: (reason: Error) => void;
		mocks.extract.mockReturnValue(
			new Promise((res, rej) => {
				resolve = res;
				reject = rej;
			}),
		);
		const run = processAndStoreChunks("doc", "chat", "user", "org");
		const settled = run.then(
			(value) => value,
			(error) => error,
		);
		await vi.advanceTimersByTimeAsync(0);
		expect(mocks.extract).toHaveBeenCalledOnce();
		const before = mocks.heartbeat.mock.calls.length;
		await vi.advanceTimersByTimeAsync(HEARTBEAT_TICK_MS * 2);
		expect(mocks.heartbeat.mock.calls.length - before).toBe(2);
		if (outcome === "success") {
			resolve({
				text: "hello",
				extractorUsed: "test",
				extractionTime: 1,
				cost: 0,
			});
		} else {
			reject(new Error("extraction failed"));
		}
		const result = await settled;
		if (outcome === "success") {
			expect(result).toEqual({
				chunkCount: 0,
				extractorUsed: "test",
				extractionTime: 1,
				cost: 0,
			});
		} else {
			expect(result.message).toContain("extraction failed");
		}
		const count = mocks.heartbeat.mock.calls.length;
		await vi.advanceTimersByTimeAsync(HEARTBEAT_TICK_MS * 2);
		expect(mocks.heartbeat).toHaveBeenCalledTimes(count);
	},
);
