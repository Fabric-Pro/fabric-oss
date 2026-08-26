/**
 * Unit tests for the server-authoritative decision-override audit helper.
 *
 * Covers the immutable-record contract: one row per conflicting decision, a
 * shared `metadata.artifactId`, the exact resource/category/severity fields, a
 * bounded output snapshot, XOR tenant handling, flag gating, and resilience to
 * an audit-write failure. `recordAuditFromRequest` is mocked so we assert the
 * emitted shape directly; the redaction-key check runs the real redactor.
 */

import { redactSensitiveKeys } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	backlogChangeSnapshot,
	extractDecisionPrecheck,
	recordDecisionOverridesAccepted,
} from "../decision-override-audit";

const recordAuditFromRequest = vi.fn();

vi.mock("../../../../lib/audit", () => ({
	recordAuditFromRequest: (...args: unknown[]) =>
		recordAuditFromRequest(...args),
}));

const context = {
	user: { id: "user-1", email: "reviewer@example.com", name: "Reviewer" },
	session: { id: "sess-1" },
};

function finding(overrides: Record<string, unknown> = {}) {
	return {
		decisionId: "dec-1",
		decisionIdentifier: "ADR-012",
		decisionTitle: "Use Postgres",
		natureOfConflict:
			"Proposes MongoDB, contradicting the Postgres decision",
		conflictType: "violates_accepted" as const,
		confidence: 0.9,
		...overrides,
	};
}

beforeEach(() => {
	recordAuditFromRequest.mockReset();
});

describe("recordDecisionOverridesAccepted — record shape", () => {
	it("writes one immutable record per conflicting decision, sharing artifactId", () => {
		recordDecisionOverridesAccepted(context, {
			projectId: "proj-1",
			organizationId: "org-1",
			surface: "backlog_proposal",
			artifactType: "pending_backlog_proposal",
			artifactId: "prop-1",
			precheck: {
				checkedAt: "2020-01-01T00:00:00.000Z",
				status: "conflicts",
				findings: [
					finding({
						decisionId: "dec-1",
						decisionIdentifier: "ADR-1",
					}),
					finding({
						decisionId: "dec-2",
						decisionIdentifier: "ADR-2",
					}),
				],
			},
			resolveSnapshot: () => "change text",
		});

		expect(recordAuditFromRequest).toHaveBeenCalledTimes(2);
		const artifactIds = recordAuditFromRequest.mock.calls.map(
			(call) =>
				(call[1] as { metadata: { artifactId: string } }).metadata
					.artifactId,
		);
		expect(artifactIds).toEqual(["prop-1", "prop-1"]);
		const decisionIds = recordAuditFromRequest.mock.calls.map(
			(call) => (call[1] as { resource: { id: string } }).resource.id,
		);
		expect(decisionIds).toEqual(["dec-1", "dec-2"]);
	});

	it("collapses multiple findings for one decision into a single row", () => {
		recordDecisionOverridesAccepted(context, {
			projectId: "proj-1",
			organizationId: "org-1",
			surface: "backlog_proposal",
			artifactType: "pending_backlog_proposal",
			artifactId: "prop-1",
			precheck: {
				checkedAt: "2020-01-01T00:00:00.000Z",
				status: "conflicts",
				findings: [
					finding({ changeRef: { index: 0 } }),
					finding({ changeRef: { index: 2 } }),
				],
			},
			resolveSnapshot: () => "change text",
		});

		expect(recordAuditFromRequest).toHaveBeenCalledTimes(1);
		const input = recordAuditFromRequest.mock.calls[0]?.[1] as {
			metadata: { findings: unknown[] };
		};
		expect(input.metadata.findings).toHaveLength(2);
	});

	it("stamps the exact audit fields per the taxonomy contract", () => {
		recordDecisionOverridesAccepted(context, {
			projectId: "proj-1",
			organizationId: "org-1",
			surface: "backlog_proposal",
			artifactType: "pending_backlog_proposal",
			artifactId: "prop-1",
			precheck: {
				checkedAt: "2020-01-01T00:00:00.000Z",
				status: "conflicts",
				findings: [
					finding({ changeRef: { index: 1, title: "Add store" } }),
				],
			},
			resolveSnapshot: () => "the contradicting change",
		});

		const input = recordAuditFromRequest.mock.calls[0]?.[1] as Record<
			string,
			unknown
		>;
		expect(input.action).toBe("decision.override_accepted");
		expect(input.category).toBe("decision");
		expect(input.severity).toBe("warning");
		expect(input.outcome).toBe("success");
		expect(input.projectId).toBe("proj-1");
		expect(input.resource).toEqual({
			type: "architecture_decision",
			id: "dec-1",
			name: "ADR-012",
		});
		expect(input.metadata).toMatchObject({
			surface: "backlog_proposal",
			artifactType: "pending_backlog_proposal",
			artifactId: "prop-1",
			decisionId: "dec-1",
			decisionIdentifier: "ADR-012",
			decisionTitle: "Use Postgres",
			conflictType: "violates_accepted",
			confidence: 0.9,
			changeRef: { index: 1, title: "Add store" },
			outputSnapshot: "the contradicting change",
		});
	});

	it("uses the document surface fields for the doc path", () => {
		recordDecisionOverridesAccepted(context, {
			projectId: "proj-1",
			organizationId: "org-1",
			surface: "document",
			artifactType: "project_document",
			artifactId: "doc-1",
			precheck: {
				checkedAt: "2020-01-01T00:00:00.000Z",
				status: "conflicts",
				findings: [finding()],
			},
			resolveSnapshot: () => "document content",
		});

		const input = recordAuditFromRequest.mock.calls[0]?.[1] as {
			metadata: { surface: string; artifactType: string };
		};
		expect(input.metadata.surface).toBe("document");
		expect(input.metadata.artifactType).toBe("project_document");
	});

	it("bounds the output snapshot to ~2 KB", () => {
		recordDecisionOverridesAccepted(context, {
			projectId: "proj-1",
			organizationId: "org-1",
			surface: "document",
			artifactType: "project_document",
			artifactId: "doc-1",
			precheck: {
				checkedAt: "2020-01-01T00:00:00.000Z",
				status: "conflicts",
				findings: [finding()],
			},
			resolveSnapshot: () => "x".repeat(5000),
		});

		const input = recordAuditFromRequest.mock.calls[0]?.[1] as {
			metadata: { outputSnapshot: string };
		};
		// 2000 chars + a single ellipsis marker.
		expect(input.metadata.outputSnapshot.length).toBe(2001);
		expect(input.metadata.outputSnapshot.endsWith("…")).toBe(true);
	});
});

describe("recordDecisionOverridesAccepted — tenant XOR", () => {
	it("attaches organizationId in org context", () => {
		recordDecisionOverridesAccepted(context, {
			projectId: "proj-1",
			organizationId: "org-9",
			surface: "document",
			artifactType: "project_document",
			artifactId: "doc-1",
			precheck: {
				checkedAt: "2020-01-01T00:00:00.000Z",
				status: "conflicts",
				findings: [finding()],
			},
			resolveSnapshot: () => "content",
		});
		const input = recordAuditFromRequest.mock.calls[0]?.[1] as Record<
			string,
			unknown
		>;
		expect(input.organizationId).toBe("org-9");
	});

	it("omits organizationId in personal context", () => {
		recordDecisionOverridesAccepted(context, {
			projectId: "proj-1",
			organizationId: null,
			surface: "document",
			artifactType: "project_document",
			artifactId: "doc-1",
			precheck: {
				checkedAt: "2020-01-01T00:00:00.000Z",
				status: "conflicts",
				findings: [finding()],
			},
			resolveSnapshot: () => "content",
		});
		const input = recordAuditFromRequest.mock.calls[0]?.[1] as Record<
			string,
			unknown
		>;
		expect("organizationId" in input).toBe(false);
	});
});

describe("recordDecisionOverridesAccepted — no-op paths", () => {
	const base = {
		projectId: "proj-1",
		organizationId: "org-1",
		surface: "backlog_proposal" as const,
		artifactType: "pending_backlog_proposal",
		artifactId: "prop-1",
		resolveSnapshot: () => "content",
	};

	it("writes nothing for a status:ok result", () => {
		recordDecisionOverridesAccepted(context, {
			...base,
			precheck: {
				checkedAt: "2020-01-01T00:00:00.000Z",
				status: "ok",
				findings: [],
			},
		});
		expect(recordAuditFromRequest).not.toHaveBeenCalled();
	});

	it("writes nothing for an absent precheck", () => {
		recordDecisionOverridesAccepted(context, { ...base, precheck: null });
		expect(recordAuditFromRequest).not.toHaveBeenCalled();
	});

	it("writes nothing when findings are empty despite a conflicts status", () => {
		recordDecisionOverridesAccepted(context, {
			...base,
			precheck: {
				checkedAt: "2020-01-01T00:00:00.000Z",
				status: "conflicts",
				findings: [],
			},
		});
		expect(recordAuditFromRequest).not.toHaveBeenCalled();
	});
});

describe("recordDecisionOverridesAccepted — resilience", () => {
	it("does not throw when the audit write throws", () => {
		recordAuditFromRequest.mockImplementation(() => {
			throw new Error("audit down");
		});
		expect(() =>
			recordDecisionOverridesAccepted(context, {
				projectId: "proj-1",
				organizationId: "org-1",
				surface: "document",
				artifactType: "project_document",
				artifactId: "doc-1",
				precheck: {
					checkedAt: "2020-01-01T00:00:00.000Z",
					status: "conflicts",
					findings: [finding()],
				},
				resolveSnapshot: () => "content",
			}),
		).not.toThrow();
	});

	it("does not throw when the snapshot resolver throws", () => {
		expect(() =>
			recordDecisionOverridesAccepted(context, {
				projectId: "proj-1",
				organizationId: "org-1",
				surface: "document",
				artifactType: "project_document",
				artifactId: "doc-1",
				precheck: {
					checkedAt: "2020-01-01T00:00:00.000Z",
					status: "conflicts",
					findings: [finding()],
				},
				resolveSnapshot: () => {
					throw new Error("snapshot boom");
				},
			}),
		).not.toThrow();
		expect(recordAuditFromRequest).toHaveBeenCalledTimes(1);
	});
});

describe("override metadata survives audit redaction", () => {
	it("keeps every chosen metadata key (none matches the sensitive-key denylist)", () => {
		const metadata = {
			surface: "backlog_proposal",
			artifactType: "pending_backlog_proposal",
			artifactId: "prop-1",
			findings: [finding({ changeRef: { index: 0, title: "t" } })],
			decisionId: "dec-1",
			decisionIdentifier: "ADR-012",
			decisionTitle: "Use Postgres",
			natureOfConflict: "conflict",
			conflictType: "violates_accepted",
			confidence: 0.9,
			changeRef: { index: 0, title: "t" },
			outputSnapshot: "snapshot",
		};
		const redacted = redactSensitiveKeys(metadata) as Record<
			string,
			unknown
		>;
		for (const key of Object.keys(metadata)) {
			expect(redacted[key]).not.toBe("[REDACTED]");
		}
		const findings = redacted.findings as Array<Record<string, unknown>>;
		for (const key of Object.keys(findings[0] ?? {})) {
			expect(findings[0]?.[key]).not.toBe("[REDACTED]");
		}
	});
});

describe("extractDecisionPrecheck", () => {
	it("returns null for absent / malformed values", () => {
		expect(extractDecisionPrecheck(undefined)).toBeNull();
		expect(extractDecisionPrecheck(null)).toBeNull();
		expect(extractDecisionPrecheck("nope")).toBeNull();
		expect(extractDecisionPrecheck({ status: "weird" })).toBeNull();
	});

	it("narrows a persisted conflicts result and drops findings without a decisionId", () => {
		const result = extractDecisionPrecheck({
			checkedAt: "2020-01-01T00:00:00.000Z",
			status: "conflicts",
			checkedContentHash: "abc",
			findings: [
				finding(),
				{ natureOfConflict: "no id here" },
				finding({ decisionId: "dec-2" }),
			],
		});
		expect(result?.status).toBe("conflicts");
		expect(result?.checkedContentHash).toBe("abc");
		expect(result?.findings.map((f) => f.decisionId)).toEqual([
			"dec-1",
			"dec-2",
		]);
	});

	it("clamps a forged out-of-range confidence into [0, 1]", () => {
		const result = extractDecisionPrecheck({
			checkedAt: "2020-01-01T00:00:00.000Z",
			status: "conflicts",
			findings: [
				finding({ decisionId: "dec-1", confidence: 5 }),
				finding({ decisionId: "dec-2", confidence: -3 }),
				finding({ decisionId: "dec-3", confidence: "nope" }),
			],
		});
		expect(result?.findings.map((f) => f.confidence)).toEqual([1, 0, 0]);
	});

	it("truncates an oversized natureOfConflict to keep WORM rows lean", () => {
		const result = extractDecisionPrecheck({
			checkedAt: "2020-01-01T00:00:00.000Z",
			status: "conflicts",
			findings: [
				finding({
					decisionId: "dec-1",
					natureOfConflict: "n".repeat(4000),
				}),
			],
		});
		expect(result?.findings[0]?.natureOfConflict.length).toBe(500);
	});

	it("caps the finding count so a forged payload can't fan out unbounded audit rows", () => {
		const forged = Array.from({ length: 80 }, (_, i) => ({
			decisionId: `dec-${i}`,
		}));
		const result = extractDecisionPrecheck({
			checkedAt: "2020-01-01T00:00:00.000Z",
			status: "conflicts",
			findings: forged,
		});
		expect(result?.findings).toHaveLength(50);
	});
});

describe("backlogChangeSnapshot", () => {
	it("reads the change at changeRef.index (diff + string shapes)", () => {
		const changes = [
			{ title: { to: "First" }, description: { to: "Body one" } },
			{ title: "Second", description: "Body two" },
		];
		expect(
			backlogChangeSnapshot(
				changes,
				finding({ changeRef: { index: 0 } }),
			),
		).toBe("First\n\nBody one");
		expect(
			backlogChangeSnapshot(
				changes,
				finding({ changeRef: { index: 1 } }),
			),
		).toBe("Second\n\nBody two");
	});

	it("returns empty for an out-of-range or missing changeRef", () => {
		expect(
			backlogChangeSnapshot([], finding({ changeRef: { index: 5 } })),
		).toBe("");
		expect(backlogChangeSnapshot([{ title: "x" }], finding())).toBe("");
	});
});
