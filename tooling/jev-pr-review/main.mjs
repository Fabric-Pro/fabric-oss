import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
	evaluate,
	isSourceFile,
	parseCutoff,
	postFindings,
	summaryTable,
} from "./review.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export async function readDiffs(
	base,
	head,
	git = async (args) =>
		(
			await promisify(execFile)("git", args, {
				cwd: repoRoot,
				encoding: "utf8",
				maxBuffer: 64 * 1024 * 1024,
				env: { ...process.env, GIT_LITERAL_PATHSPECS: "1" },
			})
		).stdout,
) {
	for (const sha of [base, head]) {
		if (!/^[a-f0-9]{40}$/i.test(sha ?? "")) {
			throw new Error("Expected full commit SHA");
		}
	}
	const mergeBase = (await git(["merge-base", base, head])).trim();
	if (!/^[a-f0-9]{40}$/i.test(mergeBase)) {
		throw new Error("Missing or invalid merge base");
	}
	const paths = (
		await git([
			"diff",
			"--name-only",
			"-z",
			"--no-renames",
			mergeBase,
			head,
			"--",
		])
	)
		.split("\0")
		.filter(isSourceFile);
	const files = [];
	for (const path of paths) {
		const diff = await git([
			"diff",
			"--no-ext-diff",
			"--no-textconv",
			"--no-renames",
			"--no-color",
			"-U3",
			mergeBase,
			head,
			"--",
			path,
		]);
		if (diff) {
			files.push({ path, diff });
		}
	}
	return files;
}

export function loadDecision(apiKey) {
	const { createGateway, experimental_decide } = createRequire(
		join(repoRoot, "packages/ai/package.json"),
	)("ai");
	return {
		model: createGateway({ apiKey }).decisionModel(
			"typesafe-ai/jev-1.14.0",
		),
		decide: experimental_decide,
	};
}

export function githubClient({ repo, pr, token, fetchImpl = fetch }) {
	if (
		!/^[\w.-]+\/[\w.-]+$/.test(repo ?? "") ||
		!/^[1-9]\d*$/.test(pr ?? "") ||
		!token
	) {
		throw new Error("Missing GitHub configuration");
	}
	const endpoint = `https://api.github.com/repos/${repo}/pulls/${pr}/comments`;
	const request = async (url, method, body) => {
		const response = await fetchImpl(url, {
			method,
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
				"Content-Type": "application/json",
			},
			...(body ? { body: JSON.stringify(body) } : {}),
			signal: AbortSignal.timeout(60_000),
		});
		if (!response.ok) {
			throw new Error(`GitHub ${method} failed (${response.status})`);
		}
		return response.json();
	};
	return {
		async listComments() {
			const comments = [];
			for (let page = 1; ; page++) {
				const batch = await request(
					`${endpoint}?per_page=100&page=${page}`,
					"GET",
				);
				if (!Array.isArray(batch)) {
					throw new Error("Invalid review comments response");
				}
				comments.push(...batch);
				if (batch.length < 100) {
					return comments;
				}
			}
		},
		postComment: (body) => request(endpoint, "POST", body),
	};
}

export async function run({
	env = process.env,
	readFiles = readDiffs,
	load = loadDecision,
	makeGithub = githubClient,
	report = (message) => {
		console.log(message);
		if (env.GITHUB_STEP_SUMMARY) {
			appendFileSync(env.GITHUB_STEP_SUMMARY, `${message}\n`);
		}
	},
} = {}) {
	const didNotRun = (reason) => {
		report(
			`**Jev PR review DID NOT RUN:** ${reason}. No question was evaluated; no model requests completed. No comments posted.`,
		);
		return 0;
	};
	if (!env.AI_GATEWAY_API_KEY) {
		return didNotRun("missing AI_GATEWAY_API_KEY (for example, a fork PR)");
	}
	let files;
	try {
		files = await readFiles(env.BASE_SHA, env.HEAD_SHA);
	} catch {
		return didNotRun("git diff failed or commit SHAs were invalid");
	}
	if (!files.length) {
		report("Jev PR review: no source files to evaluate; nothing posted.");
		return 0;
	}
	let decision;
	try {
		decision = load(env.AI_GATEWAY_API_KEY);
	} catch {
		return didNotRun("workspace AI SDK/model initialization failed");
	}
	let result;
	try {
		const { model, decide } = decision;
		result = await evaluate({
			files,
			model,
			decide,
			cutoff: parseCutoff(env.JEV_PR_REVIEW_CUTOFF),
		});
	} catch {
		return didNotRun(
			"diff packing or evaluation setup failed; questions were not fully evaluated",
		);
	}
	const table = summaryTable(result.rows, result);
	const causes = [];
	if (result.errors.length) {
		causes.push(
			`gateway/model error or timeout on requests ${result.errors.join(", ")}`,
		);
	}
	if (result.invalidAnswers.length) {
		causes.push(
			`invalid or missing model answers on requests ${result.invalidAnswers.join(", ")}`,
		);
	}
	if (result.skipped.length) {
		causes.push(
			`PR exceeded the size cap; requests ${result.skipped.join(", ")} were not evaluated`,
		);
	}
	if (result.truncatedFiles.length) {
		causes.push(
			`Truncated files: ${result.truncatedFiles.map((path) => JSON.stringify(path)).join(", ")}`,
		);
	}
	if (result.localizationCapped) {
		causes.push(
			"localization call cap reached; remaining findings use fallback anchors",
		);
	}
	const status = causes.length
		? `**Jev PR review PARTIALLY EVALUATED${result.rows.some((row) => row.missing.length) ? " (DID NOT RUN completely)" : ""}:** ${causes.join("; ")}. Valid findings are retained.`
		: `Jev PR review completed for \`${env.HEAD_SHA.slice(0, 7)}\`.`;
	try {
		if (result.rows.some((row) => row.failed)) {
			const github = makeGithub({
				repo: env.GITHUB_REPOSITORY,
				pr: env.PR_NUMBER,
				token: env.GITHUB_TOKEN,
			});
			await postFindings({
				rows: result.rows,
				github,
				head: env.HEAD_SHA,
			});
		}
	} catch {
		report(
			`**Jev PR review: COMMENT POSTING FAILED.** Findings could not all be delivered; some threads may already exist.\n\n${status}\n\n${table}`,
		);
		return 1;
	}
	report(`${status}\n\n${table}`);
	return 0;
}

if (
	process.argv[1] &&
	pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
	process.exitCode = await run();
}
