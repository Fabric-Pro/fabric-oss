/**
 * The Parlume notes evaluation: the synthetic meetings through Parlume's own
 * notes and suggestion passes on each model, scored, with what the run used.
 *
 * Nothing reaches a model without `--confirm-spend`. Without it the runner
 * prints what a run would send and an estimate of its tokens and cost. The
 * scores and the rules behind them are in docs/features/parlume-meetings.md.
 */
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { PARLUME_NOTES_FALLBACK_BODY } from "@repo/utils/parlume-notes-prompt";
import { PARLUME_SUGGESTION_FALLBACK_BODY } from "@repo/utils/parlume-suggestion-prompt";
import {
	catalogPrice,
	costUsd,
	EVAL_CHARS_PER_TOKEN,
	estimateFixture,
	type FixtureEstimate,
	type ModelPrice,
} from "./estimate";
import {
	type EvalModel,
	type EvalPrompts,
	evaluateFixture,
	type FixtureResult,
	type TokenUsage,
} from "./evaluate";
import {
	DEFAULT_FIXTURES_DIR,
	loadEvalFixtures,
	type ParlumeEvalFixture,
} from "./fixture";
import { addRatios, type Ratio, rate } from "./scores";

const USAGE = `Usage: tsx packages/api/scripts/parlume-eval.ts --models <id,id> [--fixtures <dir or file,...>] [--notes-prompt <file>] [--suggestion-prompt <file>]
  Dry run (default): prints the passes, a token estimate and a cost estimate. Sends nothing.
  To run it: add --confirm-spend --user-id <id> [--organization-id <id>] [--project-id <id>] [--provider <AIProvider>] --out <report.json>.
  --provider (e.g. ANTHROPIC_DIRECT) runs every model on the account's own config for that provider instead of its default one.
  A run is billed to that account's AI provider; get the spend approved first.`;

const PRICE_SOURCE = "packages/database/prisma/ai-model-catalog.ts";

/** The AI job a run's calls are recorded under: the job being evaluated. */
type EvalJob = "parlume-meeting-notes" | "parlume-live-turn";

/** The account whose AI provider serves, and pays for, a run. */
type EvalAccount = {
	userId: string;
	organizationId: string | null;
	projectId: string | null;
	/** The account's provider to run on; null for its default one. */
	provider: string | null;
	/** Groups the run's usage rows, as a meeting's session id does. */
	runId: string;
};

export type EvalDeps = {
	/** Called only for a run the caller confirmed with `--confirm-spend`. */
	resolveModel: (
		modelId: string,
		job: EvalJob,
		account: EvalAccount,
	) => Promise<EvalModel>;
	writeFile: (path: string, content: string) => Promise<void>;
	log: (line: string) => void;
};

type EvalArgs = {
	models: string[];
	fixtures: string[];
	out: string | null;
	confirmSpend: boolean;
	userId: string | null;
	organizationId: string | null;
	projectId: string | null;
	provider: string | null;
	notesPrompt: string | null;
	suggestionPrompt: string | null;
};

function list(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
}

function parseEvalArgs(argv: string[]): EvalArgs {
	const { values } = parseArgs({
		args: argv,
		options: {
			models: { type: "string" },
			fixtures: { type: "string" },
			out: { type: "string" },
			"confirm-spend": { type: "boolean", default: false },
			"user-id": { type: "string" },
			"organization-id": { type: "string" },
			"project-id": { type: "string" },
			provider: { type: "string" },
			"notes-prompt": { type: "string" },
			"suggestion-prompt": { type: "string" },
		},
		strict: true,
		allowPositionals: false,
	});
	const models = list(values.models);
	if (models.length === 0) {
		throw new Error(`--models is required.\n${USAGE}`);
	}
	return {
		models,
		fixtures: list(values.fixtures),
		out: values.out ?? null,
		confirmSpend: values["confirm-spend"] === true,
		userId: values["user-id"] ?? null,
		organizationId: values["organization-id"] ?? null,
		projectId: values["project-id"] ?? null,
		provider: values.provider ?? null,
		notesPrompt: values["notes-prompt"] ?? null,
		suggestionPrompt: values["suggestion-prompt"] ?? null,
	};
}

async function readPrompts(args: EvalArgs): Promise<EvalPrompts> {
	return {
		notes: args.notesPrompt
			? (await readFile(args.notesPrompt, "utf8")).trim()
			: PARLUME_NOTES_FALLBACK_BODY,
		suggestion: args.suggestionPrompt
			? (await readFile(args.suggestionPrompt, "utf8")).trim()
			: PARLUME_SUGGESTION_FALLBACK_BODY,
	};
}

function usd(value: number): string {
	return `$${value.toFixed(4)}`;
}

function share(ratio: Ratio): string {
	const value = rate(ratio);
	return value === null
		? "n/a (0)"
		: `${Math.round(value * 100)}% (${ratio.hits}/${ratio.total})`;
}

function count(value: number): string {
	return value.toLocaleString("en-US");
}

type DryRun = {
	mode: "dry-run";
	estimates: FixtureEstimate[];
	/** Estimated cost per model; null when the catalog has no price. */
	costs: Record<string, number | null>;
};

function dryRun(
	args: EvalArgs,
	estimates: FixtureEstimate[],
	deps: EvalDeps,
): DryRun {
	const prices = new Map<string, ModelPrice | null>(
		args.models.map((model) => [
			model,
			catalogPrice(model, args.provider ?? undefined),
		]),
	);
	const costOf = (model: string, usage: TokenUsage) => {
		const price = prices.get(model);
		return price ? costUsd(price, usage) : null;
	};
	const total: TokenUsage = {
		inputTokens: estimates.reduce((sum, row) => sum + row.inputTokens, 0),
		outputTokens: estimates.reduce((sum, row) => sum + row.outputTokens, 0),
	};
	const costCell = (cost: number | null) =>
		cost === null ? "no price" : usd(cost);
	const lines = [
		"Parlume notes evaluation: DRY RUN. Nothing was sent to a model.",
		"",
		`Fixtures: ${estimates.length}. Models: ${args.models.join(", ")}.`,
		`Input tokens: characters of each pass's instructions and prompt / ${EVAL_CHARS_PER_TOKEN}. Output tokens: each pass's output cap, an upper bound. Every model gets the same prompts.`,
		`Prices: the AI model catalog's list price per 1M tokens (${PRICE_SOURCE}); cache discounts are not applied.`,
		"",
		`| Fixture | Notes passes | Suggestion passes | Input tokens | Output tokens | ${args.models.map((model) => `${model} (USD)`).join(" | ")} |`,
		`| --- | --- | --- | --- | --- | ${args.models.map(() => "---").join(" | ")} |`,
		...estimates.map(
			(row) =>
				`| ${row.fixture} | ${row.notesPasses} | ${row.suggestionPasses} | ${count(row.inputTokens)} | ${count(row.outputTokens)} | ${args.models.map((model) => costCell(costOf(model, row))).join(" | ")} |`,
		),
		`| Total | ${estimates.reduce((sum, row) => sum + row.notesPasses, 0)} | ${estimates.reduce((sum, row) => sum + row.suggestionPasses, 0)} | ${count(total.inputTokens)} | ${count(total.outputTokens)} | ${args.models.map((model) => costCell(costOf(model, total))).join(" | ")} |`,
		"",
		...args.models.map((model) => {
			const price = prices.get(model);
			return price
				? `${model}: $${price.inputPer1M} in / $${price.outputPer1M} out per 1M tokens.`
				: `${model}: the catalog has no price for this model; the estimate is tokens only.`;
		}),
		"",
		USAGE,
	];
	for (const line of lines) {
		deps.log(line);
	}
	return {
		mode: "dry-run",
		estimates,
		costs: Object.fromEntries(
			args.models.map((model) => [model, costOf(model, total)]),
		),
	};
}

type FixtureRun = FixtureResult & { usage: TokenUsage };

type ModelReport = {
	model: string;
	provider: string;
	scores: {
		anchorValidity: number | null;
		ownerAccuracy: number | null;
		inventedDecisions: number;
		inventedDecisionRate: number | null;
		suggestionPrecision: number | null;
	};
	totals: {
		anchors: Ratio;
		owners: Ratio;
		decisions: Ratio;
		suggestions: Ratio;
	};
	usage: TokenUsage;
	/** Null when the catalog has no price for the model. */
	costUsd: number | null;
	failed: Array<{ fixture: string; error: string; usage: TokenUsage }>;
	fixtures: FixtureRun[];
};

type EvalReport = {
	generatedAt: string;
	runId: string;
	fixtures: string[];
	prompts: { notes: string; suggestion: string };
	priceSource: string;
	models: ModelReport[];
};

type EvalRun = { mode: "run"; report: EvalReport; markdown: string };

function summarize(
	model: EvalModel,
	runs: FixtureRun[],
	failed: ModelReport["failed"],
): ModelReport {
	const empty: Ratio = { hits: 0, total: 0 };
	const anchors = runs.reduce(
		(sum, run) => addRatios(sum, run.anchors),
		empty,
	);
	const owners = runs.reduce(
		(sum, run) => addRatios(sum, run.actions.accuracy),
		empty,
	);
	const decisions = runs.reduce(
		(sum, run) =>
			addRatios(sum, {
				hits: run.decisions.invented.length,
				total: run.decisions.produced,
			}),
		empty,
	);
	const suggestions = runs.reduce(
		(sum, run) => addRatios(sum, run.suggestions.precision),
		empty,
	);
	const usage = [...runs, ...failed].reduce(
		(sum, run) => ({
			inputTokens: sum.inputTokens + run.usage.inputTokens,
			outputTokens: sum.outputTokens + run.usage.outputTokens,
		}),
		{ inputTokens: 0, outputTokens: 0 },
	);
	const price = catalogPrice(model.canonicalName, model.provider);
	return {
		model: model.canonicalName,
		provider: model.provider,
		scores: {
			anchorValidity: rate(anchors),
			ownerAccuracy: rate(owners),
			inventedDecisions: decisions.hits,
			inventedDecisionRate: rate(decisions),
			suggestionPrecision: rate(suggestions),
		},
		totals: { anchors, owners, decisions, suggestions },
		usage,
		costUsd: price ? costUsd(price, usage) : null,
		failed,
		fixtures: runs,
	};
}

function markdownReport(report: EvalReport): string {
	return [
		"# Parlume notes evaluation",
		"",
		`${report.fixtures.length} synthetic meetings, run ${report.generatedAt}. Notes prompt: ${report.prompts.notes}. Suggestion prompt: ${report.prompts.suggestion}. Prices: ${report.priceSource}.`,
		"",
		"| Model | Provider | Anchor validity | Owner and due accuracy | Invented decisions | Suggestion precision | Input tokens | Output tokens | Cost (USD) | Failed fixtures |",
		"| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
		...report.models.map(
			(model) =>
				`| ${model.model} | ${model.provider} | ${share(model.totals.anchors)} | ${share(model.totals.owners)} | ${model.totals.decisions.hits} of ${model.totals.decisions.total} | ${share(model.totals.suggestions)} | ${count(model.usage.inputTokens)} | ${count(model.usage.outputTokens)} | ${model.costUsd === null ? "no price" : usd(model.costUsd)} | ${model.failed.length === 0 ? "none" : model.failed.map((failure) => failure.fixture).join(", ")} |`,
		),
		"",
	].join("\n");
}

function markdownPath(out: string): string {
	return `${out.replace(/\.json$/i, "")}.md`;
}

async function run(
	args: EvalArgs,
	prompts: EvalPrompts,
	fixtures: ParlumeEvalFixture[],
	deps: EvalDeps,
): Promise<EvalRun> {
	const { out, userId } = args;
	if (!out || !userId) {
		throw new Error(
			`--confirm-spend needs --out <report.json> and --user-id <id>: whose AI provider pays, and where the report goes.\n${USAGE}`,
		);
	}
	const generatedAt = new Date().toISOString();
	const account: EvalAccount = {
		userId,
		organizationId: args.organizationId,
		projectId: args.projectId,
		provider: args.provider,
		runId: `parlume-eval:${generatedAt}`,
	};
	// Every model is resolved before any is called: a model the account's
	// provider does not serve would otherwise be scored under another's name,
	// or on a provider the run did not ask for.
	const resolved: Array<{ notes: EvalModel; suggestions: EvalModel }> = [];
	for (const modelId of args.models) {
		const notes = await deps.resolveModel(
			modelId,
			"parlume-meeting-notes",
			account,
		);
		const suggestions = await deps.resolveModel(
			modelId,
			"parlume-live-turn",
			account,
		);
		for (const model of [notes, suggestions]) {
			if (
				model.canonicalName !== modelId ||
				(args.provider !== null && model.provider !== args.provider)
			) {
				throw new Error(
					`${modelId} resolved to ${model.canonicalName} on ${model.provider}: ${args.provider ?? "the account's provider"} does not serve ${modelId}. Nothing was sent.`,
				);
			}
		}
		resolved.push({ notes, suggestions });
	}

	deps.log(
		`Parlume notes evaluation: ${fixtures.length} fixtures on ${args.models.join(", ")}, billed to the ${args.provider ?? "default"} AI provider of user ${userId}.`,
	);
	const models: ModelReport[] = [];
	for (const { notes, suggestions } of resolved) {
		const runs: FixtureRun[] = [];
		const failed: ModelReport["failed"] = [];
		for (const fixture of fixtures) {
			const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
			try {
				const result = await evaluateFixture({
					fixture,
					notesModel: notes,
					suggestionModel: suggestions,
					prompts,
					usage,
				});
				runs.push({ ...result, usage });
				deps.log(`  ${notes.canonicalName} ${fixture.id}: done`);
			} catch (error) {
				const message =
					error instanceof Error ? error.message : String(error);
				failed.push({ fixture: fixture.id, error: message, usage });
				deps.log(`  ${notes.canonicalName} ${fixture.id}: ${message}`);
			}
		}
		models.push(summarize(notes, runs, failed));
	}

	const report: EvalReport = {
		generatedAt,
		runId: account.runId,
		fixtures: fixtures.map((fixture) => fixture.id),
		prompts: {
			notes: args.notesPrompt ?? "default",
			suggestion: args.suggestionPrompt ?? "default",
		},
		priceSource: PRICE_SOURCE,
		models,
	};
	const markdown = markdownReport(report);
	await deps.writeFile(out, `${JSON.stringify(report, null, "\t")}\n`);
	await deps.writeFile(markdownPath(out), markdown);
	deps.log(markdown);
	return { mode: "run", report, markdown };
}

/**
 * Runs the evaluation from command-line arguments: a dry run unless
 * `--confirm-spend` is given.
 */
export async function runParlumeEval(
	argv: string[],
	deps: EvalDeps,
): Promise<DryRun | EvalRun> {
	const args = parseEvalArgs(argv);
	const fixtures = await loadEvalFixtures(
		args.fixtures.length > 0 ? args.fixtures : [DEFAULT_FIXTURES_DIR],
	);
	const prompts = await readPrompts(args);
	if (!args.confirmSpend) {
		const estimates: FixtureEstimate[] = [];
		for (const fixture of fixtures) {
			estimates.push(await estimateFixture(fixture, prompts));
		}
		return dryRun(args, estimates, deps);
	}
	return run(args, prompts, fixtures, deps);
}
