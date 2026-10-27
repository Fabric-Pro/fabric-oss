import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";

const changeFixture = JSON.parse(
	readFileSync(
		new URL("./fixtures/decision-replay-changes.json", import.meta.url),
		"utf8",
	),
);
const readableOutcomeQuery = JSON.parse(
	readFileSync(
		new URL(
			"../../deployment/databricks/decision-replay/src/decision_replay.lvdash.json",
			import.meta.url,
		),
		"utf8",
	),
)
	.datasets.find((dataset) => dataset.name === "change_statuses")
	.queryLines.join("");
const notebooks = ["01_current.sql", "02_gold.sql"].map((name) =>
	readFileSync(
		new URL(
			`../../deployment/databricks/decision-replay/src/${name}`,
			import.meta.url,
		),
		"utf8",
	),
);
const tables = [
	"decision_event_current",
	"change_outcomes",
	"suggestion_journey",
	"project_decision_daily",
	"needs_review",
	"duplicate_outcomes",
	"rating_outcomes",
];
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const organization = uuid(9000);
const project = uuid(1);
const labelsProject = uuid(2);
const edgeProject = uuid(3);
const applyOp = `backlog-apply-op-${"a".repeat(64)}`;
const literal = (value) =>
	value == null ? "NULL" : `'${String(value).replaceAll("'", "''")}'`;

// Tokenize comments and strings together so comment markers inside literals stay literal.
function codeOnly(sql, hideStrings = false) {
	return sql.replace(/'(?:''|[^'])*'|--[^\n]*|\/\*[\s\S]*?\*\//g, (token) =>
		token.startsWith("'") ? (hideStrings ? "''" : token) : " ",
	);
}

// Reviewed function vocabulary: additions require checking the semantics used here.
const functions = {
	sequence:
		"Reviewed explode(sequence(0, count-1)) creates integer indexes; count > 0 excludes descending empty-list expansion.",
	explode:
		"LATERAL VIEW is translated only for the reviewed integer-index expansion.",
	identifier: "Skipped session setup; no dynamic identifiers reach DuckDB.",
	row_number:
		"Both rank partition rows starting at one with explicit ordering.",
	min: "Both ignore NULL and return the least non-NULL value.",
	max: "Both ignore NULL and return the greatest non-NULL value.",
	count: "Both support DISTINCT, exclude NULL expressions, and count rows for *.",
	sum: "Both sum numeric CASE values and ignore NULL.",
	cast: "Both cast naive UTC timestamps to dates and sanitized scalar text to integer or boolean.",
	try_cast: "Both return NULL for invalid BIGINT or BOOLEAN scalar text.",
	coalesce: "Both choose the first non-NULL argument.",
	concat: "Both concatenate the non-NULL strings used in proposal URLs.",
	trim: "ANSI TRAILING characters FROM string has matching semantics; two-argument form is rejected.",
	get_json_object:
		"Macro supplies scalar JSON strings or NULL for the capture payload paths.",
	timestampadd: "Macro supplies whole DAY additions to naive UTC timestamps.",
	timestampdiff:
		"Macro truncates elapsed microseconds to whole seconds, matching SECOND differences.",
	percentile_approx:
		"Macro uses discrete quantile; odd-count fixtures have an unambiguous middle value.",
	current_timestamp:
		"Translation supplies a fixed naive UTC refresh timestamp.",
};
function checkFunctions(sql) {
	const visibleCode = codeOnly(sql, true);
	assert.doesNotMatch(
		visibleCode,
		/[`"]/,
		"Quoted SQL identifiers/strings require an explicit scanner review",
	);
	const code = visibleCode;
	assert.doesNotMatch(
		code,
		/\b(?:current_timestamp|current_date|current_time|localtimestamp|localtime|now|today|transaction_timestamp|statement_timestamp|clock_timestamp|sysdate|systimestamp)\b(?!\s*\()/i,
		"Niladic datetime function requires deterministic translation",
	);
	for (const match of code.matchAll(/\b([a-z_][a-z_0-9]*)\s*\(/gi)) {
		const name = match[1].toLowerCase();
		// These parenthesized SQL grammar forms are not function calls.
		if (
			["as", "over", "in", "and", "or", "not", "when", "from"].includes(
				name,
			)
		) {
			continue;
		}
		if (
			["rtrim", "ltrim"].includes(name) ||
			(name === "trim" &&
				!/^\s*(?:trailing|leading|both)\b/i.test(
					code.slice(match.index + match[0].length),
				))
		) {
			throw new Error(
				`${name}: Databricks/DuckDB two-argument trim argument-order difference; use ANSI trim(TRAILING '/' FROM value)`,
			);
		}
		assert.ok(
			Object.hasOwn(functions, name),
			`${name}: review DuckDB/Databricks parity before adding it to the function allowlist`,
		);
	}
}

// The only dialect adaptation point. Accept known notebook statement kinds and
// fail on other setup/DDL or unbound parameters instead of silently skipping them.
function translate(statement) {
	let sql = codeOnly(statement).trim();
	if (
		!sql ||
		/^USE (?:CATALOG|SCHEMA) IDENTIFIER\(:(?:catalog|schema)\);$/i.test(
			sql,
		) ||
		/^SET TIME ZONE 'UTC';$/i.test(sql)
	) {
		return null;
	}
	const create = sql.match(
		/^CREATE OR REPLACE TABLE (\w+) USING DELTA AS\s/i,
	);
	assert.ok(
		create && tables.includes(create[1]),
		`Unrecognised notebook statement: ${sql}`,
	);
	assert.equal(
		(codeOnly(sql, true).match(/;/g) ?? []).length,
		1,
		"Expected one CREATE statement per notebook cell",
	);
	sql = sql
		.replace(/\bUSING DELTA\b/i, "")
		.replace(
			"LATERAL VIEW explode(sequence(0, CAST(s.change_count-1 AS INT))) expanded AS idx",
			"CROSS JOIN LATERAL range(0, s.change_count) expanded(idx)",
		)
		.replaceAll(":fabric_base_url", "'https://fabric.example.com/'")
		.replace(
			/\bcurrent_timestamp\s*\(\s*\)/gi,
			"TIMESTAMP '2026-02-01 00:00:00'",
		)
		.replace(/\btimestampadd\(DAY,/gi, "timestampadd('DAY',")
		.replace(/\btimestampdiff\(SECOND,/gi, "timestampdiff('SECOND',");
	assert.doesNotMatch(
		codeOnly(sql, true),
		/:\w+/,
		"Unbound Databricks parameter",
	);
	return sql;
}

async function fixtures(connection, includeChanges) {
	await connection.run(`CREATE TABLE lb_decision_event_history (
		id VARCHAR, occurred_at TIMESTAMP, organization_id VARCHAR, project_id VARCHAR,
		subject_type VARCHAR, subject_id VARCHAR, event_type VARCHAR, from_state VARCHAR,
		to_state VARCHAR, actor_kind VARCHAR, actor_id VARCHAR, related_subject_id VARCHAR,
		feature_key VARCHAR, model VARCHAR, prompt_version_id VARCHAR, payload VARCHAR,
		schema_version INTEGER, _sort_by BIGINT, _pg_lsn BIGINT, _pg_change_type VARCHAR)`);
	const rows = [];
	let sequence = 1000;
	const add = (subject, event, at, extra = {}) => {
		const row = {
			id: uuid(sequence++),
			occurred_at: at,
			organization_id: organization,
			project_id: project,
			subject_type: "backlog_proposal",
			subject_id: uuid(subject),
			event_type: event,
			from_state: null,
			to_state: null,
			actor_kind: "system",
			actor_id: null,
			related_subject_id: null,
			feature_key: null,
			model: null,
			prompt_version_id: null,
			payload: null,
			schema_version: 1,
			_sort_by: 1,
			_pg_lsn: 1,
			_pg_change_type: "insert",
			...extra,
		};
		if (row.actor_kind === "human" && row.event_type !== "story_edited") {
			row.actor_id = uuid(900);
		}
		rows.push(row);
		return row;
	};
	// Capture writer references for the fixture state/actor/payload shapes:
	// packages/database/prisma/migrations/20261024120000_decision_replay_capture/migration.sql:316 (proposals)
	// packages/database/prisma/migrations/20261024120000_decision_replay_capture/migration.sql:347 (applications)
	// packages/database/prisma/migrations/20261024120000_decision_replay_capture/migration.sql:449 (story edits)
	// packages/database/prisma/migrations/20261024120000_decision_replay_capture/migration.sql:421 (duplicates)
	// packages/database/prisma/migrations/20261024120000_decision_replay_capture/migration.sql:383 (ratings)
	// packages/database/prisma/migrations/20261025090000_decision_replay_apply_op_ids/migration.sql:10 (UUID orgs), :20 (apply-op subject/related ids)
	// reviewedAt writers: pending-backlog-proposals.ts:320,602,634,773;
	// backlog/apply-changes.ts:780, retry-failed-proposal.ts:276,
	// retry-all-failed-proposals.ts:322. These enter APPROVED/REJECTED/BACKLOG/APPLYING.
	// No inspected APPLIED writer changes reviewedAt, so its events are system;
	// APPLIED remains in SQL's approved list defensively, without a human fixture.
	const proposed = (id, extra = {}) =>
		add(id, "proposed", "2026-01-01 00:00:00", {
			to_state: "PENDING",
			payload: JSON.stringify({
				source: "AI_UPDATE_SIDEBAR",
				changeCount: 2,
				errorClass: null,
			}),
			...extra,
		});
	const transition = (
		id,
		from,
		to,
		actor = "human",
		at = "2026-01-01 01:00:00",
		extra = {},
	) =>
		add(id, "status_changed", at, {
			from_state: from,
			to_state: to,
			actor_kind: actor,
			payload: JSON.stringify({
				source: "AI_UPDATE_SIDEBAR",
				changeCount: 2,
				errorClass: to === "FAILED" ? "TimedOut" : null,
			}),
			...extra,
		});
	for (let id = 10; id <= 17; id++) {
		proposed(id);
	}
	// Inbox apply claims APPLYING, then system completion; explicit APPROVED is
	// covered separately below. Re-entry on proposal 14 must count once/day.
	transition(10, "PENDING", "APPLYING");
	transition(10, "APPLYING", "APPLIED", "system", "2026-01-01 02:00:00");
	transition(11, "PENDING", "FAILED", "system");
	transition(11, "FAILED", "APPLYING", "human", "2026-01-02 01:00:00");
	transition(11, "APPLYING", "APPLIED", "system", "2026-01-02 02:00:00");
	transition(12, "PENDING", "BACKLOG", "human", "2026-01-01 02:00:00");
	transition(13, "PENDING", "BACKLOG", "human", "2026-01-01 03:00:00");
	transition(13, "BACKLOG", "PENDING", "human", "2026-01-02 03:00:00");
	transition(14, "PENDING", "APPLYING");
	transition(14, "APPLYING", "FAILED", "system", "2026-01-01 02:00:00");
	transition(14, "FAILED", "APPLYING", "human", "2026-01-01 03:00:00");
	transition(14, "APPLYING", "APPLIED", "system", "2026-01-01 04:00:00");
	transition(15, "PENDING", "APPLIED", "system", "2026-01-01 05:00:00");
	transition(16, "PENDING", "SUPERSEDED", "system");
	transition(17, "PENDING", "APPROVED", "human", "2026-01-01 04:00:00");
	transition(17, "APPROVED", "APPLIED", "system", "2026-01-01 06:00:00");
	const application = {
		subject_type: "backlog_proposal_application",
		related_subject_id: uuid(10),
		payload: JSON.stringify({
			changeIndex: 0,
			action: "create",
			createdEntityType: "story",
			createdEntityId: uuid(50),
		}),
	};
	add(51, "change_applied", "2026-01-01 01:30:00", application);
	add(52, "change_applied", "2026-01-01 01:31:00", {
		...application,
		payload: JSON.stringify({
			changeIndex: 1,
			action: "update",
			createdEntityType: "story",
			createdEntityId: uuid(50),
		}),
	});
	add(50, "story_edited", "2026-01-03 00:00:00", {
		subject_type: "story",
		related_subject_id: uuid(10),
		actor_kind: "human",
	});
	// Each edge uses a separate story so DISTINCT cannot hide predicate removal.
	const createEntity = (index, entityId, type = "story") =>
		add(200 + index, "change_applied", "2026-01-01 01:30:00", {
			...application,
			payload: JSON.stringify({
				changeIndex: index,
				action: "create",
				createdEntityType: type,
				createdEntityId: uuid(entityId),
			}),
		});
	createEntity(2, 53);
	createEntity(3, 54);
	createEntity(4, 55);
	createEntity(6, 57);
	// Entity ids are unique per source table, not across epic/story tables. An
	// epic application must not link to a different story with that same id.
	createEntity(5, 56, "epic");
	add(54, "story_edited", "2026-01-01 01:45:00", {
		subject_type: "story",
		related_subject_id: uuid(10),
	});
	// A concurrent edit may precede the delayed application-record insert.
	add(55, "story_edited", "2026-01-01 01:20:00", {
		subject_type: "story",
		related_subject_id: uuid(10),
	});
	add(56, "story_edited", "2026-01-03 00:00:00", {
		subject_type: "story",
		related_subject_id: uuid(10),
	});
	add(53, "story_edited", "2026-01-08 02:00:00", {
		subject_type: "story",
		related_subject_id: uuid(10),
	});

	// This story has one edit exactly at APPLIED, isolating the inclusive start.
	add(57, "story_edited", "2026-01-01 02:00:00", {
		subject_type: "story",
		related_subject_id: uuid(10),
	});

	// packages/database/prisma/migrations/20261025090000_decision_replay_apply_op_ids/migration.sql:20
	// Invalid subject ids become NULL; the migration header preserves earlier NULLs.
	proposed(190, { subject_id: null });
	add(191, "duplicate_detected", "2026-01-01 00:00:00", {
		subject_type: "story_duplicate_link",
		subject_id: null,
		to_state: "PENDING",
		actor_kind: "ai",
		payload: '{"similarity":0.9,"confidence":0.9,"linkType":"DUPLICATE"}',
	});

	// NULL is a defensive export case for Unknown, rather than a live inbox state.
	const statuses = [
		"PENDING",
		"APPROVED",
		"APPLYING",
		"APPLIED",
		"REJECTED",
		"BACKLOG",
		"FAILED",
		"SUPERSEDED",
		null,
	];
	for (const [index, state] of statuses.entries()) {
		proposed(100 + index, { project_id: labelsProject });
		if (state !== "PENDING") {
			transition(
				100 + index,
				"PENDING",
				state,
				"system",
				"2026-01-01 01:00:00",
				{ project_id: labelsProject },
			);
		}
	}
	proposed(120, { project_id: labelsProject, payload: '{"changeCount":5}' });
	proposed(121, { project_id: labelsProject, payload: '{"changeCount":5}' });

	proposed(122, {
		project_id: labelsProject,
		occurred_at: "2026-01-02 00:00:00",
		payload: '{"changeCount":9}',
	});
	// Capture enabled after proposal creation: no proposed event, so age is NULL.
	transition(123, "BACKLOG", "PENDING", "system", "2026-01-02 00:00:00", {
		project_id: labelsProject,
		payload: '{"changeCount":null}',
	});

	// DESC NULLS LAST matches Spark default, so removing it is redundant;
	// the committed NULLS FIRST mutation distinguishes this same-time NULL count.
	proposed(124, {
		project_id: labelsProject,
		payload:
			'{"source":"AI_UPDATE_SIDEBAR","changeCount":null,"errorClass":null}',
	});
	// clock_timestamp() (capture migration :13) is wall time, not monotonic:
	// a clock correction can put a review before its proposal in event time.
	proposed(180, {
		project_id: edgeProject,
		occurred_at: "2026-01-05 00:00:00",
	});
	transition(180, "PENDING", "APPROVED", "human", "2026-01-04 23:59:59", {
		project_id: edgeProject,
	});
	// Microsecond event-time ties use the larger event UUID, independent of input order.
	for (const id of [181, 183, 184, 185, 186]) {
		proposed(id, {
			project_id: edgeProject,
			occurred_at: "2026-01-10 00:00:00",
		});
		transition(id, "PENDING", "APPLYING", "human", "2026-01-11 00:00:00", {
			project_id: edgeProject,
		});
		transition(id, "APPLYING", "APPLIED", "system", "2026-01-11 00:00:00", {
			project_id: edgeProject,
		});
	}
	proposed(182, { project_id: edgeProject, subject_id: applyOp });
	transition(182, "PENDING", "APPLYING", "human", "2026-01-01 01:00:00", {
		project_id: edgeProject,
		subject_id: applyOp,
	});
	transition(182, "APPLYING", "APPLIED", "system", "2026-01-01 02:00:00", {
		project_id: edgeProject,
		subject_id: applyOp,
	});

	add(60, "duplicate_detected", "2026-01-01 00:00:00", {
		subject_type: "story_duplicate_link",
		to_state: "PENDING",
		actor_kind: "ai",
		payload: '{"similarity":0.9,"confidence":0.9,"linkType":"DUPLICATE"}',
	});
	add(60, "duplicate_dismissed", "2026-01-02 00:00:00", {
		subject_type: "story_duplicate_link",
		from_state: "PENDING",
		to_state: "DISMISSED",
		actor_kind: "human",
	});
	const rating = {
		subject_type: "story",
		actor_kind: "human",
		feature_key: "maturation",
		model: "example-model",
		prompt_version_id: uuid(800),
	};
	add(50, "rated", "2026-01-01 00:00:00", {
		...rating,
		to_state: "RATED_UP",
	});
	add(50, "re_rated", "2026-01-02 00:00:00", {
		...rating,
		from_state: "RATED_UP",
		to_state: "RATED_DOWN",
	});
	add(50, "rating_cleared", "2026-01-03 00:00:00", {
		...rating,
		from_state: "RATED_DOWN",
	});
	add(50, "rated", "2026-01-01 00:00:00", {
		...rating,
		project_id: null,
		to_state: "RATED_UP",
	});
	const purged = add(70, "story_edited", "2026-01-01 00:00:00", {
		subject_type: "story",
		related_subject_id: uuid(99),
	});
	// Defensive CDF position tie: delete must beat the insert at the same position.
	rows.push({ ...purged, _pg_change_type: "delete" });
	const redacted = add(71, "rated", "2026-01-01 00:00:00", {
		subject_type: "story",
		project_id: null,
		to_state: "RATED_UP",
		actor_kind: "human",
		actor_id: uuid(900),
	});
	rows.push({
		...redacted,
		actor_id: null,
		_pg_lsn: 2,
		_pg_change_type: "update_postimage",
	});
	rows.push({
		...redacted,
		_pg_lsn: 2,
		_pg_change_type: "update_preimage",
	});
	// With paired pre/postimages at one CDF position, postimage's rank (2 > 1)
	// makes the preimage filter independently redundant. No orphan preimage is fabricated.
	// LSN removal is also redundant for these real erasure writers: inserts are
	// superseded by NULL-actor postimages or deletes via change-type priority;
	// repeated postimages can only redact the same actor to NULL (:494-498).
	// Distinct non-NULL-actor postimages would violate reject_event_mutation (:476).
	// createdEntityId IS NOT NULL is redundant with e.subject_id = s.story_id:
	// NULL cannot satisfy that inner join, even if the filter is removed.
	// NULL project proposal/duplicate events are rejected by resolve_event_org
	// (capture migration :149-153); project deletion purges them (:495-496).
	// Their gold project_id filters are defense in depth, without impossible fixtures.
	for (const fixture of includeChanges ? changeFixture.cases : []) {
		for (const e of fixture.events) {
			rows.push({
				id: e.id,
				occurred_at: e.occurred_at,
				organization_id: changeFixture.organizationId,
				project_id: fixture.projectId,
				subject_type: e.subject_type,
				subject_id: e.subject_id,
				event_type: e.event_type,
				from_state: null,
				to_state: e.to_state,
				actor_kind: e.actor_kind,
				actor_id: null,
				related_subject_id: e.related_subject_id,
				feature_key: null,
				model: null,
				prompt_version_id: null,
				payload: JSON.stringify(e.payload),
				schema_version: 1,
				_sort_by: 1,
				_pg_lsn: 1,
				_pg_change_type: "insert",
			});
		}
	}
	await connection.run(
		`INSERT INTO lb_decision_event_history VALUES ${rows.map((row) => `(${Object.values(row).map(literal).join(",")})`).join(",")}`,
	);
	return { purged, redacted };
}

async function withGold(
	sqls,
	check,
	includeChanges = false,
	beforeGold = null,
) {
	assert.ok(
		sqls[1]
			.split(/^-- COMMAND ----------\s*$/m)
			.some((cell) =>
				/^SET TIME ZONE 'UTC';$/i.test(codeOnly(cell).trim()),
			),
		"Gold notebook must declare SET TIME ZONE 'UTC' for naive UTC fixtures",
	);
	for (const sql of sqls) {
		checkFunctions(sql);
	}
	const instance = await DuckDBInstance.create(":memory:");
	const connection = await instance.connect();
	try {
		// Reproduce Spark's default NULL placement for ASC and DESC ordering.
		await connection.run(
			"SET default_null_order = 'nulls_first_on_asc_last_on_desc'",
		);
		// Databricks get_json_object returns scalar text or NULL for missing/invalid JSON.
		await connection.run(
			"CREATE MACRO get_json_object(j, path) AS TRY(json_extract_string(j, path))",
		);
		// Databricks timestampadd(DAY, n, ts) adds calendar days to this naive UTC timestamp.
		await connection.run(
			"CREATE MACRO timestampadd(unit, n, ts) AS CASE WHEN unit = 'DAY' THEN ts + n * INTERVAL 1 DAY ELSE error('Unsupported timestampadd unit') END",
		);
		// Databricks timestampdiff(SECOND, a, b) truncates elapsed time to whole seconds.
		await connection.run(
			"CREATE MACRO timestampdiff(unit, a, b) AS CASE WHEN unit = 'SECOND' THEN date_diff('microsecond', a, b) // 1000000 ELSE error('Unsupported timestampdiff unit') END",
		);
		// Databricks percentile_approx selects an approximate quantile; odd fixtures pin its middle value.
		await connection.run(
			"CREATE MACRO percentile_approx(x, p) AS quantile_disc(x, p)",
		);
		const ids = await fixtures(connection, includeChanges);
		await beforeGold?.(connection);
		const executed = [];
		for (const notebook of sqls) {
			for (const cell of notebook.split(/^-- COMMAND ----------\s*$/m)) {
				const sql = translate(cell);
				if (sql) {
					await connection.run(sql);
					executed.push(
						sql.match(/^CREATE OR REPLACE TABLE (\w+)/i)[1],
					);
				}
			}
		}
		assert.deepEqual(
			executed,
			tables,
			"Execute the current table and six gold tables in notebook order",
		);
		const query = async (sql) =>
			(await connection.runAndReadAll(sql)).getRowObjectsJson();
		await check(query, ids);
	} finally {
		connection.closeSync();
		instance.closeSync();
	}
}

async function checkApproved(query) {
	const rows = await query(
		`SELECT approved FROM project_decision_daily WHERE project_id = '${project}' ORDER BY decision_day`,
	);
	assert.deepEqual(
		rows,
		[{ approved: "3" }, { approved: "1" }],
		"approved counts human APPROVED/APPLYING acceptance and deduplicates same-day re-entry",
	);
}
async function checkBacklog(query) {
	assert.deepEqual(
		await query(
			`SELECT final_outcome FROM suggestion_journey WHERE proposal_id = '${uuid(12)}'`,
		),
		[{ final_outcome: "Rejected" }],
		"BACKLOG final_outcome is Rejected",
	);
}

async function checkGold(query, { purged, redacted }) {
	assert.deepEqual(
		await query(
			"SELECT proposal_id FROM suggestion_journey WHERE proposal_id IS NULL",
		),
		[],
		"NULL-subject proposals must not enter suggestion_journey",
	);
	assert.deepEqual(
		await query(
			"SELECT proposal_id FROM needs_review WHERE proposal_id IS NULL",
		),
		[],
		"NULL-subject proposals must not enter needs_review",
	);
	await checkApproved(query);
	await checkBacklog(query);
	assert.deepEqual(
		await query(
			`SELECT final_status, final_outcome, changes_applied_count, created_entity_count, ai_stories_edited_count, ai_stories_edited_within_7d_count, review_latency_seconds, CAST(first_edit_at AS VARCHAR) AS first_edit_at FROM suggestion_journey WHERE proposal_id = '${uuid(10)}'`,
		),
		[
			{
				final_status: "APPLIED",
				final_outcome: "Applied",
				changes_applied_count: "7",
				created_entity_count: "6",
				ai_stories_edited_count: "4",
				ai_stories_edited_within_7d_count: "3",
				review_latency_seconds: "3600",
				first_edit_at: "2026-01-01 01:45:00",
			},
		],
		"application edit metrics include both time-window boundaries",
	);
	assert.deepEqual(
		await query(
			`SELECT CAST(decision_day AS VARCHAR) AS decision_day, proposed, approved, rejected, applied, failed, superseded, median_review_latency_seconds, applied_cohort_count, mature_applied_count, mature_edited_within_7d_count, share_applied_edited_within_7d FROM project_decision_daily WHERE project_id = '${project}' ORDER BY decision_day`,
		),
		[
			{
				decision_day: "2026-01-01",
				proposed: "8",
				approved: "3",
				rejected: "2",
				applied: "4",
				failed: "2",
				superseded: "1",
				median_review_latency_seconds: "7200",
				applied_cohort_count: "4",
				mature_applied_count: "4",
				mature_edited_within_7d_count: "1",
				share_applied_edited_within_7d: 1 / 4,
			},
			{
				decision_day: "2026-01-02",
				proposed: "0",
				approved: "1",
				rejected: "0",
				applied: "1",
				failed: "0",
				superseded: "0",
				median_review_latency_seconds: "90000",
				applied_cohort_count: "1",
				mature_applied_count: "1",
				mature_edited_within_7d_count: "0",
				share_applied_edited_within_7d: 0,
			},
		],
	);
	assert.deepEqual(
		await query(
			`SELECT proposal_id, final_status, final_outcome FROM suggestion_journey WHERE proposal_id IN ('${uuid(11)}', '${uuid(13)}', '${uuid(16)}') ORDER BY proposal_id`,
		),
		[
			{
				proposal_id: uuid(11),
				final_status: "APPLIED",
				final_outcome: "Applied",
			},
			{
				proposal_id: uuid(13),
				final_status: "PENDING",
				final_outcome: "Pending",
			},
			{
				proposal_id: uuid(16),
				final_status: "SUPERSEDED",
				final_outcome: "Superseded",
			},
		],
	);
	assert.deepEqual(
		await query(
			`SELECT final_outcome FROM suggestion_journey WHERE project_id = '${labelsProject}' AND proposal_id < '${uuid(120)}' ORDER BY proposal_id`,
		),
		[
			"Pending",
			"Approved",
			"Applying",
			"Applied",
			"Rejected",
			"Rejected",
			"Failed",
			"Superseded",
			"Unknown",
		].map((final_outcome) => ({ final_outcome })),
	);
	await checkQueue(query);
	assert.deepEqual(
		await query(
			`SELECT id, actor_id, schema_version FROM decision_event_current WHERE id IN ('${purged.id}', '${redacted.id}') ORDER BY id`,
		),
		[{ id: redacted.id, actor_id: null, schema_version: 1 }],
	);
	assert.deepEqual(
		await query("SELECT * FROM duplicate_outcomes"),
		[
			{
				organization_id: organization,
				project_id: project,
				feature_key: null,
				model: null,
				prompt_version_id: null,
				outcome: "DISMISSED",
				link_count: "1",
			},
		],
		"duplicate outcomes exclude NULL subjects",
	);
	assert.deepEqual(
		await query("SELECT * FROM rating_outcomes ORDER BY event_type"),
		[
			["rated", "RATED_UP"],
			["rating_cleared", "CLEARED"],
			["re_rated", "RATED_DOWN"],
		].map(([event_type, outcome]) => ({
			organization_id: organization,
			project_id: project,
			feature_key: "maturation",
			model: "example-model",
			prompt_version_id: uuid(800),
			event_type,
			outcome,
			event_count: "1",
		})),
	);
	assert.deepEqual(
		await query(
			`SELECT proposal_id, final_status, review_latency_seconds FROM suggestion_journey WHERE project_id = '${edgeProject}' ORDER BY proposal_id`,
		),
		[
			{
				proposal_id: uuid(180),
				final_status: "PENDING",
				review_latency_seconds: null,
			},
			...[181, 183, 184, 185, 186].map((id) => ({
				proposal_id: uuid(id),
				final_status: "APPLIED",
				review_latency_seconds: "86400",
			})),
			{
				proposal_id: applyOp,
				final_status: "APPLIED",
				review_latency_seconds: "3600",
			},
		],
	);
	assert.deepEqual(
		await query(
			`SELECT CAST(decision_day AS VARCHAR) AS decision_day, rejected FROM project_decision_daily WHERE project_id = '${labelsProject}' ORDER BY decision_day`,
		),
		[
			{ decision_day: "2026-01-01", rejected: "2" },
			{ decision_day: "2026-01-02", rejected: "0" },
		],
	);
}

async function checkQueue(query) {
	assert.deepEqual(
		await query(
			"SELECT proposal_id, change_count, age_seconds, review_rank, proposal_url FROM needs_review ORDER BY project_id, review_rank",
		),
		[
			[13, project, "2", "2678400", "1"],
			[120, labelsProject, "5", "2678400", "1"],
			[121, labelsProject, "5", "2678400", "2"],
			[100, labelsProject, "2", "2678400", "3"],
			[124, labelsProject, null, "2678400", "4"],
			[122, labelsProject, "9", "2592000", "5"],
			[123, labelsProject, null, null, "6"],
			[180, edgeProject, "2", "2332800", "1"],
		].map(([id, projectId, change_count, age_seconds, review_rank]) => ({
			proposal_id: uuid(id),
			change_count,
			age_seconds,
			review_rank,
			proposal_url: `https://fabric.example.com/app/projects/${projectId}?tab=stories&proposal=${uuid(id)}`,
		})),
		"needs_review ordering and exact URLs",
	);
}

test("committed current and gold SQL reproduces captured lifecycle metrics", async () => {
	await withGold(notebooks, checkGold);
});

function mutate(from, to) {
	const changed = notebooks[1].replace(from, to);
	assert.notEqual(
		changed,
		notebooks[1],
		"Mutation must change the committed SQL",
	);
	return [notebooks[0], changed];
}
test("mutation: APPROVED-only acceptance fails the approved assertion", async () => {
	const bad = mutate(
		"to_state IN ('APPROVED', 'APPLYING', 'APPLIED')",
		"to_state = 'APPROVED'",
	);
	await assert.rejects(withGold(bad, checkApproved), {
		code: "ERR_ASSERTION",
		message: /approved counts human APPROVED\/APPLYING acceptance/,
	});
});
test("mutation: removing BACKLOG label fails the outcome assertion", async () => {
	const bad = mutate("WHEN 'BACKLOG' THEN 'Rejected'", "");
	await assert.rejects(withGold(bad, checkBacklog), {
		code: "ERR_ASSERTION",
		message: /BACKLOG final_outcome/,
	});
});
test("mutation: rtrim URL regression fails the function allowlist", () => {
	const bad = mutate(
		"trim(TRAILING '/' FROM :fabric_base_url)",
		"rtrim(:fabric_base_url, '/')",
	);
	assert.throws(
		() => checkFunctions(bad[1]),
		/rtrim:.*argument-order difference/,
	);
});
test("function vocabulary rejects unreviewed calls and unsafe trim forms", () => {
	assert.throws(
		() => checkFunctions("SELECT new_function(payload)"),
		/review DuckDB\/Databricks parity/,
	);
	for (const name of ["rtrim", "ltrim", "trim"]) {
		assert.throws(
			() => checkFunctions(`SELECT ${name}('example/', '/')`),
			/argument-order difference/,
		);
	}
	checkFunctions(
		"SELECT MIN('rtrim(x,y) -- not code') /* other_fn() */ -- ignored()\n",
	);
});
test("translation rejects unrecognised statement kinds and parameters", () => {
	assert.throws(
		() => translate("SET some_new_setting = true;"),
		/Unrecognised notebook statement/,
	);
	assert.throws(
		() =>
			translate(
				"CREATE OR REPLACE TABLE needs_review USING DELTA AS SELECT :new_parameter;",
			),
		/Unbound Databricks parameter/,
	);
});

test("mutation: removing proposed_at NULLS LAST fails queue ordering", async () => {
	const bad = mutate("proposed_at ASC NULLS LAST", "proposed_at ASC");
	await assert.rejects(withGold(bad, checkQueue), {
		code: "ERR_ASSERTION",
		message: /needs_review ordering/,
	});
});
test("mutation: changing change_count to NULLS FIRST fails queue ordering", async () => {
	const bad = mutate(
		"change_count DESC NULLS LAST",
		"change_count DESC NULLS FIRST",
	);
	await assert.rejects(withGold(bad, checkQueue), {
		code: "ERR_ASSERTION",
		message: /needs_review ordering/,
	});
});
test("mutation: removing UTC setup fails the naive UTC prerequisite", async () => {
	const bad = mutate("SET TIME ZONE 'UTC';", "");
	await assert.rejects(
		withGold(bad, checkGold),
		/Gold notebook must declare SET TIME ZONE/,
	);
});
for (const sql of [
	"SELECT `rtrim`(payload)",
	'SELECT "rtrim"(payload)',
	'SELECT "example"',
	"SELECT current_timestamp",
	"SELECT current_date",
	"SELECT now",
	"SELECT localtimestamp",
	"SELECT current_time",
	"SELECT localtime",
	"SELECT today",
	"SELECT transaction_timestamp",
	"SELECT statement_timestamp",
	"SELECT clock_timestamp",
	"SELECT sysdate",
	"SELECT systimestamp",
]) {
	test(`scanner rejects unsupported quoted or niladic SQL: ${sql}`, () => {
		assert.throws(() => checkFunctions(sql), /Quoted SQL|Niladic datetime/);
	});
}
test("scanner accepts parenthesized boolean grammar and ignores quoted text inside comments/literals", () => {
	checkFunctions("SELECT count(*) WHERE x = 1 AND (y = 2) OR NOT (z = 3)");
	checkFunctions(
		'SELECT MIN(\'`rtrim` "now"\') -- `current_date` "quoted"\n',
	);
});

for (const [name, from, to, message] of [
	[
		"proposal NULL-subject filter",
		"FROM decision_event_current\n  WHERE subject_type = 'backlog_proposal' AND subject_id IS NOT NULL",
		"FROM decision_event_current\n  WHERE subject_type = 'backlog_proposal'",
		/NULL-subject proposals must not enter suggestion_journey/,
	],
	[
		"duplicate NULL-subject filter",
		"WHERE subject_type = 'story_duplicate_link' AND subject_id IS NOT NULL",
		"WHERE subject_type = 'story_duplicate_link'",
		/duplicate outcomes exclude NULL subjects/,
	],
	[
		"inclusive application-time boundary",
		"e.occurred_at >= p.applied_at",
		"e.occurred_at > p.applied_at",
		/application edit metrics include both time-window boundaries/,
	],
]) {
	test(`mutation: ${name} fails the main gold assertions`, async () => {
		await assert.rejects(withGold(mutate(from, to), checkGold), {
			code: "ERR_ASSERTION",
			message,
		});
	});
}
test("UTC prerequisite accepts case-insensitive SQL like the translator", async () => {
	await withGold(
		mutate("SET TIME ZONE 'UTC';", "set time zone 'UTC';"),
		checkGold,
	);
});

async function checkChanges(query, cases = changeFixture.cases) {
	for (const fixture of cases) {
		const rows = await query(
			`SELECT offered_index, stored_index, outcome, CAST(decided_at AS DATE) AS decision_day FROM change_outcomes WHERE project_id = '${fixture.projectId}' AND proposal_id = '${fixture.proposalId}' ORDER BY offered_index`,
		);
		const labels = {
			applied: "Applied",
			notSelected: "Not selected",
			alreadyOnRoadmap: "Already on roadmap",
			failed: "Failed",
			inProgress: "In progress",
			rejected: "Rejected",
			superseded: "Superseded",
			pending: "Pending",
		};
		const readable = await query(
			readableOutcomeQuery.replace(
				"__aibi_external_value",
				literal(fixture.projectId),
			),
		);
		assert.deepEqual(
			Object.fromEntries(
				readable.map((r) => [r.outcome, Number(r.changes)]),
			),
			Object.fromEntries(
				Object.entries(fixture.changeOutcomes)
					.filter(([, n]) => n > 0)
					.map(([key, n]) => [labels[key], n]),
			),
			`${fixture.name} dashboard labels`,
		);
		assert.equal(
			rows.length,
			fixture.coveredChangeCount,
			`${fixture.name}: one outcome per covered offered change`,
		);
		assert.equal(
			new Set(rows.map((r) => Number(r.offered_index))).size,
			rows.length,
			`${fixture.name}: unique offered indexes`,
		);
		assert.deepEqual(
			rows.map((r) => r.decision_day),
			fixture.expectedDecisionDays,
			fixture.name,
		);
		assert.deepEqual(
			rows.map((r) => r.outcome),
			fixture.expectedOutcomes,
			fixture.name,
		);
		assert.deepEqual(
			rows.map((r) =>
				r.stored_index == null ? null : Number(r.stored_index),
			),
			fixture.expectedStoredIndexes,
			fixture.name,
		);
		const [counts] = await query(
			`SELECT SUM(change_accepted) AS accepted, SUM(change_decided) AS decided FROM project_decision_daily WHERE project_id = '${fixture.projectId}'`,
		);
		assert.equal(
			Number(counts.accepted),
			fixture.changeAcceptance.accepted,
			fixture.name,
		);
		assert.equal(
			Number(counts.decided),
			fixture.changeAcceptance.decided,
			fixture.name,
		);
		assert.equal(
			counts.decided == null || Number(counts.decided) === 0
				? null
				: Number(counts.accepted) / Number(counts.decided),
			fixture.changeAcceptance.rate,
			fixture.name,
		);
		for (const [outcome, count] of Object.entries(fixture.changeOutcomes)) {
			const col =
				"change_" +
				outcome.replace(
					/[A-Z]/g,
					(letter) => `_${letter.toLowerCase()}`,
				);
			const [daily] = await query(
				`SELECT SUM(${col}) AS n FROM project_decision_daily WHERE project_id='${fixture.projectId}'`,
			);
			assert.equal(Number(daily.n), count, `${fixture.name} ${outcome}`);
		}
		const [journey] = await query(
			`SELECT offered, selected, not_selected, partly_applied FROM suggestion_journey WHERE proposal_id = '${fixture.proposalId}'`,
		);
		assert.deepEqual(
			Object.fromEntries(
				Object.entries(journey).map(([k, v]) => [
					k,
					v === null || typeof v === "boolean" ? v : Number(v),
				]),
			),
			fixture.expectedJourney,
			fixture.name,
		);
		assert.equal(
			journey.partly_applied,
			Boolean(fixture.partlyApplied),
			fixture.name,
		);
	}
}
test("shared change rules match per-change outcomes, rates, journey and daily counts", async () => {
	await withGold(notebooks, (query) => checkChanges(query), true);
});

for (const [name, from, to] of [
	[
		"applied precedence",
		"WHEN a.applied_at IS NOT NULL THEN 'applied'",
		"WHEN false THEN 'applied'",
	],
	[
		"duplicates",
		"WHEN a.deduplicated_at IS NOT NULL THEN 'alreadyOnRoadmap'",
		"WHEN false THEN 'alreadyOnRoadmap'",
	],
	["not selected", "THEN 'notSelected'", "THEN 'pending'"],
	["failed", "THEN 'failed'", "THEN 'pending'"],
	["in progress", "THEN 'inProgress'", "THEN 'pending'"],
	["rejected", "THEN 'rejected'", "THEN 'pending'"],
	["superseded", "THEN 'superseded'", "THEN 'pending'"],
	["coverage", "WHERE decided_at >= coverage_at", "WHERE true"],
	[
		"no-review resolution time",
		"COALESCE(e.selected_at,r.occurred_at,a.applied_at,a.deduplicated_at)",
		"COALESCE(e.selected_at,r.occurred_at)",
	],
	[
		"review decision day",
		"ELSE review_at END AS decided_at",
		"ELSE status_at END AS decided_at",
	],
	["complete sidebar", "e.entry_rn=1 AND r.complete=true", "e.entry_rn=1"],
	[
		"recommendation history",
		"e.ever_selected=0 AND s.to_state",
		"e.selected=false AND s.to_state",
	],
	[
		"acceptance denominator",
		"'inProgress','notSelected','rejected'",
		"'inProgress','alreadyOnRoadmap','notSelected','rejected'",
	],
	[
		"partly applied",
		"COALESCE(o.not_selected,0)>0",
		"COALESCE(o.not_selected,0)=0",
	],
	[
		"sidebar stored index",
		"a.stored_index=e.stored_index",
		"a.stored_index=e.offered_index",
	],
	[
		"review id tie break",
		"ORDER BY r.occurred_at DESC, r.id DESC, e.id DESC",
		"ORDER BY r.occurred_at DESC, r.id ASC, e.id DESC",
	],
]) {
	test(`mutation: shared fixture catches broken ${name}`, async () => {
		await assert.rejects(
			withGold(mutate(from, to), (query) => checkChanges(query), true),
			{
				code: "ERR_ASSERTION",
			},
		);
	});
}

for (const fixture of changeFixture.cases.slice(-5)) {
	test(`round 1 regression: ${fixture.name}`, async () => {
		await withGold(
			notebooks,
			(query) => checkChanges(query, [fixture]),
			true,
		);
	});
}

test("malformed feed counts use TRY_CAST; restoring CAST fails on the bad input", async () => {
	const fixture = changeFixture.cases.find(
		(c) => c.name === "fully-rejected-no-review",
	);
	const malformed = (connection) =>
		connection.run(
			`UPDATE lb_decision_event_history SET payload='{"source":"TEAMS_CHANNEL","changeCount":"invalid"}' WHERE subject_id=${literal(fixture.proposalId)} AND event_type='status_changed'`,
		);
	await withGold(
		notebooks,
		async (query) => {
			const [r] = await query(
				`SELECT COUNT(*) AS n FROM change_outcomes WHERE project_id=${literal(fixture.projectId)}`,
			);
			assert.equal(Number(r.n), 0);
		},
		true,
		malformed,
	);
	await assert.rejects(
		withGold(
			mutate(
				"TRY_CAST(get_json_object(payload, '$.changeCount') AS BIGINT) AS change_count",
				"CAST(get_json_object(payload, '$.changeCount') AS BIGINT) AS change_count",
			),
			async () => {},
			true,
			malformed,
		),
		/Conversion Error/,
	);
});
