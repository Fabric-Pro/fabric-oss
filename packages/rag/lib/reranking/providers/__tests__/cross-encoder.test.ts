import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const transformers = vi.hoisted(() => {
	const env = {
		allowLocalModels: true,
		useBrowserCache: true,
		useFSCache: true,
		cacheDir: "/app/node_modules/@huggingface/transformers/.cache",
	};
	const state = { requiredCacheDir: "" };
	const classifier = vi.fn(async (pairs: string[]) =>
		pairs.map((_, index) => [
			{ label: "LABEL_0", score: index === 0 ? 0.8 : 0.2 },
			{ label: "LABEL_1", score: index === 0 ? 0.2 : 0.8 },
		]),
	);
	const pipeline = vi.fn(async () => {
		if (env.cacheDir !== state.requiredCacheDir) {
			throw new Error(`cache directory is not writable: ${env.cacheDir}`);
		}
		return classifier;
	});

	return { classifier, env, pipeline, state };
});

vi.mock("@huggingface/transformers", () => ({
	env: transformers.env,
	pipeline: transformers.pipeline,
}));

vi.mock("@repo/logs", () => ({
	logger: {
		info: vi.fn(),
		error: vi.fn(),
	},
}));

import {
	CrossEncoderRerankerProvider,
	resetCrossEncoderCache,
} from "../cross-encoder";

beforeEach(() => {
	vi.clearAllMocks();
	resetCrossEncoderCache();
	transformers.env.allowLocalModels = true;
	transformers.env.useBrowserCache = true;
	transformers.env.cacheDir =
		"/app/node_modules/@huggingface/transformers/.cache";
	transformers.state.requiredCacheDir = join(
		tmpdir(),
		"fabric-transformers-cache",
	);
});

describe("CrossEncoderRerankerProvider", () => {
	it("loads the model with its filesystem cache under the OS temp directory", async () => {
		const provider = new CrossEncoderRerankerProvider({
			provider: "cross-encoder",
			model: "example/cross-encoder",
		});
		const first = {
			id: "context-1",
			type: "TEXT",
			content: "first context",
			score: 0.9,
		};
		const second = {
			id: "context-2",
			type: "TEXT",
			content: "second context",
			score: 0.7,
		};

		await expect(
			provider.rerank({
				query: "which context is relevant?",
				documents: [first, second],
				topK: 1,
			}),
		).resolves.toEqual([
			{
				document: second,
				relevanceScore: 0.8,
				originalIndex: 1,
			},
		]);
	});
});
