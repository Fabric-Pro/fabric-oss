#!/usr/bin/env node
// External embedding executes with publisher credentials. Keep every dataset
// inside the project boundary; only this deliberately small SQL shape is allowed.
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const goldTables = new Set([
	"change_outcomes",
	"suggestion_journey",
	"project_decision_daily",
	"needs_review",
	"duplicate_outcomes",
	"rating_outcomes",
]);

const datasetKeys = new Set(["name", "displayName", "queryLines"]);

// Reviewed SQL vocabulary for this dashboard. New expressions must be reviewed
// here, rather than accepting arbitrary functions or trusting token presence.
const columnsByTable = {
	change_outcomes: ["outcome"],
	suggestion_journey: ["final_outcome"],
	project_decision_daily: [
		"change_accepted",
		"change_decided",
		"decision_day",
		"proposed",
		"approved",
		"rejected",
		"applied",
		"failed",
		"superseded",
		"median_review_latency_seconds",
		"applied_cohort_count",
		"mature_applied_count",
		"share_applied_edited_within_7d",
	],
	needs_review: [
		"review_rank",
		"proposal_id",
		"proposed_at",
		"change_count",
		"proposal_url",
	],
	rating_outcomes: [
		"feature_key",
		"model",
		"prompt_version_id",
		"event_type",
		"outcome",
		"event_count",
	],
	duplicate_outcomes: [
		"feature_key",
		"model",
		"prompt_version_id",
		"outcome",
		"link_count",
	],
};
const expressionsByTable = {
	suggestion_journey: [
		"count ( * )",
		"sum ( case when first_human_review_at is not null then 1 else 0 end )",
		"sum ( case when applied_at is not null then 1 else 0 end )",
	],
	project_decision_daily: [
		"median_review_latency_seconds / 3600.0",
		"sum ( change_accepted )",
		"sum ( change_decided )",
	],
	change_outcomes: [
		"count ( * )",
		[
			"case",
			"outcome",
			"when",
			"'applied'",
			"then",
			"'Applied'",
			"when",
			"'notSelected'",
			"then",
			"'Not selected'",
			"when",
			"'alreadyOnRoadmap'",
			"then",
			"'Already on roadmap'",
			"when",
			"'failed'",
			"then",
			"'Failed'",
			"when",
			"'inProgress'",
			"then",
			"'In progress'",
			"when",
			"'rejected'",
			"then",
			"'Rejected'",
			"when",
			"'superseded'",
			"then",
			"'Superseded'",
			"when",
			"'pending'",
			"then",
			"'Pending'",
			"else",
			"'Pending'",
			"end",
		],
	],
	needs_review: [
		"( unix_timestamp ( current_timestamp ( ) ) - unix_timestamp ( proposed_at ) ) / 3600.0",
	],
};
const aliases = new Set([
	"accepted",
	"decided",
	"changes",
	"outcome",
	"items",
	"proposals",
	"reviewed",
	"applied",
	"median_review_hours",
	"age_hours",
]);

function checkShape(tokens, from) {
	const fail = () => {
		throw new Error("unsupported SQL shape");
	};
	const table = tokens[from + 1];
	const columns = new Set(columnsByTable[table]);
	const expressions = [
		...[...columns].map((column) => [column]),
		...(expressionsByTable[table] ?? []).map((expression) =>
			Array.isArray(expression) ? expression : expression.split(" "),
		),
	].sort((a, b) => b.length - a.length);
	const projected = [];
	const selectedAliases = new Set();
	const outputNames = new Set();
	let offset = 1;
	if (tokens[offset] === "*") {
		if (
			[
				"change_outcomes",
				"suggestion_journey",
				"project_decision_daily",
			].includes(table)
		) {
			fail();
		}
		offset++;
	} else {
		do {
			const expression = expressions.find((candidate) =>
				candidate.every((token, i) => tokens[offset + i] === token),
			);
			if (!expression) {
				fail();
			}
			offset += expression.length;
			projected.push(expression);
			let outputName =
				expression.length === 1 ? expression[0] : expression.join(" ");
			if (tokens[offset] === "as") {
				const alias = tokens[++offset];
				if (!aliases.has(alias) || selectedAliases.has(alias)) {
					fail();
				}
				selectedAliases.add(alias);
				outputName = alias;
				offset++;
			}
			if (outputNames.has(outputName)) {
				fail();
			}
			outputNames.add(outputName);
			if (tokens[offset] !== ",") {
				break;
			}
			offset++;
		} while (offset < from);
	}
	if (offset !== from || tokens[from - 1] === ",") {
		fail();
	}
	offset = from + 6;
	const grouped = new Set();
	if (tokens[offset] === "group") {
		if (tokens[++offset] !== "by") {
			fail();
		}
		offset++;
		do {
			if (!columns.has(tokens[offset])) {
				fail();
			}
			grouped.add(tokens[offset++]);
			if (tokens[offset] !== ",") {
				break;
			}
			offset++;
		} while (offset < tokens.length);
		if (!projected.length || tokens[offset - 1] === ",") {
			fail();
		}
	}
	const aggregate = projected.some(
		([first]) => first === "count" || first === "sum",
	);
	if (aggregate || grouped.size) {
		if (
			projected.some(
				(expression) =>
					expression[0] !== "count" &&
					expression[0] !== "sum" &&
					!(
						expression[0] === "case" &&
						expression[1] === "outcome" &&
						grouped.has("outcome")
					) &&
					(expression.length !== 1 || !grouped.has(expression[0])),
			)
		) {
			fail();
		}
	}
	if (tokens[offset] === "order") {
		if (tokens[++offset] !== "by") {
			fail();
		}
		offset++;
		do {
			const field = tokens[offset++];
			const ordinal =
				/^[1-9][0-9]*$/.test(field ?? "") &&
				Number(field) <= (projected.length || columns.size);
			if (
				!ordinal &&
				!selectedAliases.has(field) &&
				!(aggregate || grouped.size ? grouped : columns).has(field)
			) {
				fail();
			}
			if (["asc", "desc"].includes(tokens[offset])) {
				offset++;
			}
			if (tokens[offset] !== ",") {
				break;
			}
			offset++;
		} while (offset < tokens.length);
		if (tokens[offset - 1] === ",") {
			fail();
		}
	}
	if (tokens[offset] === "limit") {
		if (!/^[0-9]+$/.test(tokens[++offset] ?? "")) {
			fail();
		}
		offset++;
	}
	if (offset !== tokens.length) {
		fail();
	}
}

function checkQuery(dataset) {
	if (
		dataset.asset_name ||
		!Array.isArray(dataset.queryLines) ||
		!dataset.queryLines.length ||
		!dataset.queryLines.every((line) => typeof line === "string")
	) {
		throw new Error("a scoped queryLines SQL dataset is required");
	}
	for (const key of Object.keys(dataset)) {
		if (!datasetKeys.has(key)) {
			throw new Error(`unsupported dataset key: ${key}`);
		}
	}
	// Reject comments outright: this guard does not emulate Databricks comment
	// lexing. Tokenize strings only after rejecting comments and carriage returns.
	const sql = dataset.queryLines.join("");
	if (sql.includes("--") || sql.includes("/*")) {
		throw new Error("SQL comments are forbidden");
	}
	if (sql.includes("\r")) {
		throw new Error("SQL carriage returns are forbidden");
	}
	if (sql.includes("`")) {
		throw new Error("unsupported SQL shape: quoted identifiers");
	}
	const tokens = [];
	const lexer =
		/[ \t\n]+|'(?:''|[^'\\])*'|[a-zA-Z_][a-zA-Z_0-9]*|\d+(?:\.\d+)?|[(),.*=<>+\-/;]/gy;
	let offset = 0;
	while (offset < sql.length) {
		lexer.lastIndex = offset;
		const match = lexer.exec(sql);
		if (!match) {
			throw new Error("unsupported SQL shape: syntax");
		}
		offset = lexer.lastIndex;
		const token = match[0];
		if (/^[ \t\n]/.test(token)) {
			continue;
		}
		tokens.push(token.startsWith("'") ? token : token.toLowerCase());
	}
	if (tokens.at(-1) === ";") {
		tokens.pop();
	}
	const from = tokens.indexOf("from");
	if (
		tokens[0] !== "select" ||
		tokens.filter((token) => token === "select").length !== 1 ||
		tokens.filter((token) => token === "from").length !== 1 ||
		!goldTables.has(tokens[from + 1])
	) {
		throw new Error("SELECT must read exactly one bare gold table");
	}
	const predicate = tokens.slice(from + 2, from + 6).join(" ");
	if (predicate !== "where project_id = __aibi_external_value") {
		throw new Error(
			"required WHERE project_id = __aibi_external_value predicate is missing",
		);
	}
	const tail = tokens.slice(from + 6);
	if (tail.length && !["group", "order", "limit"].includes(tail[0])) {
		throw new Error(
			"only GROUP BY / ORDER BY / LIMIT may follow the project predicate",
		);
	}
	if (
		tokens.some((token) =>
			["or", "union", "intersect", "except", "join", ";"].includes(token),
		) ||
		tokens.filter((token) => token === "where").length !== 1
	) {
		throw new Error(
			"joins, set operations, extra predicates and statements are forbidden",
		);
	}
	checkShape(tokens, from);
}

function dashboards(root) {
	return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
		const path = join(root, entry.name);
		if (entry.isDirectory()) {
			return dashboards(path);
		}
		return entry.isFile() && path.endsWith(".lvdash.json") ? [path] : [];
	});
}

try {
	const root = resolve(
		process.argv[2] ??
			fileURLToPath(
				new URL("../deployment/databricks/", import.meta.url),
			),
	);
	const files = dashboards(root);
	if (!files.length) {
		throw new Error(`No dashboards found under ${root}`);
	}
	const errors = [];
	for (const path of files) {
		const dashboard = JSON.parse(readFileSync(path, "utf8"));
		if (
			dashboard.uiSettings?.genieSpace?.isEnabled !== false ||
			dashboard.uiSettings?.genieSpace?.enablementMode !== "DISABLED"
		) {
			errors.push(`${path}: Genie must be explicitly disabled`);
		}
		if (!Array.isArray(dashboard.datasets) || !dashboard.datasets.length) {
			errors.push(`${path}: at least one dataset is required`);
			continue;
		}
		for (const dataset of dashboard.datasets) {
			try {
				checkQuery(dataset);
			} catch (error) {
				errors.push(
					`${path}: ${dataset?.name ?? "unnamed"}: ${error.message}`,
				);
			}
		}
		for (const page of dashboard.pages ?? []) {
			for (const { widget } of page.layout ?? []) {
				const color = widget.spec?.encodings?.color;
				if (!color) {
					continue;
				}
				const selected = widget.queries?.some(({ query }) =>
					query.fields?.some(({ name }) => name === color.fieldName),
				);
				if (typeof color.fieldName !== "string" || !selected) {
					errors.push(
						`${path}: ${widget.name}: color field ${color.fieldName} is not selected by the widget query`,
					);
				}
			}
		}
	}
	if (errors.length) {
		throw new Error(errors.join("\n"));
	}
	console.log(
		`Checked ${files.length} dashboard(s): scoped gold queries only.`,
	);
} catch (error) {
	console.error(error.message);
	process.exitCode = 1;
}
