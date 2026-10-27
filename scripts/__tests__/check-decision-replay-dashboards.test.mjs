import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
	new URL("../check-decision-replay-dashboards.mjs", import.meta.url),
);
function runFixture(
	t,
	queries,
	{
		datasetKeys = {},
		pages = [],
		uiSettings = {
			genieSpace: { isEnabled: false, enablementMode: "DISABLED" },
		},
	} = {},
) {
	const root = mkdtempSync(join(tmpdir(), "decision-replay-guard-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "nested"));
	writeFileSync(
		join(root, "nested", "example.lvdash.json"),
		JSON.stringify({
			uiSettings,
			pages,
			datasets: queries.map((queryLines, i) => ({
				name: `example_${i}`,
				queryLines,
				...datasetKeys,
			})),
		}),
	);
	return spawnSync(process.execPath, [script, root], { encoding: "utf8" });
}

test("accepts scoped gold reads, including aggregates and newlines", (t) => {
	const result = runFixture(t, [
		[
			"SELECT final_outcome, COUNT(*) AS items FROM suggestion_journey\n",
			"WHERE project_id = __aibi_external_value GROUP BY final_outcome ORDER BY items DESC",
		],
	]);
	assert.equal(result.status, 0, result.stderr);
});

test("accepts reviewed user-facing outcomes", (t) => {
	const result = runFixture(t, [
		[
			"SELECT final_outcome, COUNT(*) AS proposals FROM suggestion_journey WHERE project_id = __aibi_external_value GROUP BY final_outcome ORDER BY proposals DESC",
		],
	]);
	assert.equal(result.status, 0, result.stderr);
});

test("rejects an unreviewed suggestion journey column", (t) => {
	const result = runFixture(t, [
		[
			"SELECT unreviewed_outcome, COUNT(*) AS proposals FROM suggestion_journey WHERE project_id = __aibi_external_value GROUP BY unreviewed_outcome ORDER BY proposals DESC",
		],
	]);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /unsupported SQL shape/);
});

for (const [name, sql] of [
	["missing predicate", "SELECT * FROM needs_review"],
	[
		"comment predicate",
		"SELECT * FROM needs_review -- WHERE project_id = __aibi_external_value",
	],
	[
		"literal predicate",
		"SELECT 'WHERE project_id = __aibi_external_value' AS note FROM needs_review",
	],
	[
		"OR bypass",
		"SELECT * FROM needs_review WHERE project_id = __aibi_external_value OR 1=1",
	],
	[
		"union bypass",
		"SELECT * FROM needs_review WHERE project_id = __aibi_external_value UNION ALL SELECT * FROM needs_review",
	],
	[
		"raw history",
		"SELECT * FROM lb_decision_event_history WHERE project_id = __aibi_external_value",
	],
	[
		"current table",
		"SELECT * FROM decision_event_current WHERE project_id = __aibi_external_value",
	],
	[
		"another table",
		"SELECT * FROM example_other WHERE project_id = __aibi_external_value",
	],
	[
		"join",
		"SELECT * FROM needs_review JOIN decision_event_current USING (project_id) WHERE project_id = __aibi_external_value",
	],
	[
		"second statement",
		"SELECT * FROM needs_review WHERE project_id = __aibi_external_value; SELECT * FROM needs_review",
	],
	[
		"qualified source",
		"SELECT * FROM example_catalog.example_schema.needs_review WHERE project_id = __aibi_external_value",
	],
	[
		"subquery bypass",
		"SELECT (SELECT COUNT(*) FROM needs_review) FROM needs_review WHERE project_id = __aibi_external_value",
	],
]) {
	test(`rejects ${name}`, (t) => {
		const result = runFixture(t, [[sql]]);
		assert.equal(result.status, 1, result.stderr);
		assert.match(result.stderr, /example_0:/);
	});
}

test("checks every dataset, not only the first", (t) => {
	const result = runFixture(t, [
		["SELECT * FROM needs_review WHERE project_id = __aibi_external_value"],
		["SELECT * FROM rating_outcomes"],
	]);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /example_1:/);
});

test("rejects asset datasets even with a scoped query", (t) => {
	const result = runFixture(
		t,
		[
			[
				"SELECT * FROM needs_review WHERE project_id = __aibi_external_value",
			],
		],
		{ datasetKeys: { asset_name: "example_asset" } },
	);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /example_0:/);
});

test("real deployment dashboards pass", () => {
	const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /Checked [1-9]/);
});

for (const [name, sql, reason] of [
	[
		"CR-terminated line comment",
		"SELECT * FROM needs_review WHERE project_id = __aibi_external_value --\r OR 1=1",
		/SQL comments/,
	],
	[
		"nested bracket comment",
		"SELECT * FROM needs_review /* /* */ WHERE project_id = __aibi_external_value ORDER BY 1 */",
		/SQL comments/,
	],
	[
		"continued line comment",
		"SELECT * FROM needs_review -- x \\\nWHERE project_id = __aibi_external_value ORDER BY 1",
		/SQL comments/,
	],
	[
		"bare carriage return",
		"SELECT * FROM needs_review\rWHERE project_id = __aibi_external_value",
		/carriage returns/,
	],
]) {
	test(`rejects ${name}`, (t) => {
		const result = runFixture(t, [[sql]]);
		assert.equal(result.status, 1, result.stderr);
		assert.match(result.stderr, reason);
	});
}

for (const key of ["catalog", "schema"]) {
	test(`rejects dataset ${key}`, (t) => {
		const result = runFixture(
			t,
			[
				[
					"SELECT * FROM needs_review WHERE project_id = __aibi_external_value",
				],
			],
			{ datasetKeys: { [key]: `other_${key}` } },
		);
		assert.equal(result.status, 1, result.stderr);
		assert.match(
			result.stderr,
			new RegExp(`unsupported dataset key: ${key}`),
		);
	});
}

for (const [name, uiSettings] of [
	[
		"enabled Genie",
		{ genieSpace: { isEnabled: true, enablementMode: "ENABLED" } },
	],
	["missing Genie setting", {}],
	["missing UI settings", null],
	[
		"inconsistent Genie mode",
		{ genieSpace: { isEnabled: false, enablementMode: "ENABLED" } },
	],
]) {
	test(`rejects ${name}`, (t) => {
		const result = runFixture(
			t,
			[
				[
					"SELECT * FROM needs_review WHERE project_id = __aibi_external_value",
				],
			],
			{ uiSettings },
		);
		assert.equal(result.status, 1, result.stderr);
		assert.match(result.stderr, /Genie must be explicitly disabled/);
	});
}

for (const [name, sql] of [
	...[
		"GROUP BY",
		"GROUP BY review_rank,",
		"ORDER BY",
		"ORDER BY review_rank,",
		"LIMIT",
		"LIMIT 1 extra",
	].map((tail) => [
		`incomplete clause ${tail}`,
		`SELECT * FROM needs_review WHERE project_id = __aibi_external_value ${tail}`,
	]),
	[
		"ungrouped aggregate",
		"SELECT final_outcome, COUNT(*) AS items FROM suggestion_journey WHERE project_id = __aibi_external_value",
	],
	[
		"quoted external placeholder",
		"SELECT * FROM needs_review WHERE project_id = `__aibi_external_value`",
	],
	[
		"non-SQL whitespace",
		"SELECT * FROM needs_review\u00a0WHERE project_id = __aibi_external_value",
	],
	[
		"ambiguous output alias",
		"SELECT applied, median_review_latency_seconds / 3600.0 AS applied FROM project_decision_daily WHERE project_id = __aibi_external_value ORDER BY applied",
	],
	[
		"empty projection",
		"SELECT FROM needs_review WHERE project_id = __aibi_external_value",
	],
	[
		"unparsed ORDER tail",
		"SELECT * FROM needs_review WHERE project_id = __aibi_external_value ORDER nonsense",
	],
	[
		"unexpected function",
		"SELECT example_function() FROM needs_review WHERE project_id = __aibi_external_value",
	],
	[
		"unbalanced projection",
		"SELECT COUNT(* FROM needs_review WHERE project_id = __aibi_external_value",
	],
]) {
	test(`rejects ${name}`, (t) => {
		const result = runFixture(t, [[sql]]);
		assert.equal(result.status, 1, result.stderr);
		assert.match(result.stderr, /unsupported SQL shape/);
	});
}

test("accepts reviewed ordering and limits", (t) => {
	const result = runFixture(t, [
		[
			"SELECT review_rank FROM needs_review WHERE project_id = __aibi_external_value ORDER BY review_rank DESC LIMIT 10;",
		],
	]);
	assert.equal(result.status, 0, result.stderr);
});

test("deployment dashboard leaves review in Fabric and names decisions over time", async () => {
	const { readFileSync } = await import("node:fs");
	const dashboard = JSON.parse(
		readFileSync(
			new URL(
				"../../deployment/databricks/decision-replay/src/decision_replay.lvdash.json",
				import.meta.url,
			),
			"utf8",
		),
	);
	assert.deepEqual(
		dashboard.pages.map((page) => page.displayName),
		["Decisions over time", "Review latency", "AI ratings", "Duplicates"],
	);
	assert.equal(
		dashboard.datasets.some((dataset) => dataset.name === "pending"),
		false,
	);
});

test("accepts reviewed change tables, journey fields and daily counters", (t) => {
	const r = runFixture(t, [
		[
			"SELECT outcome, COUNT(*) AS changes FROM change_outcomes WHERE project_id = __aibi_external_value GROUP BY outcome ORDER BY changes DESC",
		],
		[
			"SELECT SUM(change_accepted) AS accepted, SUM(change_decided) AS decided FROM project_decision_daily WHERE project_id = __aibi_external_value",
		],
		[
			"SELECT final_outcome FROM suggestion_journey WHERE project_id = __aibi_external_value",
		],
		[
			"SELECT change_accepted, change_decided FROM project_decision_daily WHERE project_id = __aibi_external_value",
		],
	]);
	assert.equal(r.status, 0, r.stderr);
});
for (const sql of [
	"SELECT outcome FROM change_outcomes",
	"SELECT outcome FROM change_outcomes WHERE project_id = __aibi_external_value OR 1=1",
	"SELECT payload FROM change_outcomes WHERE project_id = __aibi_external_value",
	"SELECT outcome AS actor_id FROM change_outcomes WHERE project_id = __aibi_external_value",
	"SELECT SUM(change_accepted) AS actor_id FROM project_decision_daily WHERE project_id = __aibi_external_value",
	"SELECT outcome FROM change_outcomes WHERE project_id = __aibi_external_value JOIN suggestion_journey ON 1=1",
]) {
	test(`rejects unsafe change query: ${sql}`, (t) =>
		assert.equal(runFixture(t, [[sql]]).status, 1));
}

for (const column of [
	"organization_id",
	"proposal_id",
	"stored_index",
	"source",
	"decided_at",
]) {
	test(`rejects unused change column ${column}`, (t) =>
		assert.equal(
			runFixture(t, [
				[
					`SELECT ${column} FROM change_outcomes WHERE project_id = __aibi_external_value`,
				],
			]).status,
			1,
		));
}
for (const column of [
	"offered",
	"selected",
	"not_selected",
	"partly_applied",
	"final_status",
]) {
	test(`rejects unused journey column ${column}`, (t) =>
		assert.equal(
			runFixture(t, [
				[
					`SELECT ${column} FROM suggestion_journey WHERE project_id = __aibi_external_value`,
				],
			]).status,
			1,
		));
}

test("accepts the reviewed readable outcome CASE", (t) =>
	assert.equal(
		runFixture(t, [
			[
				"SELECT CASE outcome WHEN 'applied' THEN 'Applied' WHEN 'notSelected' THEN 'Not selected' WHEN 'alreadyOnRoadmap' THEN 'Already on roadmap' WHEN 'failed' THEN 'Failed' WHEN 'inProgress' THEN 'In progress' WHEN 'rejected' THEN 'Rejected' WHEN 'superseded' THEN 'Superseded' WHEN 'pending' THEN 'Pending' ELSE 'Pending' END AS outcome, COUNT(*) AS changes FROM change_outcomes WHERE project_id = __aibi_external_value GROUP BY outcome ORDER BY changes DESC",
			],
		]).status,
		0,
	));

for (const sql of [
	"SELECT CASE outcome WHEN 'applied' THEN 'Unreviewed' WHEN 'notSelected' THEN 'Not selected' WHEN 'alreadyOnRoadmap' THEN 'Already on roadmap' WHEN 'failed' THEN 'Failed' WHEN 'inProgress' THEN 'In progress' WHEN 'rejected' THEN 'Rejected' WHEN 'superseded' THEN 'Superseded' WHEN 'pending' THEN 'Pending' ELSE 'Pending' END AS outcome, COUNT(*) AS changes FROM change_outcomes WHERE project_id = __aibi_external_value GROUP BY outcome",
	"SELECT * FROM change_outcomes WHERE project_id = __aibi_external_value",
	"SELECT * FROM suggestion_journey WHERE project_id = __aibi_external_value",
	"SELECT * FROM project_decision_daily WHERE project_id = __aibi_external_value",
	"SELECT change_applied FROM project_decision_daily WHERE project_id = __aibi_external_value",
	"SELECT first_human_review_at FROM suggestion_journey WHERE project_id = __aibi_external_value",
]) {
	test(`rejects unreviewed projection ${sql}`, (t) =>
		assert.equal(runFixture(t, [[sql]]).status, 1));
}

for (const fieldName of ["final_outcome", "unknown_field", "proposals"]) {
	test(`color encoding must select its field: ${fieldName}`, (t) => {
		const widget = {
			name: "example_status",
			queries: [
				{
					name: "main_query",
					query: {
						datasetName: "example_0",
						fields: [
							{
								name: "final_outcome",
								expression: "`final_outcome`",
							},
						],
					},
				},
			],
			spec: {
				encodings: {
					color: {
						fieldName,
						scale: {
							type: "categorical",
							mappings: [{ value: "Applied", color: "#258850" }],
						},
					},
				},
			},
		};
		const result = runFixture(
			t,
			[
				[
					"SELECT final_outcome, COUNT(*) AS proposals FROM suggestion_journey WHERE project_id = __aibi_external_value GROUP BY final_outcome",
				],
			],
			{ pages: [{ layout: [{ widget }] }] },
		);
		assert.equal(
			result.status,
			fieldName === "final_outcome" ? 0 : 1,
			result.stderr,
		);
		if (fieldName !== "final_outcome") {
			assert.match(
				result.stderr,
				/example_status: color field .* is not selected/,
			);
		}
	});
}

function readDashboard() {
	return JSON.parse(
		readFileSync(
			new URL(
				"../../deployment/databricks/decision-replay/src/decision_replay.lvdash.json",
				import.meta.url,
			),
			"utf8",
		),
	);
}

function widgets(dashboard) {
	return dashboard.pages.flatMap((page) =>
		page.layout.map(({ widget }) => widget),
	);
}

function readGoldSql() {
	return readFileSync(
		new URL(
			"../../deployment/databricks/decision-replay/src/02_gold.sql",
			import.meta.url,
		),
		"utf8",
	);
}

function checkMappingLabels(dashboard, goldSql, chart) {
	const sql =
		chart === "change_outcomes_breakdown"
			? dashboard.datasets
					.find(({ name }) => name === "change_statuses")
					.queryLines.join("")
			: goldSql;
	const pattern =
		chart === "change_outcomes_breakdown"
			? /\bCASE\s+outcome\b([\s\S]*?)\bEND\s+AS\s+outcome\b/i
			: /\bCASE\s+p\.final_status\b([\s\S]*?)\bEND\s+AS\s+final_outcome\b/i;
	const expression = sql.match(pattern);
	assert.ok(expression, `${chart}: outcome CASE must be found`);
	// Include the fallback: Unknown is emitted only by ELSE in final_outcome.
	const emitted = new Set(
		[...expression[1].matchAll(/\b(?:THEN|ELSE)\s+'((?:''|[^'])*)'/gi)].map(
			([, value]) => value.replaceAll("''", "'"),
		),
	);
	assert.ok(emitted.size > 0, `${chart}: CASE must emit string labels`);
	const widget = widgets(dashboard).find(({ name }) => name === chart);
	const mapped = new Set(
		widget.spec.encodings.color.scale.mappings.map(({ value }) => value),
	);
	assert.deepEqual(
		mapped,
		emitted,
		`${chart}: mapping labels must equal emitted outcomes`,
	);
}

for (const chart of ["change_outcomes_breakdown", "current_status"]) {
	test(`${chart} mapping labels equal emitted outcomes`, () => {
		checkMappingLabels(readDashboard(), readGoldSql(), chart);
	});

	test(`${chart} rejects a misspelled mapping label`, () => {
		const dashboard = readDashboard();
		const widget = widgets(dashboard).find(({ name }) => name === chart);
		const mapping = widget.spec.encodings.color.scale.mappings.find(
			({ value }) =>
				value ===
				(chart === "current_status" ? "Applied" : "Not selected"),
		);
		mapping.value = chart === "current_status" ? "applied" : "Not Selected";
		assert.throws(
			() => checkMappingLabels(dashboard, readGoldSql(), chart),
			/mapping labels must equal emitted outcomes/,
		);
	});

	test(`${chart} rejects an extra emitted outcome`, () => {
		const dashboard = readDashboard();
		let goldSql = readGoldSql();
		if (chart === "change_outcomes_breakdown") {
			const dataset = dashboard.datasets.find(
				({ name }) => name === "change_statuses",
			);
			dataset.queryLines = [
				dataset.queryLines
					.join("")
					.replace(
						/CASE\s+outcome\b/i,
						"CASE outcome WHEN 'example' THEN 'Example outcome'",
					),
			];
		} else {
			goldSql = goldSql.replace(
				/CASE\s+p\.final_status\b/i,
				"CASE p.final_status WHEN 'EXAMPLE' THEN 'Example outcome'",
			);
		}
		assert.throws(
			() => checkMappingLabels(dashboard, goldSql, chart),
			/mapping labels must equal emitted outcomes/,
		);
	});
}

function luminance(hex) {
	assert.equal(
		typeof hex,
		"string",
		"color must be a bare 6-digit hex string",
	);
	assert.match(hex, /^#[0-9a-f]{6}$/i, "color must be a 6-digit hex");
	const rgb = hex
		.slice(1)
		.match(/../g)
		.map((part) => Number.parseInt(part, 16) / 255);
	const linear = rgb.map((channel) =>
		channel <= 0.04045
			? channel / 12.92
			: ((channel + 0.055) / 1.055) ** 2.4,
	);
	return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function checkColors(dashboard) {
	const theme = dashboard.uiSettings.theme;
	for (const key of [
		"canvasBackgroundColor",
		"widgetBackgroundColor",
		"widgetBorderColor",
		"fontColor",
		"selectionColor",
	]) {
		for (const mode of ["light", "dark"]) {
			luminance(theme[key][mode]);
		}
	}
	const colors = [...theme.visualizationColors];
	for (const widget of widgets(dashboard)) {
		for (const mapping of widget.spec?.encodings?.color?.scale?.mappings ??
			[]) {
			colors.push(mapping.color);
		}
	}
	for (const color of colors) {
		const foreground = luminance(color);
		for (const mode of ["light", "dark"]) {
			const background = luminance(theme.widgetBackgroundColor[mode]);
			const ratio =
				(Math.max(foreground, background) + 0.05) /
				(Math.min(foreground, background) + 0.05);
			assert.ok(
				ratio >= 3,
				`${color} vs ${mode} widget: ${ratio.toFixed(2)}:1 is below 3:1`,
			);
		}
	}
}

test("dashboard colors are hex and chart colors contrast in both modes", () => {
	checkColors(readDashboard());
});

for (const [name, mutate, error] of [
	[
		"short theme hex",
		(d) => {
			d.uiSettings.theme.fontColor.light = "#fff";
		},
		/6-digit hex/,
	],
	[
		"object mapping color",
		(d) => {
			const widget = widgets(d).find(
				(w) => w.name === "change_outcomes_breakdown",
			);
			widget.spec.encodings.color.scale.mappings[0].color = {
				hex: "#258850",
			};
		},
		/bare 6-digit hex/,
	],
	[
		"white palette color",
		(d) => {
			d.uiSettings.theme.visualizationColors[0] = "#ffffff";
		},
		/vs light widget: 1.00:1/,
	],
	[
		"dark mapping color",
		(d) => {
			const widget = widgets(d).find(
				(w) => w.name === "change_outcomes_breakdown",
			);
			widget.spec.encodings.color.scale.mappings[0].color = "#222222";
		},
		/vs dark widget: 1.00:1/,
	],
]) {
	test(`color regression rejects ${name}`, () => {
		const dashboard = readDashboard();
		mutate(dashboard);
		assert.throws(() => checkColors(dashboard), error);
	});
}
