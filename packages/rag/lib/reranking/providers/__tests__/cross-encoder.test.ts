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
	const tokenizer = vi.fn();
	const model = vi.fn();
	const classifier = Object.assign(vi.fn(), { tokenizer, model });
	const pipeline = vi.fn(async () => {
		if (env.cacheDir !== state.requiredCacheDir) {
			throw new Error(`cache directory is not writable: ${env.cacheDir}`);
		}
		return classifier;
	});

	return { classifier, env, model, pipeline, state, tokenizer };
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

const irrelevant = {
	id: "context-1",
	type: "TEXT",
	content: "Bananas are yellow.",
	score: 0.9,
};
const relevant = {
	id: "context-2",
	type: "TEXT",
	content: "Paris is the capital of France.",
	score: 0.7,
};

beforeEach(() => {
	vi.clearAllMocks();
	resetCrossEncoderCache();
	transformers.env.allowLocalModels = true;
	transformers.env.useBrowserCache = true;
	transformers.env.useFSCache = true;
	transformers.env.cacheDir =
		"/app/node_modules/@huggingface/transformers/.cache";
	transformers.state.requiredCacheDir = join(
		tmpdir(),
		"fabric-transformers-cache",
	);

	transformers.tokenizer.mockImplementation(
		(
			queries: string[],
			options: {
				text_pair?: string[];
				padding?: boolean;
				truncation?: boolean;
			},
		) => {
			if (
				queries.some(
					(query) => query !== "What is the capital of France?",
				) ||
				!Array.isArray(options.text_pair) ||
				options.text_pair.length !== queries.length ||
				options.padding !== true ||
				options.truncation !== true
			) {
				throw new Error(
					"query and document must be tokenized as a text pair",
				);
			}

			return { documents: options.text_pair };
		},
	);
	transformers.model.mockImplementation(
		async ({ documents }: { documents: string[] }) => {
			const rows = documents.map((document) => {
				if (document.includes("Paris")) {
					return [8];
				}
				if (document.includes("Marseille")) {
					return [4];
				}
				return [-8];
			});
			return {
				logits: {
					dims: [rows.length, 1],
					tolist: () => rows,
				},
			};
		},
	);
});

describe("CrossEncoderRerankerProvider", () => {
	it("loads the model with its filesystem cache under the OS temp directory", async () => {
		const provider = new CrossEncoderRerankerProvider({
			provider: "cross-encoder",
			model: "example/cross-encoder",
		});

		await expect(
			provider.rerank({
				query: "What is the capital of France?",
				documents: [irrelevant, relevant],
				topK: 1,
			}),
		).resolves.toEqual([
			{
				document: relevant,
				relevanceScore: 0.9996646498695336,
				originalIndex: 1,
			},
		]);
	});

	it("ranks documents from sigmoid scores over true query-document pairs", async () => {
		const provider = new CrossEncoderRerankerProvider({
			provider: "cross-encoder",
		});

		await expect(
			provider.rerank({
				query: "What is the capital of France?",
				documents: [irrelevant, relevant],
				topK: 2,
			}),
		).resolves.toEqual([
			{
				document: relevant,
				relevanceScore: 0.9996646498695336,
				originalIndex: 1,
			},
			{
				document: irrelevant,
				relevanceScore: 0.0003353501304664781,
				originalIndex: 0,
			},
		]);
	});

	it("keeps score-to-document alignment across batches before filtering and truncation", async () => {
		const documents = [
			{
				id: "moderately-relevant",
				type: "TEXT",
				content: "Marseille is in France.",
				score: 0.95,
			},
			...Array.from({ length: 31 }, (_, index) => ({
				id: `irrelevant-${index}`,
				type: "TEXT",
				content: `Unrelated document ${index}`,
				score: 0.9 - index / 100,
			})),
			relevant,
		];
		const provider = new CrossEncoderRerankerProvider({
			provider: "cross-encoder",
		});

		const result = await provider.rerank({
			query: "What is the capital of France?",
			documents,
			topK: 2,
			minRelevanceScore: 0.5,
		});

		expect(result).toEqual([
			{
				document: relevant,
				relevanceScore: 0.9996646498695336,
				originalIndex: 32,
			},
			{
				document: documents[0],
				relevanceScore: 0.9820137900379085,
				originalIndex: 0,
			},
		]);
	});

	it("rejects a model output with more than one logit per document", async () => {
		transformers.model.mockResolvedValue({
			logits: {
				dims: [2, 2],
				tolist: () => [
					[-8, 8],
					[8, -8],
				],
			},
		});
		const provider = new CrossEncoderRerankerProvider({
			provider: "cross-encoder",
		});

		await expect(
			provider.rerank({
				query: "What is the capital of France?",
				documents: [irrelevant, relevant],
			}),
		).rejects.toThrow("one finite logit per query-document pair");
	});

	it("rejects a non-finite model score", async () => {
		transformers.model.mockResolvedValue({
			logits: {
				dims: [2, 1],
				tolist: () => [[Number.NaN], [8]],
			},
		});
		const provider = new CrossEncoderRerankerProvider({
			provider: "cross-encoder",
		});

		await expect(
			provider.rerank({
				query: "What is the capital of France?",
				documents: [irrelevant, relevant],
			}),
		).rejects.toThrow("one finite logit per query-document pair");
	});
});
