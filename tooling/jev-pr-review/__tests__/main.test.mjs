import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { githubClient, loadDecision, readDiffs, run } from "../main.mjs";
import { QUESTIONS } from "../questions.mjs";

const head = "a".repeat(40);
const env = {
	AI_GATEWAY_API_KEY: "synthetic",
	BASE_SHA: "b".repeat(40),
	HEAD_SHA: head,
	PR_NUMBER: "1",
	GITHUB_REPOSITORY: "example-org/example-repo",
	GITHUB_TOKEN: "synthetic",
};
const files = [
	{
		path: "src/a.ts",
		diff: "diff --git a/src/a.ts b/src/a.ts\n@@ -0,0 +1 @@\n+const x = 1;\n",
	},
];
const answer = (score) => ({
	answers: Object.fromEntries(
		Object.keys(QUESTIONS).map((key) => [key, { probability: score }]),
	),
});
const fail = () => {
	throw new Error("synthetic failure");
};
async function exercise(overrides = {}) {
	const messages = [];
	const posts = [];
	let reads = 0;
	const code = await run({
		env,
		readFiles: () => files,
		load: () => ({ decide: async () => answer(0.1), model: "synthetic" }),
		makeGithub: () => ({
			listComments: async () => {
				reads++;
				return [];
			},
			postComment: async (body) => posts.push(body),
		}),
		report: (message) => messages.push(message),
		...overrides,
	});
	return { code, posts, reads, summary: messages.join("\n") };
}

test("error-as-pass: missing key, git, SDK, model, timeout, packing and invalid answers", async () => {
	const cases = [
		{ env: { ...env, AI_GATEWAY_API_KEY: "" } },
		{ readFiles: fail },
		{ load: fail },
		{ load: () => ({ decide: async () => fail() }) },
		{
			load: () => ({
				decide: async () => {
					throw new DOMException("synthetic", "TimeoutError");
				},
			}),
		},
		{ readFiles: () => [{ path: "a.ts", diff: "x".repeat(60001) }] },
		{ load: () => ({ decide: async () => ({ answers: {} }) }) },
		{ load: () => ({ decide: async () => answer(Number.NaN) }) },
	];
	for (const overrides of cases) {
		const result = await exercise(overrides);
		assert.equal(result.code, 0);
		assert.match(result.summary, /did not run/i);
		assert.doesNotMatch(result.summary, /no issues found/i);
		assert.equal(result.posts.length, 0);
		assert.equal(result.reads, 0);
	}
});

test("missing answer for one question preserves other findings and reports request", async () => {
	const result = await exercise({
		load: () => ({
			decide: async () => {
				const result = answer(0.9);
				delete result.answers.authz;
				return result;
			},
		}),
	});
	assert.equal(result.code, 0);
	assert.equal(result.posts.length, Object.keys(QUESTIONS).length - 1);
	assert.ok(
		result.posts.every(
			(post) => !post.body.includes("jev-pr-review:authz:"),
		),
	);
	assert.match(result.summary, /NOT EVALUATED: requests 1/);
	assert.match(result.summary, /Record permissions/);
});

test("no source files passes without loading SDK or using GitHub", async () => {
	const result = await exercise({
		readFiles: () => [],
		load: fail,
		makeGithub: fail,
	});
	assert.equal(result.code, 0);
	assert.match(result.summary, /no source files/);
});

test("idempotency skips matching head markers, posts file-level comments for new findings", async () => {
	const posts = [];
	const result = await exercise({
		load: () => ({ decide: async () => answer(0.8) }),
		makeGithub: () => ({
			listComments: async () => [
				{ body: `<!-- jev-pr-review:authz:${head} -->` },
				{ body: `<!-- jev-pr-review:secrets:${"c".repeat(40)} -->` },
			],
			postComment: async (body) => posts.push(body),
		}),
	});
	assert.equal(result.code, 0);
	assert.equal(posts.length, Object.keys(QUESTIONS).length - 1);
	assert.ok(posts.some((p) => p.body.includes("jev-pr-review:secrets:")));
	for (const post of posts) {
		assert.equal(post.commit_id, head);
		assert.equal(post.path, "src/a.ts");
		assert.equal(post.subject_type, "file");
		assert.equal("line" in post, false);
	}
});

test("finding delivery failures are non-zero, including list and client setup failures", async () => {
	for (const makeGithub of [
		fail,
		() => ({ listComments: fail }),
		() => ({ listComments: async () => [], postComment: fail }),
	]) {
		const result = await exercise({
			load: () => ({ decide: async () => answer(0.8) }),
			makeGithub,
		});
		assert.equal(result.code, 1);
		assert.match(result.summary, /COMMENT POSTING FAILED/);
	}
});

test("GitHub REST paginates review comments and posts the specified payload", async () => {
	const calls = [];
	const github = githubClient({
		repo: env.GITHUB_REPOSITORY,
		pr: "1",
		token: "synthetic",
		fetchImpl: async (url, options) => {
			calls.push({ url, options });
			return {
				ok: true,
				json: async () =>
					options.method === "POST"
						? {}
						: url.endsWith("page=1")
							? Array.from({ length: 100 }, () => ({ body: "" }))
							: [{ body: "last" }],
			};
		},
	});
	assert.equal((await github.listComments()).length, 101);
	await github.postComment({ body: "synthetic", subject_type: "file" });
	assert.match(calls[1].url, /per_page=100&page=2$/);
	assert.equal(calls[2].options.method, "POST");
	assert.equal(JSON.parse(calls[2].options.body).subject_type, "file");
	assert.ok(calls[2].options.signal instanceof AbortSignal);
});

test("GitHub errors do not expose response text or credentials", async () => {
	const github = githubClient({
		repo: env.GITHUB_REPOSITORY,
		pr: "1",
		token: "synthetic",
		fetchImpl: async () => ({ ok: false, status: 403, text: fail }),
	});
	await assert.rejects(github.listComments(), /GitHub GET failed \(403\)/);
});

test("readDiffs uses NUL-delimited paths, separate path arguments, U3 and full SHA validation", async () => {
	const calls = [];
	const result = await readDiffs(env.BASE_SHA, head, (args) => {
		calls.push(args);
		if (args[0] === "merge-base") {
			return `${"c".repeat(40)}\n`;
		}
		return args.includes("--name-only")
			? "src/a.ts\0tests/a.ts\0src/[x].py\0"
			: files[0].diff;
	});
	assert.deepEqual(
		result.map((f) => f.path),
		["src/a.ts", "src/[x].py"],
	);
	assert.ok(calls[1].includes("-z"));
	assert.ok(calls[2].includes("-U3"));
	assert.equal(calls[3].at(-1), "src/[x].py");
	await assert.rejects(
		readDiffs("--bad", head, fail),
		/Expected full commit SHA/,
	);
});

test("workspace AI SDK can be loaded and configured offline", () => {
	const loaded = loadDecision("synthetic");
	assert.equal(typeof loaded.decide, "function");
	assert.equal(loaded.model.modelId, "typesafe-ai/jev-1.14.0");
});

test("missing-key writes did-not-run step summary and returns zero", async () => {
	const dir = mkdtempSync(join(tmpdir(), "jev-review-"));
	try {
		const summary = join(dir, "summary.md");
		const code = await run({
			env: {
				...env,
				AI_GATEWAY_API_KEY: "",
				GITHUB_TOKEN: "",
				GITHUB_STEP_SUMMARY: summary,
			},
		});
		assert.equal(code, 0);
		assert.match(readFileSync(summary, "utf8"), /did not run/i);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("readDiffs diffs both path listing and files from merge base, excluding base-tip changes", async () => {
	const ancestor = "c".repeat(40);
	const calls = [];
	const result = await readDiffs(env.BASE_SHA, head, (args) => {
		calls.push(args);
		if (args[0] === "merge-base") {
			return `${ancestor}\n`;
		}
		if (args.includes("--name-only")) {
			return "src/a.ts\0";
		}
		return files[0].diff;
	});
	assert.deepEqual(calls[0], ["merge-base", env.BASE_SHA, head]);
	for (const args of calls.slice(1)) {
		const separator = args.indexOf("--");
		assert.deepEqual(args.slice(separator - 2, separator), [
			ancestor,
			head,
		]);
		assert.ok(!args.includes(env.BASE_SHA));
	}
	assert.equal(calls.length, 3);
	assert.equal(result.length, 1);
});

test("missing merge base is a git failure and reports did not run with exit zero", async () => {
	for (const git of [fail, () => "", () => "not-a-sha"]) {
		const result = await exercise({
			readFiles: () => readDiffs(env.BASE_SHA, head, git),
			load: fail,
		});
		assert.equal(result.code, 0);
		assert.equal(result.posts.length, 0);
		assert.match(result.summary, /DID NOT RUN.*git diff failed/);
	}
});

test("request 1 errors but request 2 finding is localized and posted with incomplete summary", async () => {
	for (const postingFails of [false, true]) {
		const posts = [];
		let requests = 0;
		const second = {
			path: "src/b.ts",
			diff: files[0].diff.replaceAll("src/a.ts", "src/b.ts"),
		};
		const result = await exercise({
			readFiles: () =>
				[files[0], second].map((file) => ({
					...file,
					diff: file.diff + "x".repeat(30000),
				})),
			load: () => ({
				decide: async ({ questions, state }) => {
					if (
						Object.keys(questions).length ===
							Object.keys(QUESTIONS).length &&
						++requests === 1
					) {
						throw new Error("synthetic timeout");
					}
					const result = answer(0.1);
					result.answers.authz.probability = 0.9;
					if (Object.keys(questions).length === 1) {
						assert.ok(state.diff.includes("src/b.ts"));
						assert.deepEqual(Object.keys(questions), ["authz"]);
					}
					return result;
				},
			}),
			makeGithub: () => ({
				listComments: async () => [],
				postComment: async (body) => {
					if (postingFails) {
						throw new Error("synthetic posting failure");
					}
					posts.push(body);
				},
			}),
		});
		assert.equal(result.code, postingFails ? 1 : 0);
		if (!postingFails) {
			assert.equal(posts.length, 1);
			assert.equal(posts[0].path, "src/b.ts");
			assert.ok(
				posts[0].body.includes(`<!-- jev-pr-review:authz:${head} -->`),
			);
		}
		assert.match(result.summary, /NOT EVALUATED: requests 1/);
		assert.match(result.summary, /Record permissions.*Finding/);
		assert.doesNotMatch(
			result.summary,
			/No violation scored|no comments posted/i,
		);
	}
});

test("truncated hunk is partially evaluated, names the file, and retains findings", async () => {
	for (const score of [0.1, 0.9]) {
		const result = await exercise({
			readFiles: () => [
				{
					path: "src/new.ts",
					diff: `${files[0].diff.replaceAll("src/a.ts", "src/new.ts") + "x".repeat(70000)}\n+omittedTail();`,
				},
			],
			load: () => ({
				decide: async ({ state }) => {
					assert.ok(state.diff.length <= 60000);
					assert.ok(!state.diff.includes("omittedTail"));
					return answer(score);
				},
			}),
		});
		assert.equal(result.code, 0);
		assert.match(result.summary, /PARTIALLY EVALUATED/);
		assert.match(result.summary, /[Tt]runcated files:.*src\/new\.ts/);
		assert.doesNotMatch(result.summary, /completed/);
		assert.equal(
			result.posts.length,
			score >= 0.8 ? Object.keys(QUESTIONS).length : 0,
		);
	}
});

test("clean complete run reports completed head and never constructs GitHub client", async () => {
	const result = await exercise({ makeGithub: fail });
	assert.equal(result.code, 0);
	assert.match(result.summary, /completed for `aaaaaaa`/);
	assert.doesNotMatch(result.summary, /NOT EVALUATED|PARTIALLY EVALUATED/);
});

test("summary names only observed primary error causes", async () => {
	const gateway = await exercise({ load: () => ({ decide: fail }) });
	assert.match(
		gateway.summary,
		/gateway\/model error or timeout on requests 1/,
	);
	assert.doesNotMatch(
		gateway.summary,
		/invalid or missing model answers|size cap|[Tt]runcated/,
	);
	const invalid = await exercise({
		load: () => ({ decide: async () => ({ answers: {} }) }),
	});
	assert.match(
		invalid.summary,
		/invalid or missing model answers on requests 1/,
	);
	assert.doesNotMatch(
		invalid.summary,
		/gateway\/model error|size cap|[Tt]runcated/,
	);
});

test("size cap reports skipped requests without calling them clean", async () => {
	let calls = 0;
	const result = await exercise({
		readFiles: () =>
			Array.from({ length: 22 }, (_, i) => ({
				path: `src/f${i}.ts`,
				diff: files[0].diff + "x".repeat(30000),
			})),
		load: () => ({
			decide: async () => {
				calls++;
				return answer(0.1);
			},
		}),
	});
	assert.equal(calls, 20);
	assert.equal(result.code, 0);
	assert.match(result.summary, /exceeded the size cap/);
	assert.match(result.summary, /NOT EVALUATED: requests 21, 22/);
	assert.doesNotMatch(
		result.summary,
		/completed|No violation scored|invalid or missing|gateway\/model error/,
	);
});
