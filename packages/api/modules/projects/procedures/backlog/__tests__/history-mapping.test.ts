/**
 * Unit tests for the AI Backlog history mapping helpers — the pure logic behind
 * the read-only Audit + Session history tabs. Focus: actor attribution (FR-11,
 * AI vs. user) and defensive extraction of the proposed-changes / errors JSON.
 */

import { describe, expect, it } from "vitest";
import {
	type AuditRowLike,
	deriveChangeSource,
	mapAuditRow,
	resolveHistoryActions,
	STORY_AUDIT_ACTIONS,
	toErrorList,
	toLightweightChanges,
	toSessionMessages,
} from "../history-mapping";

function auditRow(overrides: Partial<AuditRowLike>): AuditRowLike {
	return {
		id: "a1",
		action: "story.updated",
		actorType: "user",
		userId: null,
		actorNameSnapshot: null,
		actorEmailSnapshot: null,
		resourceId: "s1",
		resourceName: "Login bug",
		metadata: null,
		createdAt: new Date("2026-06-10T00:00:00.000Z"),
		...overrides,
	};
}

describe("mapAuditRow — actor attribution (FR-11)", () => {
	it("agent-authored row is surfaced as AI (never a user), no email", () => {
		const row = mapAuditRow(
			auditRow({ actorType: "agent", actorNameSnapshot: "Fabric AI" }),
		);
		expect(row.isAI).toBe(true);
		expect(row.actorName).toBe("Fabric AI");
		expect(row.actorEmail).toBeNull();
	});

	it("agent row with no name snapshot falls back to 'Fabric AI'", () => {
		const row = mapAuditRow(
			auditRow({ actorType: "agent", actorNameSnapshot: null }),
		);
		expect(row.isAI).toBe(true);
		expect(row.actorName).toBe("Fabric AI");
	});

	it("system-authored row is also treated as AI", () => {
		const row = mapAuditRow(auditRow({ actorType: "system" }));
		expect(row.isAI).toBe(true);
	});

	it("user-authored row shows the user's identity, not AI", () => {
		const row = mapAuditRow(
			auditRow({
				actorType: "user",
				actorNameSnapshot: "Alice",
				actorEmailSnapshot: "alice@example.com",
			}),
		);
		expect(row.isAI).toBe(false);
		expect(row.actorName).toBe("Alice");
		expect(row.actorEmail).toBe("alice@example.com");
	});
});

describe("mapAuditRow — resolved user + session link", () => {
	it("AI row shows the resolved human who triggered it, plus the AI tag", () => {
		const row = mapAuditRow(
			auditRow({
				actorType: "agent",
				actorNameSnapshot: "Fabric AI",
				userId: "u1",
			}),
			{
				user: {
					name: "Alice",
					email: "alice@example.com",
					image: null,
				},
			},
		);
		// isAI stays true (drives the "AI" tag) but the human is shown.
		expect(row.isAI).toBe(true);
		expect(row.actorName).toBe("Alice");
		expect(row.actorEmail).toBe("alice@example.com");
	});

	it("AI row with no resolved user falls back to 'Fabric AI'", () => {
		const row = mapAuditRow(
			auditRow({ actorType: "agent", actorNameSnapshot: "Fabric AI" }),
		);
		expect(row.actorName).toBe("Fabric AI");
	});

	it("actorImage comes from the resolved user", () => {
		const row = mapAuditRow(auditRow({ actorType: "user", userId: "u1" }), {
			user: { name: "Alice", email: null, image: "http://img/x.png" },
		});
		expect(row.actorImage).toBe("http://img/x.png");
	});

	it("attaches the linked session id when provided, else null", () => {
		expect(
			mapAuditRow(auditRow({}), { sessionId: "sess1" }).sessionId,
		).toBe("sess1");
		expect(mapAuditRow(auditRow({})).sessionId).toBeNull();
	});
});

describe("mapAuditRow — metadata extraction", () => {
	it("extracts changedFields when it is a string array", () => {
		const row = mapAuditRow(
			auditRow({ metadata: { changedFields: ["title", "description"] } }),
		);
		expect(row.changedFields).toEqual(["title", "description"]);
	});

	it("filters non-string entries out of changedFields", () => {
		const row = mapAuditRow(
			auditRow({ metadata: { changedFields: ["title", 5, null] } }),
		);
		expect(row.changedFields).toEqual(["title"]);
	});

	it("changedFields is null when metadata is missing or not an array", () => {
		expect(
			mapAuditRow(auditRow({ metadata: null })).changedFields,
		).toBeNull();
		expect(
			mapAuditRow(auditRow({ metadata: { changedFields: "nope" } }))
				.changedFields,
		).toBeNull();
	});

	it("extracts statusName for status changes", () => {
		const row = mapAuditRow(
			auditRow({
				action: "story.status_changed",
				metadata: { statusName: "In Progress" },
			}),
		);
		expect(row.statusName).toBe("In Progress");
	});
});

describe("toLightweightChanges", () => {
	it("returns [] for non-array input", () => {
		expect(toLightweightChanges(null)).toEqual([]);
		expect(toLightweightChanges({})).toEqual([]);
		expect(toLightweightChanges("x")).toEqual([]);
	});

	it("extracts action/type/title.to from change objects", () => {
		const out = toLightweightChanges([
			{
				action: "create",
				type: "feature",
				title: { to: "New dashboard" },
			},
			{ action: "update", type: "bug", title: { to: "Fix crash" } },
		]);
		expect(out).toEqual([
			{ action: "create", type: "feature", title: "New dashboard" },
			{ action: "update", type: "bug", title: "Fix crash" },
		]);
	});

	it("falls back to a plain string title, then 'Untitled'", () => {
		expect(toLightweightChanges([{ title: "Plain" }])[0].title).toBe(
			"Plain",
		);
		expect(toLightweightChanges([{}])[0].title).toBe("Untitled");
	});

	it("defaults action to 'update' and type to 'feature'", () => {
		const [c] = toLightweightChanges([{ title: { to: "X" } }]);
		expect(c.action).toBe("update");
		expect(c.type).toBe("feature");
	});

	it("caps the number of changes per row", () => {
		const many = Array.from({ length: 250 }, () => ({
			action: "create",
			type: "feature",
			title: { to: "x" },
		}));
		expect(toLightweightChanges(many).length).toBe(100);
	});
});

describe("toErrorList", () => {
	it("returns null for non-array or empty", () => {
		expect(toErrorList(null)).toBeNull();
		expect(toErrorList("err")).toBeNull();
		expect(toErrorList([])).toBeNull();
	});

	it("keeps only string entries", () => {
		expect(toErrorList(["boom", 1, null, "bang"])).toEqual([
			"boom",
			"bang",
		]);
	});

	it("returns null when no strings remain", () => {
		expect(toErrorList([1, 2, null])).toBeNull();
	});
});

describe("STORY_AUDIT_ACTIONS", () => {
	it("covers the four backlog item lifecycle actions plus the PM status sync's move", () => {
		expect(STORY_AUDIT_ACTIONS).toEqual([
			"story.created",
			"story.updated",
			"story.status_changed",
			"story.pm_status_synced",
			"story.deleted",
		]);
	});
});

describe("deriveChangeSource", () => {
	it("maps AI Update sources", () => {
		expect(deriveChangeSource({ source: "AI_UPDATE" })).toBe("AI Update");
		expect(deriveChangeSource({ source: "AI_BACKLOG_UPDATE" })).toBe(
			"AI Update",
		);
	});

	it("maps channel proposals by reporter", () => {
		expect(
			deriveChangeSource({
				source: "APPROVED_PROPOSAL",
				reporterSource: "SLACK",
			}),
		).toBe("Slack");
		expect(
			deriveChangeSource({
				source: "APPROVED_PROPOSAL",
				reporterSource: "TEAMS",
			}),
		).toBe("Teams");
		expect(deriveChangeSource({ source: "APPROVED_PROPOSAL" })).toBe(
			"Monitored channel",
		);
	});

	it("returns null for manual / unknown / non-object metadata", () => {
		expect(deriveChangeSource(null)).toBeNull();
		expect(deriveChangeSource({ changedFields: ["title"] })).toBeNull();
		expect(deriveChangeSource("nope")).toBeNull();
	});
});

describe("mapAuditRow — identifier + source passthrough", () => {
	it("carries the resolved ticket identifier", () => {
		expect(
			mapAuditRow(auditRow({}), { identifier: "F-123" }).identifier,
		).toBe("F-123");
	});

	it("derives source from the row metadata", () => {
		const row = mapAuditRow(
			auditRow({ metadata: { source: "AI_UPDATE", kind: "feature" } }),
		);
		expect(row.source).toBe("AI Update");
	});

	it("source + identifier are null by default (manual edit)", () => {
		const row = mapAuditRow(auditRow({}));
		expect(row.source).toBeNull();
		expect(row.identifier).toBeNull();
	});
});

describe("mapAuditRow — groupKey + deleted (bulk grouping / removed tickets)", () => {
	it("groupKey prefers correlationId, then proposalId", () => {
		expect(
			mapAuditRow(
				auditRow({
					metadata: { correlationId: "req_1", proposalId: "prop_1" },
				}),
			).groupKey,
		).toBe("req_1");
		expect(
			mapAuditRow(auditRow({ metadata: { proposalId: "prop_1" } }))
				.groupKey,
		).toBe("prop_1");
	});

	it("groupKey is null when the row carries neither id", () => {
		expect(
			mapAuditRow(auditRow({ metadata: { kind: "feature" } })).groupKey,
		).toBeNull();
		expect(mapAuditRow(auditRow({ metadata: null })).groupKey).toBeNull();
	});

	it("deleted reflects the resolved flag (default false)", () => {
		expect(mapAuditRow(auditRow({}), { deleted: true }).deleted).toBe(true);
		expect(mapAuditRow(auditRow({})).deleted).toBe(false);
	});
});

describe("toSessionMessages", () => {
	it("returns [] for non-array / null input", () => {
		expect(toSessionMessages(null)).toEqual([]);
		expect(toSessionMessages("x")).toEqual([]);
	});

	it("keeps {role, content} entries, dropping empty/invalid ones", () => {
		expect(
			toSessionMessages([
				{ role: "user", content: "hi" },
				{ role: "assistant", content: "" },
				{ role: "assistant", content: "hello" },
				{ nope: true },
				null,
			]),
		).toEqual([
			{ role: "user", content: "hi" },
			{ role: "assistant", content: "hello" },
		]);
	});

	it("defaults a missing role to 'assistant'", () => {
		expect(toSessionMessages([{ content: "x" }])).toEqual([
			{ role: "assistant", content: "x" },
		]);
	});
});

/**
 * Exactly what the PM status sync's leaf hands `recordAudit` for a `moved`
 * write (spec §4.4; plan interface contract, "audit metadata shape").
 */
const LEAF_PM_STATUS_SYNC_AUDIT = {
	action: "story.pm_status_synced",
	category: "story",
	actor: { type: "system" },
	organizationId: "org_1",
	projectId: "project_1",
	resource: { type: "story", id: "story_1", name: "Checkout flow" },
	metadata: {
		fromStatus: "status_backlog",
		toStatus: "status_review",
		statusName: "In Review",
		source: "PM_STATUS_SYNC",
		pmTool: "GitLab",
	},
};

/** Mirrors `buildAuditRow` in packages/database/prisma/queries/audit-log.ts. */
function rowFromRecordAudit(
	input: typeof LEAF_PM_STATUS_SYNC_AUDIT,
): AuditRowLike {
	return {
		id: "a_sync_1",
		action: input.action,
		actorType: input.actor.type,
		userId: null,
		actorNameSnapshot: null,
		actorEmailSnapshot: null,
		resourceId: input.resource.id,
		resourceName: input.resource.name,
		metadata: input.metadata,
		createdAt: new Date("2026-09-21T09:00:00.000Z"),
	};
}

describe("mapAuditRow — a move the PM status sync applied (Fizzy #2304)", () => {
	it("renders the leaf's audit as a synced move by the tool, not an AI edit", () => {
		// Positive control: the same system actor on an ordinary story action IS
		// tagged AI.
		expect(mapAuditRow(auditRow({ actorType: "system" })).isAI).toBe(true);

		expect(
			mapAuditRow(rowFromRecordAudit(LEAF_PM_STATUS_SYNC_AUDIT), {
				identifier: "F-12",
			}),
		).toEqual({
			id: "a_sync_1",
			action: "story.pm_status_synced",
			actorType: "system",
			isAI: false,
			actorName: "GitLab",
			actorEmail: null,
			actorImage: null,
			resourceId: "story_1",
			resourceName: "Checkout flow",
			identifier: "F-12",
			source: "GitLab sync",
			changedFields: null,
			statusName: "In Review",
			sessionId: null,
			deleted: false,
			groupKey: null,
			createdAt: new Date("2026-09-21T09:00:00.000Z"),
		});
	});

	it("falls back to a generic tool name when the metadata carries none", () => {
		const row = mapAuditRow(
			rowFromRecordAudit({
				...LEAF_PM_STATUS_SYNC_AUDIT,
				metadata: { ...LEAF_PM_STATUS_SYNC_AUDIT.metadata, pmTool: "" },
			}),
		);
		expect(row.source).toBe("PM tool sync");
		expect(row.actorName).toBe("PM tool");
		expect(row.isAI).toBe(false);
	});
});

describe("deriveChangeSource — PM status sync", () => {
	it("names the tool the move was synced from", () => {
		expect(
			deriveChangeSource({ source: "PM_STATUS_SYNC", pmTool: "Jira" }),
		).toBe("Jira sync");
	});
});

describe("resolveHistoryActions — history filters", () => {
	it("puts the PM status sync's move under 'Status changed'", () => {
		expect(resolveHistoryActions({ action: "status_changed" })).toEqual([
			"story.status_changed",
			"story.pm_status_synced",
		]);
	});

	it("keeps every other filter to its own action", () => {
		expect(resolveHistoryActions({ action: "created" })).toEqual([
			"story.created",
		]);
		expect(resolveHistoryActions({ action: "updated" })).toEqual([
			"story.updated",
		]);
		expect(resolveHistoryActions({ action: "deleted" })).toEqual([
			"story.deleted",
		]);
	});

	it("defaults to the whole history action set", () => {
		expect(resolveHistoryActions({})).toEqual([...STORY_AUDIT_ACTIONS]);
		expect(resolveHistoryActions({ action: "all" })).toEqual([
			...STORY_AUDIT_ACTIONS,
		]);
	});

	it("leaves a synced move out of the AI bucket, which selects system actors", () => {
		// Positive control: without the AI filter the synced move is in.
		expect(
			resolveHistoryActions({ action: "status_changed", actor: "all" }),
		).toContain("story.pm_status_synced");

		expect(
			resolveHistoryActions({ action: "status_changed", actor: "ai" }),
		).toEqual(["story.status_changed"]);
		expect(resolveHistoryActions({ actor: "ai" })).not.toContain(
			"story.pm_status_synced",
		);
	});
});
