/**
 * Reports how large each route's traced file set is, and how much headroom is
 * left against Vercel's function size limit.
 *
 * Why this exists: a Vercel deploy fails outright when a function exceeds 250 MB
 * uncompressed, and this app deploys within a few MB of it — a routine
 * dependency bump is enough to block EVERY deploy, including the hotfix you
 * need mid-incident (issue #2131). The platform only reports the size once a
 * deploy has already failed, which is the worst moment to learn it. Next's own
 * `.nft.json` files hold the same information at build time, so measure it here
 * and print it on every build, on every environment.
 *
 * IMPORTANT — this is a DELTA tracker, not a prediction of the platform number.
 * It sums the files Next traced for a route. The lambda Vercel actually builds
 * is larger: it adds the launcher and runtime layers on top. Measured offset on
 * this app at the time of writing is roughly 75-80 MB (157 MB traced locally vs
 * ~235 MB reported by Vercel for /api/[[...rest]]). So the useful signal is
 * "this build traces N MB more than the last one", not "we are at N MB". The
 * budget below is set from the traced side with that offset already deducted.
 *
 * Deliberately advisory: it never fails the build. A size ceiling enforced here
 * would be a second, differently-calibrated cliff on top of the platform's real
 * one — and failing a build over an estimate is its own outage risk.
 */
// Namespace import, not named. A named import of a builtin export the running
// Node does not have is a LINK-time SyntaxError — it fires before this module's
// body executes, so the try/catch at the bottom cannot contain it and the build
// dies on an advisory script. Reaching the same functions through the namespace
// turns that into an ordinary undefined-property check we can handle.
import fs from "node:fs";
import path from "node:path";

const MB = 1024 * 1024;

/**
 * Traced-size budget, i.e. Vercel's 250 MB uncompressed limit minus the
 * platform overhead described above, rounded down for margin. Crossing it does
 * not fail anything; it prints a warning loud enough to notice in a build log.
 */
const TRACED_BUDGET_MB = Number(process.env.FUNCTION_TRACE_BUDGET_MB ?? 170);

/**
 * Percentage of that budget at which to start saying so. The budget models the
 * cliff itself, so a warning that only fires once it is crossed arrives too late
 * to act on — this is the "one more dependency bump and you are there" line.
 */
const NOTICE_PCT = Number(process.env.FUNCTION_TRACE_NOTICE_PCT ?? 85);
const TOP_N = Number(process.env.FUNCTION_TRACE_TOP_N ?? 5);

const serverDir = path.resolve(import.meta.dirname, "../.next/server");

/** One stat per unique path — routes overlap heavily, and stat() is the cost. */
const sizeCache = new Map();
function sizeOf(absolutePath) {
	if (!sizeCache.has(absolutePath)) {
		let size = 0;
		try {
			size = fs.statSync(absolutePath).size;
		} catch {
			// Trace lists can name files that did not survive the build (e.g. a
			// pruned optional dependency). Vercel skips them too; count them as 0
			// rather than crashing the report.
		}
		sizeCache.set(absolutePath, size);
	}
	return sizeCache.get(absolutePath);
}

const asMb = (bytes) => (bytes / MB).toFixed(1);

function report() {
	if (typeof fs.globSync !== "function") {
		// Node < 22 has no fs.globSync. Nothing to do but say so — this report is
		// not worth failing a build over.
		console.log(
			"function-size report: fs.globSync unavailable on this Node — skipping.",
		);
		return;
	}
	const traceFiles = fs.globSync("**/*.nft.json", { cwd: serverDir });

	const routes = [];
	for (const relativeTrace of traceFiles) {
		const traceFile = path.join(serverDir, relativeTrace);
		let files;
		try {
			({ files } = JSON.parse(fs.readFileSync(traceFile, "utf8")));
		} catch {
			continue;
		}
		// A trace can be valid JSON without being a trace (`{"version":1}`).
		if (!Array.isArray(files)) {
			continue;
		}
		const base = path.dirname(traceFile);
		// Dedupe: a trace list can name the same file through two relative paths.
		const unique = new Set(
			files
				.filter((file) => typeof file === "string")
				.map((file) => path.resolve(base, file)),
		);
		let total = 0;
		for (const absolutePath of unique) {
			total += sizeOf(absolutePath);
		}
		routes.push({
			route: relativeTrace.replace(/\.nft\.json$/, ""),
			bytes: total,
			fileCount: unique.size,
		});
	}

	// Covers both "tracing produced nothing" and "every trace was unreadable".
	if (routes.length === 0) {
		console.log(
			"function-size report: no readable .nft.json files under .next/server — nothing to measure, skipping.",
		);
		return;
	}

	routes.sort((a, b) => b.bytes - a.bytes);
	const largest = routes[0];

	console.log(
		`\nfunction-size report: ${routes.length} traced routes, budget ${TRACED_BUDGET_MB} MB traced (see header — the platform adds its own overhead).`,
	);
	for (const { route, bytes, fileCount } of routes.slice(0, TOP_N)) {
		console.log(
			`  ${asMb(bytes).padStart(7)} MB  ${String(fileCount).padStart(5)} files  ${route}`,
		);
	}

	const budgetBytes = TRACED_BUDGET_MB * MB;
	const usedPct = Math.round((largest.bytes / budgetBytes) * 100);
	const headroomMb = asMb(budgetBytes - largest.bytes);
	if (largest.bytes > budgetBytes) {
		console.warn(
			`\n  WARNING: largest function traces ${asMb(largest.bytes)} MB, over the ${TRACED_BUDGET_MB} MB budget (${usedPct}%).` +
				"\n  A Vercel deploy is likely to fail with a function size error. Trim the trace" +
				"\n  (outputFileTracingExcludes in next.config.ts) or enable large functions" +
				"\n  (VERCEL_SUPPORT_LARGE_FUNCTIONS=1) before merging.",
		);
	} else if (usedPct >= NOTICE_PCT) {
		// The budget models the cliff, so warning only AT it leaves no room to
		// act. Speak up while there is still a bump's worth of headroom.
		console.log(
			`\n  NOTICE: largest function traces ${asMb(largest.bytes)} MB — ${usedPct}% of the ${TRACED_BUDGET_MB} MB budget,` +
				`\n  ${headroomMb} MB left. Worth trimming before it becomes a failed deploy. — ${largest.route}\n`,
		);
	} else {
		console.log(
			`\n  Largest: ${asMb(largest.bytes)} MB (${usedPct}% of budget, ${headroomMb} MB headroom) — ${largest.route}\n`,
		);
	}
}

try {
	report();
} catch (error) {
	// Load-bearing: this runs inside `pnpm build`, so an advisory report that
	// throws would block every deploy — a strictly worse outage than the size
	// creep it exists to warn about. Say what broke and get out of the way.
	console.warn(
		`function-size report: skipped after an unexpected error — ${error?.message ?? error}`,
	);
}
