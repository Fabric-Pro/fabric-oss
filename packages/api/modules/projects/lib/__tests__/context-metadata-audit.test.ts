/**
 * The audit row both context-metadata surfaces write — the Context tab's
 * dialog and the `fabric_update_project_context` MCP tool.
 *
 * Pins the two properties the ledger depends on: the resource is named from
 * title fields only (the row's body never reaches an append-only log), and
 * the before/after payload survives the shared sensitive-key redactor rather
 * than landing as "[REDACTED]".
 */
import { keyIsSensitive } from "@repo/utils/sensitive-keys";
import { describe, expect, it } from "vitest";
import {
	buildContextMetadataAuditEvent,
	CONTEXT_METADATA_AUDIT_ACTION,
	contextAuditResourceName,
} from "../context-metadata-audit";

const before = { sourceType: "Client Chat", aiInstructions: null };
const after = {
	sourceType: "Architect Chat",
	aiInstructions: "Prefer this over older notes.",
};

describe("contextAuditResourceName", () => {
	it("prefers the source title", () => {
		expect(
			contextAuditResourceName({
				type: "LINK",
				sourceTitle: "Docs site",
				originalFilename: "ignored.pdf",
			}),
		).toBe("Docs site");
	});

	it("falls back to a title-shaped metadata key, then the filename, then the type", () => {
		expect(
			contextAuditResourceName({
				type: "INTEGRATION",
				metadata: { chatTopic: "Delivery sync" },
			}),
		).toBe("Delivery sync");
		expect(
			contextAuditResourceName({
				type: "FILE",
				originalFilename: "spec.pdf",
				metadata: { provider: "upload" },
			}),
		).toBe("spec.pdf");
		expect(contextAuditResourceName({ type: "TEXT" })).toBe("TEXT context");
	});

	it("never reads a body field, even when one is present", () => {
		const row = {
			type: "TEXT",
			content: "Confidential research notes",
			metadata: { content: "Confidential research notes" },
		};
		expect(contextAuditResourceName(row)).toBe("TEXT context");
	});
});

describe("buildContextMetadataAuditEvent", () => {
	const event = buildContextMetadataAuditEvent({
		organizationId: "org-1",
		projectId: "proj-1",
		context: { id: "ctx-1", type: "LINK", sourceTitle: "Docs site" },
		before,
		after,
		changed: ["sourceType", "aiInstructions"],
		via: "mcp-gateway",
	});

	it("names the action, the project and the context", () => {
		expect(event).toMatchObject({
			action: CONTEXT_METADATA_AUDIT_ACTION,
			category: "project",
			organizationId: "org-1",
			projectId: "proj-1",
			resource: {
				type: "project_context",
				id: "ctx-1",
				name: "Docs site",
			},
		});
		expect(CONTEXT_METADATA_AUDIT_ACTION).toBe(
			"project.context_source.metadata_updated",
		);
	});

	it("carries both fields before and after, what changed, and the surface", () => {
		expect(event.metadata).toEqual({
			changed: ["sourceType", "aiInstructions"],
			before,
			after,
			via: "mcp-gateway",
		});
	});

	it("uses no key the shared redactor would blank out", () => {
		// `recordAudit` redacts by KEY name. A key on its denylist would store
		// "[REDACTED]" in place of the very values this row exists to keep.
		const keys: string[] = [];
		const walk = (node: unknown) => {
			if (node && typeof node === "object" && !Array.isArray(node)) {
				for (const [key, value] of Object.entries(node)) {
					keys.push(key);
					walk(value);
				}
			}
		};
		walk(event.metadata);

		expect(keys.length).toBeGreaterThan(0);
		expect(keys.filter((key) => keyIsSensitive(key))).toEqual([]);
	});
});
