/**
 * The audit row both synced-file surfaces write (Fizzy #2616) — the
 * `projects.contexts.upsertSyncedFile` procedure and the
 * `fabric_upsert_project_context` MCP tool, through `upsertSyncedContext`.
 *
 * Pins what the ledger depends on: the row identifies the write by path, hash
 * and size and never carries the content; the replaced hash appears on an
 * update and only there; and no metadata key is one the shared sensitive-key
 * redactor would blank out.
 */
import { keyIsSensitive } from "@repo/utils/sensitive-keys";
import { describe, expect, it } from "vitest";
import {
	buildContextContentAuditEvent,
	CONTEXT_CONTENT_AUDIT_ACTION,
} from "../context-content-audit";

const HASH_V1 = "a".repeat(64);
const HASH_V2 = "b".repeat(64);

const base = {
	organizationId: "org-1",
	projectId: "proj-1",
	contextId: "ctx-1",
	title: "architecture.md",
	sourcePath: "docs/architecture.md",
	bytes: 42,
	via: "mcp-gateway" as const,
};

describe("buildContextContentAuditEvent", () => {
	it("names the action, the project and the context by its title", () => {
		const event = buildContextContentAuditEvent({
			...base,
			outcome: "created",
			contentHash: HASH_V1,
		});

		expect(event).toMatchObject({
			action: "project.context_source.content_upserted",
			category: "project",
			organizationId: "org-1",
			projectId: "proj-1",
			resource: {
				type: "project_context",
				id: "ctx-1",
				name: "architecture.md",
			},
		});
		expect(CONTEXT_CONTENT_AUDIT_ACTION).toBe(
			"project.context_source.content_upserted",
		);
	});

	it("records a create by path, hash, size and surface", () => {
		const event = buildContextContentAuditEvent({
			...base,
			outcome: "created",
			contentHash: HASH_V1,
			// Ignored: a create replaced nothing.
			previousContentHash: HASH_V2,
		});

		expect(event.metadata).toEqual({
			outcome: "created",
			sourcePath: "docs/architecture.md",
			contentHash: HASH_V1,
			bytes: 42,
			via: "mcp-gateway",
		});
	});

	it("records the replaced hash on an update", () => {
		const event = buildContextContentAuditEvent({
			...base,
			outcome: "updated",
			contentHash: HASH_V2,
			previousContentHash: HASH_V1,
			via: "web",
		});

		expect(event.metadata).toEqual({
			outcome: "updated",
			sourcePath: "docs/architecture.md",
			contentHash: HASH_V2,
			bytes: 42,
			previousContentHash: HASH_V1,
			via: "web",
		});
	});

	it("has no field that could carry the content", () => {
		const event = buildContextContentAuditEvent({
			...base,
			outcome: "created",
			contentHash: HASH_V1,
		});

		expect(JSON.stringify(event)).not.toMatch(/"content"\s*:/);
	});

	it("uses no key the shared redactor would blank out", () => {
		const event = buildContextContentAuditEvent({
			...base,
			outcome: "updated",
			contentHash: HASH_V2,
			previousContentHash: HASH_V1,
		});
		const keys = Object.keys(event.metadata ?? {});

		expect(keys.length).toBeGreaterThan(0);
		expect(keys.filter((key) => keyIsSensitive(key))).toEqual([]);
	});
});
