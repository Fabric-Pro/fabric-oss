import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Decides what .github/workflows/auto-merge.yml does to one pull request.
// The workflow passes the live REST pull request, never the event payload,
// so a label, draft or base change that landed after the event is honoured.

export const AUTO_MERGE_REPOSITORY = "Fabric-Pro/fabric-dev";
export const AUTO_MERGE_BASE = "staging";
export const OPT_OUT_LABEL = "no-auto-merge";

/**
 * Parses AUTO_MERGE_AUTHORS: GitHub logins separated by commas and/or
 * whitespace. Logins are case-insensitive on GitHub, so they are compared
 * lowercased.
 */
export function parseAuthors(value) {
	return new Set(
		String(value ?? "")
			.split(/[\s,]+/)
			.map((login) => login.toLowerCase())
			.filter(Boolean),
	);
}

function isBot(user) {
	return user?.type === "Bot" || String(user?.login ?? "").endsWith("[bot]");
}

/**
 * Returns { action, reason } where action is one of:
 * - "enable": arm squash auto-merge pinned to the current head;
 * - "rearm": auto-merge is armed and the head moved, so re-pin it;
 * - "disable": the opt-out label is present and auto-merge is armed;
 * - "none": leave the pull request alone.
 *
 * "none" never disarms. Only the opt-out label does, so a person who armed
 * auto-merge by hand on an unlisted author's pull request keeps it.
 */
export function decideAutoMerge({
	enabled,
	authors,
	repository,
	eventAction,
	pullRequest,
}) {
	const none = (reason) => ({ action: "none", reason });
	if (repository !== AUTO_MERGE_REPOSITORY) {
		return none("inactive-repository");
	}
	if (pullRequest.state !== "open") {
		return none("not-open");
	}
	if (pullRequest.base?.ref !== AUTO_MERGE_BASE) {
		return none("wrong-base");
	}
	if (pullRequest.head?.repo?.full_name !== repository) {
		return none("fork-head");
	}
	// GitHub expressions compare strings case-insensitively, so the job-level
	// `vars.AUTO_MERGE_ENABLED == 'true'` admits "TRUE" too; match it here.
	if (String(enabled ?? "").toLowerCase() !== "true") {
		return none("toggle-off");
	}
	const armed = pullRequest.auto_merge != null;
	const labels = (pullRequest.labels ?? []).map((label) => label.name);
	if (labels.includes(OPT_OUT_LABEL)) {
		return armed
			? { action: "disable", reason: "opted-out" }
			: none("opted-out");
	}
	if (pullRequest.draft) {
		return none("draft");
	}
	const login = String(pullRequest.user?.login ?? "").toLowerCase();
	if (!parseAuthors(authors).has(login)) {
		return none(
			isBot(pullRequest.user) ? "bot-author" : "author-not-listed",
		);
	}
	if (armed) {
		return eventAction === "synchronize"
			? { action: "rearm", reason: "head-moved" }
			: none("already-armed");
	}
	return { action: "enable", reason: "eligible" };
}

function main() {
	const pullRequest = JSON.parse(
		readFileSync(process.env.PULL_REQUEST_JSON, "utf8"),
	);
	const headSha = pullRequest.head?.sha;
	if (!/^[0-9a-f]{40}$/.test(String(headSha))) {
		throw new Error("GitHub supplied an invalid pull request head SHA");
	}
	const decision = decideAutoMerge({
		enabled: process.env.AUTO_MERGE_ENABLED,
		authors: process.env.AUTO_MERGE_AUTHORS,
		repository: process.env.GITHUB_REPOSITORY,
		eventAction: process.env.EVENT_ACTION,
		pullRequest,
	});
	const outputs = [
		`action=${decision.action}`,
		`reason=${decision.reason}`,
		`head_sha=${headSha}`,
	];
	appendFileSync(process.env.GITHUB_OUTPUT, `${outputs.join("\n")}\n`);
	appendFileSync(
		process.env.GITHUB_STEP_SUMMARY,
		`Auto-merge decision for #${pullRequest.number}: ` +
			`\`${decision.action}\` (${decision.reason}).\n`,
	);
	console.log(`Auto-merge decision: ${decision.action} (${decision.reason})`);
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	main();
}
