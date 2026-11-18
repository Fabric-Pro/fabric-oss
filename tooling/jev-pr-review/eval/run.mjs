import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";
import { loadDecision, readDiffs } from "../main.mjs";
import { QUESTIONS } from "../questions.mjs";
import { evaluate } from "../review.mjs";

const keys = Object.keys(QUESTIONS);
const cutoffs = [0.7, 0.75, 0.8, 0.85, 0.9, 0.95];
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const dataset = new URL("./dataset.json", import.meta.url);
const sources = ["live-finding", "fix-history", "clean-sample"];

export function validateDataset(cases) {
	if (!Array.isArray(cases)) {
		throw new Error("Dataset must be an array");
	}
	const ids = new Set();
	for (const [index, entry] of cases.entries()) {
		const invalid = (field) => {
			throw new Error(`Invalid dataset case ${index + 1} (${field})`);
		};
		if (entry === null || typeof entry !== "object") {
			invalid("expected object");
		}
		if (typeof entry.id !== "string" || !entry.id.trim()) {
			invalid("id");
		}
		if (ids.has(entry.id)) {
			invalid("duplicate id");
		}
		ids.add(entry.id);
		for (const field of ["base", "head"]) {
			const sha = entry[field];
			if (typeof sha !== "string" || !/^[a-f0-9]{40}$/i.test(sha)) {
				invalid(field);
			}
		}
		if (!["defect", "clean"].includes(entry.label)) {
			invalid("label");
		}
		if (
			!keys.includes(entry.question) &&
			!(entry.question === "all" && entry.label === "clean")
		) {
			invalid("question");
		}
		if (
			typeof entry.note !== "string" ||
			!entry.note.trim() ||
			/[\r\n\u2028\u2029]/u.test(entry.note)
		) {
			invalid("note");
		}
		if (!sources.includes(entry.source)) {
			invalid("source");
		}
	}
	return cases;
}

const runGit = (args) =>
	promisify(execFile)("git", args, { cwd: repoRoot, timeout: 60_000 });

export async function ensureCommit(sha, git = runGit) {
	const check = ["cat-file", "-e", `${sha}^{commit}`];
	try {
		await git(check);
	} catch {
		try {
			await git(["fetch", "origin", sha]);
		} catch {
			// Check the object again in case another process fetched it.
		}
		await git(check);
	}
}

export async function runCases(
	cases,
	{
		model,
		decide,
		questions = QUESTIONS,
		questionDetails,
		ensure = ensureCommit,
		readFiles = readDiffs,
	},
) {
	const results = [];
	for (const entry of cases) {
		const reasons = [];
		const result = {
			...entry,
			status: "not evaluated",
			scores: Object.fromEntries(keys.map((key) => [key, null])),
			reasons,
		};
		results.push(result);
		try {
			await ensure(entry.base);
			await ensure(entry.head);
		} catch {
			reasons.push("commit unavailable");
			continue;
		}

		let files;
		try {
			files = await readFiles(entry.base, entry.head);
		} catch {
			reasons.push("git diff failed");
			continue;
		}
		if (!files.length) {
			reasons.push("no source diff");
			continue;
		}

		let review;
		try {
			review = await evaluate({
				files,
				model,
				decide,
				questions,
				questionDetails,
				localize: false,
			});
		} catch {
			reasons.push("diff packing or evaluation setup failed");
			continue;
		}
		result.scores = Object.fromEntries(
			review.rows.map(({ key, score }) => [key, score]),
		);
		if (review.errors.length) {
			reasons.push("model request error or timeout");
		}
		if (review.invalidAnswers.length) {
			reasons.push("invalid model answer");
		}
		if (review.skipped.length) {
			reasons.push("source requests skipped");
		}
		if (review.truncatedFiles.length) {
			reasons.push("source diff truncated");
		}
		if (!reasons.length) {
			result.status = "evaluated";
		}
	}
	return results;
}

export function cutoffTables(results, questionKeys = keys) {
	return Object.fromEntries(
		questionKeys.map((key) => {
			const evaluated = results.filter(
				({ question, status }) =>
					status === "evaluated" &&
					(question === key || question === "all"),
			);
			const defects = evaluated.filter(({ label }) => label === "defect");
			const clean = evaluated.filter(({ label }) => label === "clean");
			return [
				key,
				cutoffs.map((cutoff) => ({
					cutoff,
					defectsCaught: defects.filter(
						({ scores }) => scores[key] >= cutoff,
					).length,
					defectsTotal: defects.length,
					cleanFlagged: clean.filter(
						({ scores }) => scores[key] >= cutoff,
					).length,
					cleanTotal: clean.length,
				})),
			];
		}),
	);
}

async function loadQuestions(path) {
	const { QUESTIONS: alternate } = await import(
		pathToFileURL(resolve(path)).href
	);
	if (
		!alternate ||
		Object.keys(alternate).length !== keys.length ||
		keys.some(
			(key) =>
				!Object.hasOwn(alternate, key) ||
				typeof alternate[key] !== "string" ||
				!alternate[key].trim(),
		)
	) {
		throw new Error("Invalid QUESTIONS map");
	}
	return alternate;
}

function printResults(cases, tables, report) {
	for (const [key, rows] of Object.entries(tables)) {
		report(
			[
				`\n${key}`,
				"| Cutoff | Defects caught / total | Clean flagged / total |",
				"| --- | --- | --- |",
				...rows.map(
					({
						cutoff,
						defectsCaught,
						defectsTotal,
						cleanFlagged,
						cleanTotal,
					}) =>
						`| ${cutoff.toFixed(2)} | ${defectsCaught}/${defectsTotal} | ${cleanFlagged}/${cleanTotal} |`,
				),
			].join("\n"),
		);
	}
	report("\nCase scores");
	for (const { id, scores, status, reasons } of cases) {
		const cause = reasons.length ? ` (${reasons.join(", ")})` : "";
		report(`${id}: ${status}${cause} ${JSON.stringify(scores)}`);
	}
}

export async function main(
	argv,
	{
		apiKey,
		datasetPath = dataset,
		questionDetails,
		load = loadDecision,
		ensure = ensureCommit,
		readFiles = readDiffs,
		report = console.log,
	} = {},
) {
	if (!apiKey) {
		throw new Error("Missing AI_GATEWAY_API_KEY.");
	}
	let values;
	try {
		({ values } = parseArgs({
			args: argv,
			options: {
				questions: { type: "string" },
				only: { type: "string" },
				out: { type: "string" },
			},
		}));
	} catch {
		throw new Error(
			"Usage: run.mjs [--questions file.mjs] [--only question] [--out results.json]",
		);
	}
	if (values.only !== undefined && !keys.includes(values.only)) {
		throw new Error(`--only must be one of ${keys.join(", ")}.`);
	}

	let entries;
	try {
		entries = JSON.parse(await readFile(datasetPath, "utf8"));
	} catch {
		throw new Error("Could not load the evaluation dataset as JSON.");
	}
	const allCases = validateDataset(entries);
	const selected = values.only
		? allCases.filter(
				({ question }) =>
					question === values.only || question === "all",
			)
		: allCases;
	let questions = QUESTIONS;
	if (values.questions !== undefined) {
		try {
			questions = await loadQuestions(values.questions);
		} catch {
			throw new Error(
				"--questions must load a module exporting a QUESTIONS map with the four non-empty strings.",
			);
		}
	}
	let decision;
	try {
		decision = load(apiKey);
	} catch {
		throw new Error("Could not initialize the workspace decision model.");
	}
	const cases = await runCases(selected, {
		...decision,
		questions,
		questionDetails,
		ensure,
		readFiles,
	});
	const tables = cutoffTables(cases, values.only ? [values.only] : keys);
	printResults(cases, tables, report);
	if (values.out !== undefined) {
		try {
			await writeFile(
				values.out,
				`${JSON.stringify({ cases, tables }, null, 2)}\n`,
			);
		} catch {
			throw new Error("Could not write the evaluation results.");
		}
	}
}

if (
	process.argv[1] &&
	pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
	try {
		await main(process.argv.slice(2), {
			apiKey: process.env.AI_GATEWAY_API_KEY,
		});
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
