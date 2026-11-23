/**
 * The Parlume notes evaluation: synthetic meetings through Parlume's notes
 * and suggestion passes on each model, scored for anchor validity, owner and
 * due date accuracy, invented decisions and suggestion precision, with the
 * tokens and cost of the run. See docs/features/parlume-meetings.md.
 *
 * A dry run by default: it prints the passes and a token and cost estimate,
 * and sends nothing. `--confirm-spend` runs it on the AI provider of the
 * account named by `--user-id` (and `--organization-id`), which pays for it:
 * get the spend approved first. Model ids are catalog names, resolved
 * through that account's default provider like any Parlume call, or through
 * its own config for the provider `--provider` names.
 *
 * Run from the repo root with the target environment's DATABASE_URL and
 * token-encryption env loaded (e.g. via dotenv-cli):
 *   npx dotenv -c -e .env.local -- npx tsx packages/api/scripts/parlume-eval.ts --models claude-haiku-5-5,claude-sonnet-5-5,claude-opus-5-5
 *   npx dotenv -c -e .env.local -- npx tsx packages/api/scripts/parlume-eval.ts --models claude-haiku-5-5 --confirm-spend --user-id <id> --organization-id <id> --provider ANTHROPIC_DIRECT --out parlume-eval.json
 */
import { writeFile } from "node:fs/promises";
import {
	type AIOperationContext,
	type GetAIModelOptions,
	getAIModelOnProvider,
	getAIModelWithMetadata,
} from "@repo/ai";
import { AIProviderSchema, db } from "@repo/database";
import { runParlumeEval } from "../evals/parlume/runner";

function aiProvider(value: string) {
	const parsed = AIProviderSchema.safeParse(value);
	if (!parsed.success) {
		throw new Error(
			`--provider ${value} is not an AI provider. Use one of: ${AIProviderSchema.options.join(", ")}.`,
		);
	}
	return parsed.data;
}

async function main(): Promise<void> {
	const result = await runParlumeEval(process.argv.slice(2), {
		resolveModel: async (modelId, job, account) => {
			const options: GetAIModelOptions & { modelOverride: string } = {
				taskType: "SIMPLE",
				complexity: "simple",
				modelOverride: modelId,
			};
			const context: AIOperationContext = {
				userId: account.userId,
				organizationId: account.organizationId ?? undefined,
				projectId: account.projectId ?? undefined,
				featureKey: "parlume",
				jobType: job,
				conversationId: account.runId,
				// A script is no member's own work: never their ChatGPT plan,
				// even one that takes background jobs.
				excludeChatGptPlan: true,
			};
			const { model, metadata } = account.provider
				? await getAIModelOnProvider(
						aiProvider(account.provider),
						options,
						context,
					)
				: await getAIModelWithMetadata(options, context);
			return {
				model,
				canonicalName: metadata.canonicalName,
				provider: metadata.provider,
			};
		},
		writeFile: (path, content) => writeFile(path, content, "utf8"),
		log: (line) => console.log(line),
	});
	if (
		result.mode === "run" &&
		result.report.models.some((model) => model.failed.length > 0)
	) {
		process.exitCode = 1;
	}
}

main()
	.catch((error) => {
		console.error(
			"[parlume-eval]",
			error instanceof Error ? error.message : error,
		);
		process.exitCode = 1;
	})
	.finally(() => db.$disconnect());
