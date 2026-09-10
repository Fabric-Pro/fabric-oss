/**
 * Reproducible local comparison for sequence-classification cross encoders.
 *
 * Run one model per process. Example:
 * pnpm --filter @repo/rag exec tsx scripts/reranker-benchmark.ts \
 *   --model=Xenova/ms-marco-MiniLM-L-6-v2 --phase=cold \
 *   --cache-dir=/tmp/reranker-benchmark/minilm \
 *   --output=/tmp/reranker-benchmark/minilm-cold.json
 *
 * The fixture is deliberately small and synthetic. It is a regression-style
 * ranking comparison, not a substitute for production retrieval evaluation.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
	AutoModelForSequenceClassification,
	AutoTokenizer,
	env,
} from "@huggingface/transformers";

const require = createRequire(import.meta.url);
const TRANSFORMERS_PACKAGE_PATH = resolve(
	dirname(require.resolve("@huggingface/transformers")),
	"..",
	"package.json",
);
const MAX_LENGTH = 512;
const CONTENT_CHAR_LIMIT = 1500;
const WARMUP_ROUNDS = 3;
const TIMED_ROUNDS = 24;

interface Candidate {
	id: string;
	grade: number;
	text: string;
}

interface JudgedQuery {
	id: string;
	query: string;
	candidates: Candidate[];
}

interface Fixture {
	fixtureVersion: number;
	description: string;
	queries: JudgedQuery[];
}

interface Options {
	model: string;
	phase: "cold" | "cached";
	cacheDir: string;
	output?: string;
}

function parseOptions(args: string[]): Options {
	const values = new Map(
		args
			.filter((argument) => argument.startsWith("--"))
			.map((argument) => {
				const [key, ...rest] = argument.slice(2).split("=");
				return [key, rest.join("=")];
			}),
	);
	const model = values.get("model");
	const phase = values.get("phase");
	const cacheDir = values.get("cache-dir");
	if (!model || !cacheDir || (phase !== "cold" && phase !== "cached")) {
		throw new Error(
			"Usage: --model=<Hugging Face model> --phase=cold|cached --cache-dir=<directory> [--output=<path>]",
		);
	}
	return { model, phase, cacheDir, output: values.get("output") };
}

async function directoryBytes(path: string): Promise<number> {
	const entries = await readdir(path, {
		withFileTypes: true,
	});
	let total = 0;
	for (const entry of entries) {
		const child = resolve(path, entry.name);
		if (entry.isDirectory()) {
			total += await directoryBytes(child);
		} else if (entry.isFile()) {
			total += (await stat(child)).size;
		}
	}
	return total;
}

async function requireEmptyOrAbsentColdCache(cacheDir: string): Promise<void> {
	try {
		const entries = await readdir(cacheDir);
		if (entries.length > 0) {
			throw new Error(
				`Cold mode requires an absent or empty cache directory; refusing to delete existing contents at ${cacheDir}.`,
			);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return;
		}
		throw error;
	}
}

function percentile(values: number[], p: number): number {
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.ceil(p * sorted.length) - 1;
	return sorted[Math.max(0, index)] ?? 0;
}

function sigmoid(logit: number): number {
	return 1 / (1 + Math.exp(-logit));
}

function ndcgAt5(grades: number[]): number {
	const dcg = grades
		.slice(0, 5)
		.reduce(
			(total, grade, index) =>
				total + (2 ** grade - 1) / Math.log2(index + 2),
			0,
		);
	const ideal = [...grades]
		.sort((a, b) => b - a)
		.slice(0, 5)
		.reduce(
			(total, grade, index) =>
				total + (2 ** grade - 1) / Math.log2(index + 2),
			0,
		);
	return ideal === 0 ? 0 : dcg / ideal;
}

function reciprocalRankAt5(grades: number[]): number {
	const firstRelevant = grades.slice(0, 5).findIndex((grade) => grade > 0);
	return firstRelevant === -1 ? 0 : 1 / (firstRelevant + 1);
}

function peakMemoryBytes(): number {
	const maxRssBytes = process.resourceUsage().maxRSS * 1024;
	return Math.max(process.memoryUsage().rss, maxRssBytes);
}

function rotatedCandidates(
	query: JudgedQuery,
	queryIndex: number,
): Candidate[] {
	const offset = queryIndex % query.candidates.length;
	const rotated: Candidate[] = [];
	for (let index = 0; index < query.candidates.length; index += 1) {
		const candidate =
			query.candidates[(index + offset) % query.candidates.length];
		if (!candidate) {
			throw new Error(
				`Missing candidate for benchmark query ${query.id}.`,
			);
		}
		rotated.push(candidate);
	}
	return rotated;
}

async function main() {
	const options = parseOptions(process.argv.slice(2));
	const scriptDirectory = dirname(fileURLToPath(import.meta.url));
	const fixture = JSON.parse(
		await readFile(
			resolve(scriptDirectory, "reranker-benchmark-fixture.json"),
			"utf8",
		),
	) as Fixture;
	if (fixture.queries.length === 0) {
		throw new Error(
			"The benchmark fixture must contain at least one judged query.",
		);
	}
	const transformersVersion = (
		JSON.parse(await readFile(TRANSFORMERS_PACKAGE_PATH, "utf8")) as {
			version: string;
		}
	).version;
	if (options.phase === "cold") {
		await requireEmptyOrAbsentColdCache(options.cacheDir);
	}

	// Use exactly the sequence-classification path used by the proposed adapter:
	// paired tokenization, fp32 logits, and a scalar sigmoid. The generic
	// text-classification pipeline is intentionally not used because it ignores
	// text_pair and normalizes scalar logits as if they were label probabilities.
	env.cacheDir = options.cacheDir;
	// Transformers.js treats its filesystem cache as a local model source.
	env.allowLocalModels = options.phase === "cached";
	env.useBrowserCache = false;

	const loadStartedAt = performance.now();
	const tokenizer = await AutoTokenizer.from_pretrained(options.model, {
		local_files_only: options.phase === "cached",
	});
	const model = await AutoModelForSequenceClassification.from_pretrained(
		options.model,
		{
			dtype: "fp32",
			local_files_only: options.phase === "cached",
		},
	);
	const loadMs = performance.now() - loadStartedAt;
	let peakBytes = peakMemoryBytes();

	const scorePairs = async (query: string, passages: string[]) => {
		const truncatedPassages = passages.map((passage) =>
			passage.slice(0, CONTENT_CHAR_LIMIT),
		);
		const inputs = await tokenizer(
			truncatedPassages.map(() => query),
			{
				text_pair: truncatedPassages,
				truncation: true,
				padding: true,
				max_length: MAX_LENGTH,
			},
		);
		const output = await model(inputs);
		const logits = Array.from((output.logits.data as Float32Array) ?? []);
		if (
			logits.length !== passages.length ||
			logits.some((logit) => !Number.isFinite(logit))
		) {
			throw new Error(
				`Expected one finite scalar logit per pair; received ${logits.length} logits for ${passages.length} pairs.`,
			);
		}
		peakBytes = Math.max(peakBytes, peakMemoryBytes());
		return logits;
	};

	for (let round = 0; round < WARMUP_ROUNDS; round += 1) {
		const benchmarkQuery = fixture.queries[round % fixture.queries.length];
		if (!benchmarkQuery) {
			throw new Error("The benchmark fixture query is missing.");
		}
		await scorePairs(
			benchmarkQuery.query,
			benchmarkQuery.candidates.map((candidate) => candidate.text),
		);
	}

	const samplesMs: number[] = [];
	for (let round = 0; round < TIMED_ROUNDS; round += 1) {
		const benchmarkQuery = fixture.queries[round % fixture.queries.length];
		if (!benchmarkQuery) {
			throw new Error("The benchmark fixture query is missing.");
		}
		const startedAt = performance.now();
		await scorePairs(
			benchmarkQuery.query,
			benchmarkQuery.candidates.map((candidate) => candidate.text),
		);
		samplesMs.push(performance.now() - startedAt);
	}

	const perQuery = await Promise.all(
		fixture.queries.map(async (judgedQuery, queryIndex) => {
			const candidates = rotatedCandidates(judgedQuery, queryIndex);
			const logits = await scorePairs(
				judgedQuery.query,
				candidates.map((candidate) => candidate.text),
			);
			const ranking = candidates
				.map((candidate, index) => {
					const logit = logits[index];
					if (logit === undefined) {
						throw new Error(
							`Missing logit for ${judgedQuery.id}/${candidate.id}.`,
						);
					}
					return {
						id: candidate.id,
						grade: candidate.grade,
						logit,
						score: sigmoid(logit),
					};
				})
				.sort((left, right) => right.logit - left.logit);
			const grades = ranking.map((item) => item.grade);
			return {
				id: judgedQuery.id,
				ndcgAt5: ndcgAt5(grades),
				mrrAt5: reciprocalRankAt5(grades),
				ranking,
			};
		}),
	);

	const referenceQuery = "What is the capital of France?";
	const referencePassages = [
		"Paris is the capital and most populous city of France.",
		"A banana is an edible fruit produced by several kinds of large herbaceous flowering plants.",
	];
	const referenceLogits = await scorePairs(referenceQuery, referencePassages);
	const cacheBytes = await directoryBytes(options.cacheDir);
	const result = {
		benchmark: "sequence-classification-reranker",
		fixture: {
			version: fixture.fixtureVersion,
			description: fixture.description,
			queries: fixture.queries.length,
			candidatesPerQuery: fixture.queries.map(
				(query) => query.candidates.length,
			),
		},
		model: options.model,
		transformersVersion,
		phase: options.phase,
		runtime: {
			node: process.version,
			platform: process.platform,
			arch: process.arch,
			dtype: "fp32",
			maxLength: MAX_LENGTH,
			contentCharLimit: CONTENT_CHAR_LIMIT,
		},
		load: {
			measurement:
				"Sequential AutoTokenizer.from_pretrained then AutoModelForSequenceClassification.from_pretrained; excludes static module import and fixture setup.",
			ms: loadMs,
			cacheArtifactBytes: cacheBytes,
			cacheArtifactMiB: cacheBytes / 1024 / 1024,
		},
		warmCpuLatencyMs: {
			unit: "one query reranked against four passages as one batch",
			warmupRounds: WARMUP_ROUNDS,
			timedRounds: TIMED_ROUNDS,
			p50: percentile(samplesMs, 0.5),
			p95: percentile(samplesMs, 0.95),
			samples: samplesMs,
		},
		peakMemoryBytes: peakBytes,
		peakMemoryMiB: peakBytes / 1024 / 1024,
		peakMemoryMeasurement:
			"Process RSS high-water mark across the complete run, including the 12 concurrently launched quality-evaluation queries; it is not a steady-state per-request RSS.",
		metrics: {
			ndcgAt5:
				perQuery.reduce((total, item) => total + item.ndcgAt5, 0) /
				perQuery.length,
			mrrAt5:
				perQuery.reduce((total, item) => total + item.mrrAt5, 0) /
				perQuery.length,
			relevanceThresholdForMrr: "grade > 0",
			perQuery,
		},
		referencePairs: referencePassages.map((passage, index) => {
			const logit = referenceLogits[index];
			if (logit === undefined) {
				throw new Error(
					`Missing reference logit for passage ${index}.`,
				);
			}
			return {
				query: referenceQuery,
				passage,
				logit,
				sigmoidScore: sigmoid(logit),
			};
		}),
	};
	const json = `${JSON.stringify(result, null, 2)}\n`;
	if (options.output) {
		const { mkdir, writeFile } = await import("node:fs/promises");
		await mkdir(dirname(options.output), { recursive: true });
		await writeFile(options.output, json);
	}
	process.stdout.write(json);
}

main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
