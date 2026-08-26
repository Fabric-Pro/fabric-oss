/**
 * Parity test: the admin explorer's CSV / NDJSON serializers must emit
 * the same wire format as the in-product `audit.export` procedure.
 *
 * Before this test landed, the explorer used its own 11-column camelCase
 * CSV header + nested-object NDJSON shape, diverging from the customer
 * download. Operators who routinely shuttled exports between the two
 * surfaces had to maintain two parsers. This test exists so a future
 * change to either serializer fails loudly until both match.
 *
 * The explorer ingests rows through the API-key proxy (nested `actor` +
 * `resource`, `correlationId` collapsed from `metadata.correlationId` ??
 * `requestId`). We build matching fixtures for both sides and assert
 * the produced bytes are equal.
 */

import {
	serializeAuditLogToCsv,
	serializeAuditLogToNdjson,
} from "@repo/api/modules/audit/lib/export-format";
import { describe, expect, it } from "vitest";
import {
	type ProxyRow,
	serializeRowsToCsv as explorerCsv,
	serializeRowsToNdjson as explorerNdjson,
} from "../AuditLogExplorer";

// Minimal `AuditLogRow` shape — the production type lives in
// `@repo/database`, but the serializer only reads the fields below.
type ServerRow = Parameters<typeof serializeAuditLogToCsv>[0][number];

function makeProxyRow(overrides: Partial<ProxyRow> = {}): ProxyRow {
	return {
		id: "row-1",
		organizationId: "org-1",
		userId: "user-1",
		actorType: "user",
		actor: {
			email: "audit@example.com",
			name: "Audit Bot",
		},
		impersonatedById: null,
		action: "auth.login.success",
		category: "auth",
		severity: "info",
		outcome: "success",
		resource: {
			type: "user",
			id: "user-1",
			name: "audit@example.com",
		},
		projectId: null,
		ipAddress: "10.0.0.1",
		userAgent: "curl/8.0",
		correlationId: "req_abcdef",
		sessionId: "sess-1",
		metadata: { method: "password" },
		durationMs: 42,
		createdAt: "2026-05-18T12:34:56.000Z",
		...overrides,
	};
}

// The in-product serializer takes Prisma `AuditLogRow` shape. Build a
// row that, when serialized, must produce identical output to the
// proxy row above.
function makeServerRow(overrides: Partial<ServerRow> = {}): ServerRow {
	return {
		id: "row-1",
		organizationId: "org-1",
		userId: "user-1",
		actorType: "user",
		actorEmailSnapshot: "audit@example.com",
		actorNameSnapshot: "Audit Bot",
		impersonatedById: null,
		action: "auth.login.success",
		category: "auth",
		severity: "info",
		outcome: "success",
		resourceType: "user",
		resourceId: "user-1",
		resourceName: "audit@example.com",
		projectId: null,
		ipAddress: "10.0.0.1",
		userAgent: "curl/8.0",
		requestId: "req_abcdef",
		sessionId: "sess-1",
		metadata: { method: "password" },
		durationMs: 42,
		createdAt: new Date("2026-05-18T12:34:56.000Z"),
		...overrides,
	} as ServerRow;
}

describe("Admin explorer ↔ in-product export parity", () => {
	it("CSV: explorer header equals the in-product header", () => {
		const proxyRow = makeProxyRow();
		const serverRow = makeServerRow();

		const explorerHeader = explorerCsv([proxyRow]).split("\n")[0];
		const productHeader = serializeAuditLogToCsv([serverRow]).split(
			"\n",
		)[0];

		expect(explorerHeader).toBe(productHeader);
		expect(explorerHeader).toBe(
			"timestamp,actor_email,actor_name,actor_type,action,category,severity,outcome,resource_type,resource_id,resource_name,project_id,ip_address,user_agent,request_id,session_id,impersonated_by_id",
		);
	});

	it("CSV: explorer row body matches in-product row body for equivalent inputs", () => {
		const proxyRow = makeProxyRow();
		const serverRow = makeServerRow();

		const explorerLine = explorerCsv([proxyRow]).split("\n")[1];
		const productLine = serializeAuditLogToCsv([serverRow]).split("\n")[1];

		expect(explorerLine).toBe(productLine);
	});

	it("CSV: empty inputs emit a header-only file in both surfaces", () => {
		const explorerOut = explorerCsv([]);
		const productOut = serializeAuditLogToCsv([]);
		expect(explorerOut).toBe(productOut);
	});

	it("CSV: null fields render as empty cells in both surfaces", () => {
		const proxyRow = makeProxyRow({
			ipAddress: null,
			userAgent: null,
			sessionId: null,
			impersonatedById: null,
			projectId: null,
			resource: null,
		});
		const serverRow = makeServerRow({
			ipAddress: null,
			userAgent: null,
			sessionId: null,
			impersonatedById: null,
			projectId: null,
			resourceType: null,
			resourceId: null,
			resourceName: null,
		});

		expect(explorerCsv([proxyRow])).toBe(
			serializeAuditLogToCsv([serverRow]),
		);
	});

	it("NDJSON: explorer field set matches the in-product field set", () => {
		const proxyRow = makeProxyRow();
		const serverRow = makeServerRow();

		const explorerObj = JSON.parse(
			explorerNdjson([proxyRow]).trim().split("\n")[0]!,
		);
		const productObj = JSON.parse(
			serializeAuditLogToNdjson([serverRow]).trim().split("\n")[0]!,
		);

		expect(Object.keys(explorerObj).sort()).toEqual(
			Object.keys(productObj).sort(),
		);
	});

	it("NDJSON: explorer row values match the in-product row values", () => {
		const proxyRow = makeProxyRow();
		const serverRow = makeServerRow();

		const explorerObj = JSON.parse(
			explorerNdjson([proxyRow]).trim().split("\n")[0]!,
		);
		const productObj = JSON.parse(
			serializeAuditLogToNdjson([serverRow]).trim().split("\n")[0]!,
		);

		// Compare key-by-key so an unequal field surfaces clearly rather
		// than as a giant diff blob.
		for (const key of Object.keys(productObj)) {
			expect(explorerObj[key]).toStrictEqual(productObj[key]);
		}
	});

	it("NDJSON: empty inputs emit empty strings in both surfaces", () => {
		expect(explorerNdjson([])).toBe(serializeAuditLogToNdjson([]));
	});
});
