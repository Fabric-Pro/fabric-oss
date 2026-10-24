import { QUESTION_DETAILS, QUESTIONS } from "./questions.mjs";

const MAX_CHARS = 60_000;
const MAX_PRIMARY_REQUESTS = 20;
const MAX_LOCALIZATION_CALLS = 20;
const CALL_TIMEOUT_MS = 30_000;
export const isSourceFile = (path) =>
	/\.(ts|tsx|js|mjs|cjs|py)$/.test(path) &&
	!/(__tests__|\.test\.|\.spec\.|(?:^|\/)tests?\/|fixtures|generated|(?:^|\/)prisma\/zod\/|\.d\.ts$)/.test(
		path,
	);
export function parseCutoff(value) {
	const n =
		typeof value === "string" && value.trim() !== ""
			? Number(value)
			: Number.NaN;
	return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.8;
}
function probability(result, key) {
	const score = result?.answers?.[key]?.probability;
	return typeof score === "number" &&
		Number.isFinite(score) &&
		score >= 0 &&
		score <= 1
		? score
		: null;
}

function splitFile(file, limit = MAX_CHARS) {
	if (file.diff.length <= limit) {
		return [{ ...file, truncated: false }];
	}
	const start = file.diff.search(/^@@ /m);
	const header = start < 0 ? file.diff : file.diff.slice(0, start);
	// An unrepresentable header is an evaluation error, not a pathless request.
	if (header.length + 32 >= limit) {
		throw new Error("File header exceeds request budget");
	}
	const hunks = file.diff
		.slice(start)
		.split(/(?=^@@ )/m)
		.filter(Boolean);
	const parts = [];
	let diff = header;
	let truncated = false;
	for (let hunk of hunks) {
		const hunkTruncated = header.length + hunk.length > limit;
		if (hunkTruncated) {
			const marker = "\n[hunk truncated]";
			hunk =
				hunk.slice(0, limit - header.length - marker.length) + marker;
		}
		if (diff.length + hunk.length > limit && diff !== header) {
			parts.push({ path: file.path, diff, truncated });
			diff = header;
			truncated = false;
		}
		diff += hunk;
		truncated ||= hunkTruncated;
	}
	if (diff !== header) {
		parts.push({ path: file.path, diff, truncated });
	}
	return parts;
}

export function packDiffs(files, limit = MAX_CHARS) {
	const requests = [];
	let current = { diff: "", parts: [], truncated: false };
	for (const file of files) {
		for (const part of splitFile(file, limit)) {
			const separator = current.parts.length ? "\n" : "";
			if (
				current.diff.length + separator.length + part.diff.length >
				limit
			) {
				requests.push(current);
				current = { diff: "", parts: [], truncated: false };
			}
			current.diff += (current.parts.length ? "\n" : "") + part.diff;
			current.parts.push(part);
			current.truncated ||= part.truncated;
		}
	}
	if (current.parts.length) {
		requests.push(current);
	}
	return requests;
}

const ask = (decide, model, diff, keys) =>
	decide({
		model,
		state: { diff },
		questions: Object.fromEntries(
			keys.map((key) => [
				key,
				{ type: "boolean", instructions: QUESTIONS[key] },
			]),
		),
		maxRetries: 2,
		abortSignal: AbortSignal.timeout(CALL_TIMEOUT_MS),
	});

export async function evaluate({ files, decide, model, cutoff = 0.8 }) {
	const requests = packDiffs(files);
	const errors = [];
	const skipped = [];
	const invalidAnswers = new Set();
	const truncatedFiles = [
		...new Set(
			requests.flatMap((request) =>
				request.parts
					.filter((part) => part.truncated)
					.map((part) => part.path),
			),
		),
	];
	let localizationCalls = 0;
	let localizationCapped = false;
	const rows = Object.keys(QUESTIONS).map((key) => ({
		key,
		score: null,
		failed: false,
		missing: [],
		path: "",
		others: [],
		fallback: false,
		failing: [],
	}));
	for (const [index, request] of requests.entries()) {
		if (index >= MAX_PRIMARY_REQUESTS) {
			skipped.push(index + 1);
			for (const row of rows) {
				row.missing.push(index + 1);
			}
			continue;
		}
		let result;
		let requestFailed = false;
		try {
			result = await ask(
				decide,
				model,
				request.diff,
				Object.keys(QUESTIONS),
			);
		} catch {
			errors.push(index + 1);
			requestFailed = true;
		}
		for (const row of rows) {
			const score = probability(result, row.key);
			if (score === null) {
				row.missing.push(index + 1);
				if (!requestFailed) {
					invalidAnswers.add(index + 1);
				}
			} else {
				row.score = Math.max(row.score ?? 0, score);
				if (score >= cutoff) {
					row.failed = true;
					row.failing.push(index);
				}
			}
		}
	}
	// Localize valid findings even when another request has no answer.
	for (const row of rows.filter((row) => row.failed)) {
		const candidates = [
			...new Set(
				row.failing.flatMap((index) =>
					requests[index].parts.map((part) => part.path),
				),
			),
		];
		const candidateFiles = files.filter((file) =>
			candidates.includes(file.path),
		);
		try {
			const scores = [];
			for (const file of candidateFiles) {
				let max = 0;
				for (const part of splitFile(file)) {
					if (localizationCalls >= MAX_LOCALIZATION_CALLS) {
						localizationCapped = true;
						throw new Error("Localization call cap reached");
					}
					localizationCalls++;
					const result = await ask(decide, model, part.diff, [
						row.key,
					]);
					const score = probability(result, row.key);
					if (score === null) {
						throw new Error("No localization answer");
					}
					max = Math.max(max, score);
				}
				scores.push({ path: file.path, score: max });
			}
			scores.sort((a, b) => b.score - a.score);
			row.path = scores[0].path;
			row.others = scores
				.slice(1)
				.filter((file) => file.score >= cutoff)
				.map((file) => file.path);
		} catch {
			row.path = candidateFiles.reduce((a, b) =>
				a.diff.length >= b.diff.length ? a : b,
			).path;
			row.fallback = true;
		}
	}
	return {
		rows,
		requests,
		errors,
		skipped,
		invalidAnswers: [...invalidAnswers],
		truncatedFiles,
		localizationCapped,
	};
}

export const marker = (key, head) => `<!-- jev-pr-review:${key}:${head} -->`;
const codePath = (path) =>
	`\`${path.replaceAll("`", "\\`").replaceAll("\n", " ")}\``;
export function commentBody(row, head) {
	const detail = QUESTION_DETAILS[row.key];
	return [
		`**${detail.title}** — ${detail.rule}`,
		`Confidence: ${row.score.toFixed(2)}. Judged head: \`${head.slice(0, 7)}\`.`,
		row.fallback
			? "The file could not be pinned down; this thread is anchored on the largest candidate file."
			: "",
		row.others.length
			? `Other flagged files: ${row.others.map(codePath).join(", ")}.`
			: "",
		"This is an automated check by the Jev decision model and can be wrong; if it is, reply why and resolve the thread.",
		marker(row.key, head),
	]
		.filter(Boolean)
		.join("\n\n");
}

export async function postFindings({ rows, github, head }) {
	const findings = rows.filter((row) => row.failed);
	if (!findings.length) {
		return;
	}
	const existing = await github.listComments();
	for (const row of findings) {
		if (
			existing.some((comment) =>
				comment.body?.includes(marker(row.key, head)),
			)
		) {
			continue;
		}
		await github.postComment({
			body: commentBody(row, head),
			commit_id: head,
			path: row.path,
			subject_type: "file",
		});
	}
}

export function summaryTable(rows, { truncatedFiles = [] } = {}) {
	return [
		"| Question | Max score | Verdict | File |",
		"| --- | --- | --- | --- |",
		...rows.map(
			(row) =>
				`| ${QUESTION_DETAILS[row.key].title} | ${row.score === null ? "—" : row.score.toFixed(2)} | ${row.missing.length ? `${row.failed ? "Finding; " : ""}NOT EVALUATED: requests ${row.missing.join(", ")}` : row.failed ? "Finding" : truncatedFiles.length ? "No violation scored in sent content (truncated)" : "No violation scored"} | ${row.path ? `${codePath(row.path).replaceAll("|", "\\|")}${row.fallback ? " (fallback)" : ""}` : "—"} |`,
		),
	].join("\n");
}
