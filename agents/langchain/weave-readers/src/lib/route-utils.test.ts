/**
 * Route Utils Tests
 */

import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
	extractText,
	getVerifiedTenant,
	normalizeMetadata,
} from "./route-utils.js";

describe("extractText", () => {
	it("returns the string as-is when message is a plain string", () => {
		assert.equal(extractText("hello"), "hello");
	});

	it("returns empty string for null/undefined", () => {
		assert.equal(extractText(null), "");
		assert.equal(extractText(undefined), "");
	});

	it("returns empty string for non-object primitives", () => {
		assert.equal(extractText(42), "");
		assert.equal(extractText(true), "");
	});

	it("prefers the content field when present", () => {
		assert.equal(extractText({ content: "from content" }), "from content");
	});

	it("joins text from parts when content is absent", () => {
		const message = {
			parts: [{ text: "part one" }, { text: "part two" }],
		};
		assert.equal(extractText(message), "part one\npart two");
	});

	it("filters out empty/missing part text", () => {
		const message = {
			parts: [{ text: "kept" }, {}, { text: "" }, { text: "also kept" }],
		};
		assert.equal(extractText(message), "kept\nalso kept");
	});

	it("returns empty string when object has neither content nor parts", () => {
		assert.equal(extractText({ other: "field" }), "");
	});

	it("ignores non-string content", () => {
		assert.equal(extractText({ content: 123 }), "");
	});
});

describe("normalizeMetadata", () => {
	it("fills in defaults for missing/non-object input", () => {
		const result = normalizeMetadata(undefined);
		assert.deepEqual(result, {
			tenantContext: { userId: "", organizationId: null },
			sandboxSessionId: undefined,
			workDir: undefined,
			projectContext: undefined,
			delegationContext: undefined,
		});
	});

	it("extracts tenant context fields with type guards", () => {
		const result = normalizeMetadata({
			tenantContext: { userId: "user-1", organizationId: "org-1" },
		});
		assert.deepEqual(result.tenantContext, {
			userId: "user-1",
			organizationId: "org-1",
		});
	});

	it("falls back to empty userId and null organizationId when fields have the wrong type", () => {
		const result = normalizeMetadata({
			tenantContext: { userId: 123, organizationId: 456 },
		});
		assert.deepEqual(result.tenantContext, {
			userId: "",
			organizationId: null,
		});
	});

	it("passes through sandboxSessionId and workDir only when they are strings", () => {
		const result = normalizeMetadata({
			sandboxSessionId: "session-1",
			workDir: "/work",
		});
		assert.equal(result.sandboxSessionId, "session-1");
		assert.equal(result.workDir, "/work");

		const withWrongTypes = normalizeMetadata({
			sandboxSessionId: 1,
			workDir: 2,
		});
		assert.equal(withWrongTypes.sandboxSessionId, undefined);
		assert.equal(withWrongTypes.workDir, undefined);
	});

	it("passes through projectContext and delegationContext objects", () => {
		const result = normalizeMetadata({
			projectContext: { projectName: "p" },
			delegationContext: { agentId: "a" },
		});
		assert.deepEqual(result.projectContext, { projectName: "p" });
		assert.deepEqual(result.delegationContext, { agentId: "a" });
	});

	it("drops projectContext/delegationContext when they are not objects", () => {
		const result = normalizeMetadata({
			projectContext: "not an object",
			delegationContext: 42,
		});
		assert.equal(result.projectContext, undefined);
		assert.equal(result.delegationContext, undefined);
	});
});

describe("getVerifiedTenant", () => {
	function makeContext(getValue: unknown) {
		return { get: () => getValue } as unknown as Parameters<
			typeof getVerifiedTenant
		>[0];
	}

	it("uses the verified tenant from context when it has a userId", () => {
		const verified = { userId: "verified-user", organizationId: "org-1" };
		const bodyMetadata = normalizeMetadata({
			tenantContext: { userId: "body-user", organizationId: null },
		});
		const result = getVerifiedTenant(makeContext(verified), bodyMetadata);
		assert.deepEqual(result, verified);
	});

	it("falls back to body metadata when context has no verified tenant", () => {
		const bodyMetadata = normalizeMetadata({
			tenantContext: { userId: "body-user", organizationId: "org-2" },
		});
		const result = getVerifiedTenant(makeContext(undefined), bodyMetadata);
		assert.deepEqual(result, bodyMetadata.tenantContext);
	});

	it("falls back to body metadata when the verified tenant has an empty userId", () => {
		const bodyMetadata = normalizeMetadata({
			tenantContext: { userId: "body-user", organizationId: null },
		});
		const result = getVerifiedTenant(
			makeContext({ userId: "", organizationId: "org-x" }),
			bodyMetadata,
		);
		assert.deepEqual(result, bodyMetadata.tenantContext);
	});
});
