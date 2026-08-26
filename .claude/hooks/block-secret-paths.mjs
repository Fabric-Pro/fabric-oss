#!/usr/bin/env node
import { basename, extname } from "node:path";
import { writeBlockMessage } from "./lib/block-message.mjs";
import { readToolInput } from "./lib/parse-input.mjs";

const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const ENV_TEMPLATE_SUFFIXES = new Set([".example", ".sample", ".template"]);

/**
 * @typedef {Object} Verdict
 * @property {string} reason
 */

/**
 * Decide whether the given file path is a credential / secret target
 * that Claude must not modify. Markdown exemption applies first: any
 * `.md` file is allowed regardless of basename (docs about credentials
 * are not credentials themselves).
 *
 * @param {string} filePath
 * @returns {Verdict | null}
 */
function evaluate(filePath) {
	const norm = filePath.replace(/\\/g, "/");

	if (norm.toLowerCase().endsWith(".md")) {
		return null;
	}
	if (norm.includes("/node_modules/") || norm.startsWith("node_modules/")) {
		return null;
	}

	const base = basename(norm);
	const lowerBase = base.toLowerCase();
	const ext = extname(base);
	const lowerExt = ext.toLowerCase();

	// .env, .env.local, .env.production, .env.example, .env.sample, .env.template
	if (lowerBase === ".env" || lowerBase.startsWith(".env.")) {
		const suffix = lowerBase.slice(".env".length); // "", ".local", ".example", ...
		if (suffix === "" || !ENV_TEMPLATE_SUFFIXES.has(suffix)) {
			return {
				reason: ".env* files contain secrets and must not be modified by Claude",
			};
		}
		return null;
	}

	if (lowerExt === ".pem" || lowerExt === ".key") {
		return {
			reason: "private key material (.pem / .key) must not be modified by Claude",
		};
	}

	if (lowerBase === ".npmrc") {
		return {
			reason: ".npmrc commonly contains auth tokens — do not modify",
		};
	}

	// `credentials*` as a basename prefix (NOT a substring) — see decision
	// #3 at the top of tasks.md. `credentials.example.json` is allowed
	// because the `.example` substring lives inside the basename and we
	// special-case it below.
	if (lowerBase.startsWith("credentials")) {
		if (/^credentials\.example(\..+)?$/.test(lowerBase)) {
			return null;
		}
		return { reason: "credential files must not be edited by Claude" };
	}

	return null;
}

function main() {
	let toolCall;
	try {
		toolCall = readToolInput();
	} catch (err) {
		process.stderr.write(`block-secret-paths: ${err.message}\n`);
		process.exit(0);
	}

	if (!WRITE_TOOLS.has(toolCall.tool_name)) {
		process.exit(0);
	}
	const filePath = String(toolCall.tool_input?.file_path ?? "");
	if (!filePath) {
		process.exit(0);
	}

	const verdict = evaluate(filePath);
	if (!verdict) {
		process.exit(0);
	}

	writeBlockMessage({
		command: `${toolCall.tool_name.toLowerCase()} of '${filePath}'`,
		reason: verdict.reason,
		sourceRef: "CLAUDE.md (secret files)",
	});
	process.exit(2);
}

main();
