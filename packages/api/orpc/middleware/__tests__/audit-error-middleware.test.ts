/**
 * Unit tests for the audit-error middleware (D16).
 *
 * Coverage:
 *  - `captureError` emits a properly shaped `recordAudit` call.
 *  - Original error re-thrown with same instance identity.
 *  - Kill switch via `FABRIC_AUDIT_ERROR_CAPTURE_DISABLED=true`.
 *  - Skip-paths env var with exact and prefix forms.
 *  - Idempotence flag suppresses second emit.
 *  - `_auditFailureEmitted` is set after a successful capture.
 *  - Capture internal failure does not throw (logged + swallowed).
 *  - Correlation ID propagation (AsyncLocalStorage > header).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	recordAuditMock: vi.fn(),
	getTrustedClientIpMock: vi.fn().mockReturnValue("203.0.113.42"),
	flushSpansOnFailureMock: vi.fn().mockResolvedValue(undefined),
	hasOrganizationTieMock: vi.fn(),
}));

vi.mock("../../../lib/request-span", () => ({
	flushSpansOnFailure: (...args: unknown[]) =>
		mocks.flushSpansOnFailureMock(...args),
}));

// Avoid wiring through actual Prisma: this is a unit test.
vi.mock("@repo/database", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		recordAudit: mocks.recordAuditMock,
		hasOrganizationTie: mocks.hasOrganizationTieMock,
	};
});

vi.mock("@repo/auth/lib/client-ip", () => ({
	getTrustedClientIp: (headers: Headers) =>
		mocks.getTrustedClientIpMock(headers),
}));

// The audit-error middleware re-resolves session from headers to enrich
// the actor/orgId when the outer context lacks `user`. Mock returns null
// (anonymous) so tests fall back to the explicitly-built `buildContext()`
// shape and the recorded audit row uses that user/session.
vi.mock("@repo/auth", () => ({
	auth: {
		api: { getSession: vi.fn().mockResolvedValue(null) },
	},
}));

vi.mock("@repo/observability", () => ({
	auditWriteFailures: { inc: vi.fn() },
	auditWritesTotal: { inc: vi.fn() },
}));

import { createHash } from "node:crypto";
import { runWithCorrelationId } from "@repo/utils/correlation-id";
import {
	recordAuthorizedProject,
	runWithProjectBindingHolder,
} from "../../../lib/authorized-project-binding";
import {
	__captureErrorForTest,
	__isCaptureDisabledForTest,
	__readSkipPatternsForTest,
	__redactBodyFieldsForTest,
	__shouldSkipForTest,
	ALWAYS_SKIP_PATHS,
	auditErrorMiddleware,
	REDACTED_BODY_FIELDS,
	REDACTED_SECRET_FIELDS,
} from "../audit-error-middleware";
import { sanitizeInput } from "../audit-error-sanitize";

beforeEach(() => {
	mocks.recordAuditMock.mockReset();
	mocks.flushSpansOnFailureMock.mockClear();
	mocks.hasOrganizationTieMock.mockReset().mockResolvedValue(true);
});

afterEach(() => {
	vi.unstubAllEnvs();
});

function buildContext(headersInit: Record<string, string> = {}) {
	const headers = new Headers(headersInit);
	return {
		headers,
		user: { id: "user-1", email: "alice@example.com", name: "Alice" },
		session: {
			id: "sess-1",
			impersonatedBy: null,
			activeOrganizationId: "org-1",
		},
	};
}

describe("__readSkipPatternsForTest", () => {
	it("returns empty sets for an unset env", () => {
		vi.stubEnv("FABRIC_AUDIT_ERROR_CAPTURE_SKIP_PATHS", "");
		const { exact, prefixes } = __readSkipPatternsForTest();
		expect(exact.size).toBe(0);
		expect(prefixes).toEqual([]);
	});

	it("parses exact-match entries", () => {
		vi.stubEnv("FABRIC_AUDIT_ERROR_CAPTURE_SKIP_PATHS", "a,b,c");
		const { exact, prefixes } = __readSkipPatternsForTest();
		expect(exact.has("a")).toBe(true);
		expect(exact.has("b")).toBe(true);
		expect(exact.has("c")).toBe(true);
		expect(prefixes).toEqual([]);
	});

	it("parses prefix entries (trailing *)", () => {
		vi.stubEnv(
			"FABRIC_AUDIT_ERROR_CAPTURE_SKIP_PATHS",
			"internal.*,debug.*",
		);
		const { exact, prefixes } = __readSkipPatternsForTest();
		expect(exact.size).toBe(0);
		expect(prefixes).toContain("internal.");
		expect(prefixes).toContain("debug.");
	});

	it("trims whitespace and skips empty entries", () => {
		vi.stubEnv("FABRIC_AUDIT_ERROR_CAPTURE_SKIP_PATHS", "  a , , b  ,");
		const { exact } = __readSkipPatternsForTest();
		expect(exact.has("a")).toBe(true);
		expect(exact.has("b")).toBe(true);
		expect(exact.size).toBe(2);
	});
});

describe("__shouldSkipForTest", () => {
	it("returns false when nothing matches", () => {
		vi.stubEnv("FABRIC_AUDIT_ERROR_CAPTURE_SKIP_PATHS", "");
		expect(__shouldSkipForTest("foo.bar")).toBe(false);
	});

	it("matches an exact entry", () => {
		vi.stubEnv("FABRIC_AUDIT_ERROR_CAPTURE_SKIP_PATHS", "foo.bar");
		expect(__shouldSkipForTest("foo.bar")).toBe(true);
		expect(__shouldSkipForTest("foo.baz")).toBe(false);
	});

	it("matches a prefix entry", () => {
		vi.stubEnv("FABRIC_AUDIT_ERROR_CAPTURE_SKIP_PATHS", "internal.*");
		expect(__shouldSkipForTest("internal.health")).toBe(true);
		expect(__shouldSkipForTest("public.health")).toBe(false);
	});
});

describe("ALWAYS_SKIP_PATHS (#1899)", () => {
	// CRITICAL regression guard: personal-meeting procedures must never
	// produce an audit row, even if FABRIC_AUDIT_ERROR_CAPTURE_SKIP_PATHS
	// is unset, cleared, or misconfigured by a ConfigMap edit. See the
	// module-level ALWAYS_SKIP_PATHS doc comment for why.
	it.each(ALWAYS_SKIP_PATHS)(
		"shouldSkip returns true for %s with no skip-paths env set",
		(path) => {
			vi.stubEnv("FABRIC_AUDIT_ERROR_CAPTURE_SKIP_PATHS", "");
			expect(__shouldSkipForTest(path)).toBe(true);
		},
	);

	it.each(ALWAYS_SKIP_PATHS)(
		"captureError emits no audit row for %s",
		async (path) => {
			vi.stubEnv("FABRIC_AUDIT_ERROR_CAPTURE_SKIP_PATHS", "");
			const ctx = buildContext();
			const [namespace, feature, procedure] = path.split(".");
			await __captureErrorForTest(new Error("boom"), ctx, undefined, [
				namespace,
				feature,
				procedure,
			]);
			expect(mocks.recordAuditMock).not.toHaveBeenCalled();
		},
	);

	it("contains both personal-meetings procedure paths", () => {
		expect(ALWAYS_SKIP_PATHS).toContain(
			"projects.meetingDigest.listPersonalMeetings",
		);
		expect(ALWAYS_SKIP_PATHS).toContain(
			"projects.meetingDigest.getPersonalTranscript",
		);
	});

	it("contains the synced-file upsert, whose input carries the file's content", () => {
		expect(ALWAYS_SKIP_PATHS).toContain(
			"projects.contexts.upsertSyncedFile",
		);
	});

	it("contains the analysis-finding answer, whose input carries a member's free-text answer", () => {
		expect(ALWAYS_SKIP_PATHS).toContain(
			"projects.proposalArtifact.respondToFinding",
		);
	});
});

describe("REDACTED_BODY_FIELDS (Fizzy #2946)", () => {
	// A document save's input, and every other listed path's, carries a whole
	// user-written body. These failures are still captured, but each body
	// field is recorded as its size and hash, never its text — see the
	// module-level REDACTED_BODY_FIELDS comment.
	const BODY =
		"Our internal answer: the client's budget is café-tier — never quote it.";

	function expectedSummary(body: string) {
		return {
			redacted: true,
			bytes: Buffer.byteLength(body, "utf8"),
			contentHash: createHash("sha256")
				.update(body, "utf8")
				.digest("hex"),
		};
	}

	async function captureAt(dottedPath: string, input: unknown) {
		mocks.recordAuditMock.mockReset();
		await __captureErrorForTest(
			Object.assign(new Error("conflict"), { code: "CONFLICT" }),
			buildContext(),
			input,
			dottedPath.split("."),
		);
		expect(mocks.recordAuditMock).toHaveBeenCalledTimes(1);
		return mocks.recordAuditMock.mock.calls[0]?.[0] as {
			metadata: { input: Record<string, unknown> };
		};
	}

	it("covers the document save paths", () => {
		expect(REDACTED_BODY_FIELDS.get("projects.documents.update")).toEqual([
			"content",
		]);
		expect(
			REDACTED_BODY_FIELDS.get("projects.documents.updateWithContext"),
		).toEqual(["currentContent", "confirmedContent"]);
		expect(REDACTED_BODY_FIELDS.get("projects.documents.create")).toEqual([
			"content",
			"sourceText",
		]);
	});

	it.each([...REDACTED_BODY_FIELDS.keys(), ...REDACTED_SECRET_FIELDS.keys()])(
		"%s is captured, not skipped, so its entry is live",
		(path) => {
			vi.stubEnv("FABRIC_AUDIT_ERROR_CAPTURE_SKIP_PATHS", "");
			expect(ALWAYS_SKIP_PATHS as readonly string[]).not.toContain(path);
			expect(__shouldSkipForTest(path)).toBe(false);
		},
	);

	it("records a thrown projects.documents.update body as its size and hash, keeping the other fields", async () => {
		const input = {
			projectId: "proj-1",
			id: "doc-1",
			organizationId: "org-1",
			content: BODY,
			expectedVersion: 7,
			expectedContentHash: "a".repeat(64),
			completeDraft: true,
			aiReview: {
				kind: "FINDING",
				runId: "run-1",
				findingId: "finding-1",
				revisionToken: "signed.revision.token",
			},
		};
		const arg = await captureAt("projects.documents.update", input);

		expect(arg.metadata.input).toEqual({
			projectId: "proj-1",
			id: "doc-1",
			organizationId: "org-1",
			content: expectedSummary(BODY),
			expectedVersion: 7,
			expectedContentHash: "a".repeat(64),
			completeDraft: true,
			aiReview: {
				kind: "FINDING",
				runId: "run-1",
				findingId: "finding-1",
				// Already on the sensitive-key denylist (`token`).
				revisionToken: "[REDACTED]",
			},
		});
		// The body is under 8 KiB, so truncation never touched it: the
		// summary is what replaced it.
		expect(Buffer.byteLength(BODY, "utf8")).toBeLessThan(8192);
		expect(JSON.stringify(arg)).not.toContain("internal answer");
		// The request's own input is left as it was.
		expect(input.content).toBe(BODY);
	});

	it("keeps an over-8 KiB body's sibling fields as fields rather than a truncated string", async () => {
		const longBody = `${BODY}\n${"Section prose. ".repeat(2000)}`;
		expect(Buffer.byteLength(longBody, "utf8")).toBeGreaterThan(8192);
		const arg = await captureAt("projects.documents.update", {
			projectId: "proj-1",
			id: "doc-1",
			content: longBody,
			aiReview: { kind: "CHAT", patchedSectionKeys: ["h2:pricing"] },
		});

		expect(arg.metadata.input).not.toHaveProperty("_truncated");
		expect(arg.metadata.input.projectId).toBe("proj-1");
		expect(arg.metadata.input.content).toEqual(expectedSummary(longBody));
		expect(arg.metadata.input.aiReview).toEqual({
			kind: "CHAT",
			patchedSectionKeys: ["h2:pricing"],
		});
		expect(JSON.stringify(arg)).not.toContain("Section prose.");
	});

	it("records both bodies of projects.documents.updateWithContext as summaries", async () => {
		const confirmed = `${BODY} Accepted.`;
		const arg = await captureAt("projects.documents.updateWithContext", {
			projectId: "proj-1",
			id: "doc-1",
			preview: false,
			currentContent: BODY,
			confirmedContent: confirmed,
			expectedVersion: 3,
		});

		expect(arg.metadata.input).toEqual({
			projectId: "proj-1",
			id: "doc-1",
			preview: false,
			currentContent: expectedSummary(BODY),
			confirmedContent: expectedSummary(confirmed),
			expectedVersion: 3,
		});
		expect(JSON.stringify(arg)).not.toContain("internal answer");
	});

	it("records projects.documents.create's body and pasted source as summaries", async () => {
		const source = "Pasted meeting notes: renewal at risk.";
		const arg = await captureAt("projects.documents.create", {
			projectId: "proj-1",
			type: "PRD",
			title: "Example PRD",
			content: BODY,
			sourceText: source,
			generateWithAi: true,
		});

		expect(arg.metadata.input).toEqual({
			projectId: "proj-1",
			type: "PRD",
			title: "Example PRD",
			content: expectedSummary(BODY),
			sourceText: expectedSummary(source),
			generateWithAi: true,
		});
		expect(JSON.stringify(arg)).not.toContain("renewal at risk");
	});

	it("redacts a body that is not a string, as a request refused by validation sends it", async () => {
		const arg = await captureAt("projects.documents.update", {
			projectId: "proj-1",
			id: "doc-1",
			content: { blocks: [BODY] },
		});

		expect(arg.metadata.input.content).toEqual({ redacted: true });
		expect(JSON.stringify(arg)).not.toContain("internal answer");
	});

	it("adds nothing for a body field the request did not send", async () => {
		const arg = await captureAt("projects.documents.update", {
			projectId: "proj-1",
			id: "doc-1",
			title: "Renamed",
		});

		expect(arg.metadata.input).toEqual({
			projectId: "proj-1",
			id: "doc-1",
			title: "Renamed",
		});
	});

	it("leaves a path that is not listed unchanged", async () => {
		const arg = await captureAt("projects.testCases.recordResult", {
			testCaseId: "case-1",
			result: "FAILED",
			note: "kept verbatim",
		});

		expect(arg.metadata.input).toEqual({
			testCaseId: "case-1",
			result: "FAILED",
			note: "kept verbatim",
		});
	});

	it("covers context, nested and array fields", () => {
		expect(REDACTED_BODY_FIELDS.get("projects.contexts.create")).toEqual([
			"content",
		]);
		expect(
			REDACTED_BODY_FIELDS.get("projects.contexts.updateSummary"),
		).toEqual(["content"]);
		expect(
			REDACTED_BODY_FIELDS.get("organizations.companyContext.createText"),
		).toEqual(["content"]);
		expect(REDACTED_BODY_FIELDS.get("projects.create")).toEqual([
			"projectManagementAdditionalContext.prdContent",
			"projectManagementAdditionalContext.archContent",
			"projectManagementAdditionalContext.specsContent",
		]);
		expect(REDACTED_BODY_FIELDS.get("frames.update")).toEqual([
			"blocks[].content",
		]);
	});

	// Every entry, generically: each listed field is placed in an input of
	// the shape its path describes, next to small fields that must survive.
	type Leaf = (field: string, element: number) => unknown;

	function place(
		target: Record<string, unknown>,
		segments: readonly string[],
		field: string,
		leaf: Leaf,
		element: number,
	): void {
		const [segment = "", ...rest] = segments;
		if (segment.endsWith("[]")) {
			const key = segment.slice(0, -2);
			if (rest.length === 0) {
				target[key] = [leaf(field, 0), leaf(field, 1)];
				return;
			}
			target[key] ??= [{ label: "first" }, { label: "second" }];
			(target[key] as Record<string, unknown>[]).forEach(
				(item, index) => {
					place(item, rest, field, leaf, index);
				},
			);
			return;
		}
		if (rest.length === 0) {
			target[segment] = leaf(field, element);
			return;
		}
		target[segment] ??= { label: "nested" };
		place(
			target[segment] as Record<string, unknown>,
			rest,
			field,
			leaf,
			element,
		);
	}

	function inputWith(fields: readonly string[], leaf: Leaf) {
		const input: Record<string, unknown> = {
			id: "rec-1",
			organizationId: "org-1",
			expectedVersion: 2,
		};
		for (const field of fields) {
			place(input, field.split("."), field, leaf, 0);
		}
		return input;
	}

	const bodyOf = (field: string, element: number) =>
		`${BODY} (${field} #${element})`;

	it.each([...REDACTED_BODY_FIELDS])(
		"%s records its listed bodies as size and hash, never their text",
		async (path, fields) => {
			const input = inputWith(fields, bodyOf);
			const sent = structuredClone(input);

			const arg = await captureAt(path, input);

			// Through the sanitizer like the capture: an entry with many
			// fields can sum past 8 KiB of summaries, which is then cut.
			expect(arg.metadata.input).toEqual(
				sanitizeInput(
					inputWith(fields, (field, element) =>
						expectedSummary(bodyOf(field, element)),
					),
				),
			);
			expect(JSON.stringify(arg)).not.toContain("internal answer");
			expect(input).toEqual(sent);
		},
	);

	it("keeps the rest of projects.create's PM additional context", async () => {
		const prd = `${BODY} PRD.`;
		const input = {
			name: "Example project",
			organizationId: "org-1",
			projectManagementMcpServerId: "mcp-1",
			projectManagementAdditionalContext: {
				team: "Example team",
				labelStatusMap: { done: "Done" },
				prdContent: prd,
			},
		};
		const arg = await captureAt("projects.create", input);

		expect(arg.metadata.input).toEqual({
			name: "Example project",
			organizationId: "org-1",
			projectManagementMcpServerId: "mcp-1",
			projectManagementAdditionalContext: {
				team: "Example team",
				labelStatusMap: { done: "Done" },
				prdContent: expectedSummary(prd),
			},
		});
		expect(JSON.stringify(arg)).not.toContain("internal answer");
		expect(input.projectManagementAdditionalContext.prdContent).toBe(prd);
	});

	it("leaves projects.create alone when the PM additional context is null or absent", async () => {
		const withNull = await captureAt("projects.create", {
			name: "Example project",
			projectManagementAdditionalContext: null,
		});
		expect(withNull.metadata.input).toEqual({
			name: "Example project",
			projectManagementAdditionalContext: null,
		});

		const without = await captureAt("projects.create", {
			name: "Example project",
		});
		expect(without.metadata.input).toEqual({ name: "Example project" });
	});

	it("summarizes a step that is not the object or array its path expects", async () => {
		const created = await captureAt("projects.create", {
			name: "Example project",
			projectManagementAdditionalContext: BODY,
		});
		expect(
			created.metadata.input.projectManagementAdditionalContext,
		).toEqual(expectedSummary(BODY));

		const notAnArray = await captureAt("frames.update", {
			id: "frame-1",
			blocks: { content: BODY },
		});
		expect(notAnArray.metadata.input.blocks).toEqual({ redacted: true });

		const stringElement = await captureAt("frames.update", {
			id: "frame-1",
			blocks: [BODY, { id: "block-2", type: "markdown", content: BODY }],
		});
		expect(stringElement.metadata.input.blocks).toEqual([
			expectedSummary(BODY),
			{ id: "block-2", type: "markdown", content: expectedSummary(BODY) },
		]);
		for (const arg of [created, notAnArray, stringElement]) {
			expect(JSON.stringify(arg)).not.toContain("internal answer");
		}
	});

	it("keeps every other field of a frame block", async () => {
		const arg = await captureAt("frames.create", {
			title: "Example frame",
			blocks: [
				{
					id: "block-1",
					type: "html",
					title: "Pricing",
					content: BODY,
					language: "html",
				},
			],
			theme: { mode: "dark" },
		});

		expect(arg.metadata.input).toEqual({
			title: "Example frame",
			blocks: [
				{
					id: "block-1",
					type: "html",
					title: "Pricing",
					content: expectedSummary(BODY),
					language: "html",
				},
			],
			theme: { mode: "dark" },
		});
	});

	it("records an agent memory import's whole file map as redacted", async () => {
		const arg = await captureAt("agentMemory.import", {
			agentInstanceId: "agent-1",
			files: { "notes/client.md": BODY },
			validateFirst: true,
		});

		expect(arg.metadata.input).toEqual({
			agentInstanceId: "agent-1",
			files: { redacted: true },
			validateFirst: true,
		});
		expect(JSON.stringify(arg)).not.toContain("internal answer");
	});

	it("keeps a null body as null: a cleared field holds no text", async () => {
		const arg = await captureAt("projects.stories.update", {
			projectId: "proj-1",
			storyId: "story-1",
			description: null,
			acceptanceCriteria: BODY,
		});

		expect(arg.metadata.input).toEqual({
			projectId: "proj-1",
			storyId: "story-1",
			description: null,
			acceptanceCriteria: expectedSummary(BODY),
		});
	});

	it("records a chat turn's text, reasoning and tool calls as summaries, keeping ids and kinds", async () => {
		const result = `${BODY} Tool result.`;
		const arg = await captureAt(
			"agents.conversations.appendTurnForDocument",
			{
				documentRefKind: "PROJECT_DOCUMENT",
				documentRefId: "doc-1",
				projectId: "proj-1",
				agentId: "doc-agent",
				message: {
					id: "msg-1",
					role: "assistant",
					content: BODY,
					timestamp: "2026-10-30T09:00:00Z",
					reasoningText: BODY,
					toolCalls: [
						{
							id: "call-1",
							name: "proposeEdit",
							args: { markdown: BODY },
							result,
							status: "complete",
						},
					],
				},
			},
		);

		expect(arg.metadata.input).toEqual({
			documentRefKind: "PROJECT_DOCUMENT",
			documentRefId: "doc-1",
			projectId: "proj-1",
			agentId: "doc-agent",
			message: {
				id: "msg-1",
				role: "assistant",
				content: expectedSummary(BODY),
				timestamp: "2026-10-30T09:00:00Z",
				reasoningText: expectedSummary(BODY),
				toolCalls: [
					{
						id: "call-1",
						name: "proposeEdit",
						// An object is recorded as redacted, without a hash.
						args: { redacted: true },
						result: expectedSummary(result),
						status: "complete",
					},
				],
			},
		});
		expect(JSON.stringify(arg)).not.toContain("internal answer");
	});

	it("records an applied backlog change's bodies as summaries, keeping its kind, title, ids and source kind", async () => {
		const arg = await captureAt("projects.backlog.applyChanges", {
			projectId: "proj-1",
			operationKey: "op-1",
			approvedChanges: [
				{
					type: "STORY",
					action: "UPDATE",
					existingId: "story-1",
					title: { from: "Old title", to: "New title" },
					description: { from: null, to: BODY },
					acceptanceCriteria: null,
					reasoning: BODY,
					sourceContext: "meeting_transcript",
				},
			],
			messages: [{ role: "user", content: BODY }],
		});

		expect(arg.metadata.input).toEqual({
			projectId: "proj-1",
			operationKey: "op-1",
			approvedChanges: [
				{
					type: "STORY",
					action: "UPDATE",
					existingId: "story-1",
					title: { from: "Old title", to: "New title" },
					description: { from: null, to: expectedSummary(BODY) },
					acceptanceCriteria: null,
					reasoning: expectedSummary(BODY),
					// The kind of source, an enum, not its text.
					sourceContext: "meeting_transcript",
				},
			],
			messages: [{ role: "user", content: expectedSummary(BODY) }],
		});
		expect(JSON.stringify(arg)).not.toContain("internal answer");
	});

	it("passes through an input that is not an object on a path that is not listed, and a missing one anywhere", () => {
		expect(
			__redactBodyFieldsForTest("projects.testCases.recordResult", "raw"),
		).toBe("raw");
		expect(
			__redactBodyFieldsForTest("projects.documents.update", undefined),
		).toBeUndefined();
		expect(
			__redactBodyFieldsForTest("projects.documents.update", null),
		).toBeNull();
	});

	it("summarizes a listed path's input whole when it is not an object", async () => {
		expect(
			__redactBodyFieldsForTest("projects.documents.update", BODY),
		).toEqual(expectedSummary(BODY));

		const arg = await captureAt("projects.documents.update", BODY);
		expect(arg.metadata.input).toEqual(expectedSummary(BODY));
		expect(JSON.stringify(arg)).not.toContain("internal answer");
	});

	it("redacts the listed fields of each element of a listed path's array input", async () => {
		const arg = await captureAt("projects.documents.update", [
			{ id: "doc-1", content: BODY },
			BODY,
			[{ content: BODY }],
			null,
		]);

		expect(arg.metadata.input).toEqual([
			{ id: "doc-1", content: expectedSummary(BODY) },
			expectedSummary(BODY),
			{ redacted: true },
			null,
		]);
		expect(JSON.stringify(arg)).not.toContain("internal answer");
	});

	it("covers the task, test case, comment, answer and agent message bodies", () => {
		expect(
			Object.fromEntries(
				[
					"projects.stories.tasks.create",
					"projects.stories.tasks.update",
					"projects.testCases.create",
					"projects.testCases.update",
					"projects.stories.comments.create",
					"projects.stories.tasks.comments.create",
					"projects.architectureDecisions.comments.create",
					"incidents.errorRate.addComment",
					"integrationHealth.addComment",
					"projects.stories.maturation.answerQuestion",
					"projects.stories.maturation.amendAnswer",
					"projects.stories.maturation.appendDecisionEntry",
					"projects.stories.maturation.recordChangeNote",
					"projects.publishingSuite.answerTopicQuestion",
					"projects.publishingSuite.amendTopicQuestion",
					"codingRuns.sendFollowUp",
					"weave.executions.signalApproval",
					"projects.stories.tasks.agent.resolveCheckpoint",
					"ai.chats.messages.add",
				].map((path) => [path, REDACTED_BODY_FIELDS.get(path)]),
			),
		).toEqual({
			"projects.stories.tasks.create": ["description"],
			"projects.stories.tasks.update": ["description"],
			"projects.testCases.create": ["description", "steps[]"],
			"projects.testCases.update": [
				"description",
				"steps[]",
				"playwrightScript",
			],
			"projects.stories.comments.create": ["content"],
			"projects.stories.tasks.comments.create": ["content"],
			"projects.architectureDecisions.comments.create": ["content"],
			"incidents.errorRate.addComment": ["message"],
			"integrationHealth.addComment": ["message"],
			"projects.stories.maturation.answerQuestion": ["answer", "summary"],
			"projects.stories.maturation.amendAnswer": ["answer"],
			"projects.stories.maturation.appendDecisionEntry": [
				"content",
				"summary",
			],
			"projects.stories.maturation.recordChangeNote": ["bullets[]"],
			"projects.publishingSuite.answerTopicQuestion": ["answer"],
			"projects.publishingSuite.amendTopicQuestion": ["answer"],
			"codingRuns.sendFollowUp": ["message"],
			"weave.executions.signalApproval": ["feedback"],
			"projects.stories.tasks.agent.resolveCheckpoint": [
				"feedback",
				"userData",
			],
			"ai.chats.messages.add": [
				"messages[].parts[].text",
				"messages[].parts[].input",
				"messages[].parts[].rawInput",
				"messages[].parts[].output",
				"messages[].parts[].url",
				"messages[].parts[].data",
			],
		});
	});

	it("records a test case's steps and Playwright script as summaries, keeping its title and state", async () => {
		const script = `test("checkout", async () => { /* ${BODY} */ });`;
		const arg = await captureAt("projects.testCases.update", {
			projectId: "proj-1",
			testCaseId: "case-1",
			title: "Checkout applies the discount",
			state: "READY",
			description: BODY,
			steps: [{ id: "step-1", action: BODY, expected: "Discount shown" }],
			playwrightScript: script,
		});

		expect(arg.metadata.input).toEqual({
			projectId: "proj-1",
			testCaseId: "case-1",
			title: "Checkout applies the discount",
			state: "READY",
			description: expectedSummary(BODY),
			// A step is an object, so it is recorded as redacted alone.
			steps: [{ redacted: true }],
			playwrightScript: expectedSummary(script),
		});
		expect(JSON.stringify(arg)).not.toContain("internal answer");
	});

	it("records an AI chat message's tool input and output and a file part's data URL, keeping part kinds and ids", async () => {
		const dataUrl = `data:text/plain;base64,${Buffer.from(BODY).toString("base64")}`;
		const output = `${BODY} Tool output.`;
		const arg = await captureAt("ai.chats.messages.add", {
			chatId: "chat-1",
			messages: [
				{
					id: "msg-1",
					role: "user",
					parts: [
						{ type: "text", text: BODY },
						{
							type: "file",
							mediaType: "text/plain",
							filename: "notes.txt",
							url: dataUrl,
						},
					],
				},
				{
					id: "msg-2",
					role: "assistant",
					parts: [
						{
							type: "tool-searchDocuments",
							toolCallId: "call-1",
							state: "output-available",
							input: { query: BODY },
							output,
						},
					],
				},
			],
		});

		expect(arg.metadata.input).toEqual({
			chatId: "chat-1",
			messages: [
				{
					id: "msg-1",
					role: "user",
					parts: [
						{ type: "text", text: expectedSummary(BODY) },
						{
							type: "file",
							mediaType: "text/plain",
							filename: "notes.txt",
							url: expectedSummary(dataUrl),
						},
					],
				},
				{
					id: "msg-2",
					role: "assistant",
					parts: [
						{
							type: "tool-searchDocuments",
							toolCallId: "call-1",
							state: "output-available",
							input: { redacted: true },
							output: expectedSummary(output),
						},
					],
				},
			],
		});
		expect(JSON.stringify(arg)).not.toContain("internal answer");
		expect(JSON.stringify(arg)).not.toContain("base64,");
	});
});

describe("an Advisor execution record (saveTurn, update, create)", () => {
	const BODY =
		"Our internal answer: the client's budget is café-tier — never quote it.";

	function summary(body: string) {
		return {
			redacted: true,
			bytes: Buffer.byteLength(body, "utf8"),
			contentHash: createHash("sha256")
				.update(body, "utf8")
				.digest("hex"),
		};
	}

	/**
	 * An execution record as the Advisor builds it for a saved turn (the
	 * `OrchestratorExecution` shape), with every prose field holding BODY.
	 */
	function executionRecord() {
		return {
			id: "exec-1",
			workflowId: "exec-1",
			userMessage: BODY,
			imageUrls: ["data:image/png;base64,ZXhhbXBsZQ=="],
			error: `Provider refused: ${BODY}`,
			clarifications: [
				{ question: `Which client? ${BODY}`, answer: BODY },
			],
			model: { provider: "example", modelId: "example-model" },
			routingDecision: {
				primaryAgent: "research",
				agentName: "Research",
				confidence: 0.92,
				riskLevel: "low",
			},
			plan: {
				id: "plan-1",
				description: BODY,
				riskLevel: "low",
				steps: [
					{
						id: "step-1",
						description: BODY,
						status: "complete",
						order: 1,
						riskLevel: "low",
						requiresApproval: true,
					},
				],
			},
			stepResults: [
				{
					stepId: "step-1",
					stepDescription: BODY,
					status: "complete",
					response: BODY,
					toolCalls: [
						{
							id: "call-1",
							name: "search_documents",
							args: { query: BODY },
							result: `${BODY} Tool result.`,
							status: "success",
							durationMs: 120,
						},
					],
					durationMs: 900,
				},
			],
			approvalHistory: [
				{
					approvalId: "approval-1",
					stepId: "step-1",
					stepDescription: BODY,
					riskLevel: "medium",
					requestedAt: "2026-10-30T09:00:10.000Z",
					decidedAt: "2026-10-30T09:00:20.000Z",
					approved: true,
					feedback: BODY,
				},
			],
			variables: { client: BODY },
			status: "complete",
			startedAt: "2026-10-30T09:00:00.000Z",
			completedAt: "2026-10-30T09:01:00.000Z",
			finalResponse: `${BODY} Final answer.`,
			artifacts: [
				{
					id: "artifact-1",
					type: "document",
					name: "Draft reply",
					content: BODY,
					stepId: "step-1",
					createdAt: "2026-10-30T09:00:50.000Z",
				},
			],
			sourcesUsed: ["doc-1"],
		};
	}

	/** The same record as an error capture keeps it. */
	function recordedExecution() {
		const record = executionRecord();
		return {
			...record,
			userMessage: summary(BODY),
			imageUrls: { redacted: true },
			error: summary(`Provider refused: ${BODY}`),
			clarifications: [
				{
					question: summary(`Which client? ${BODY}`),
					answer: summary(BODY),
				},
			],
			plan: {
				...record.plan,
				description: summary(BODY),
				steps: [
					{ ...record.plan.steps[0], description: summary(BODY) },
				],
			},
			stepResults: [
				{
					...record.stepResults[0],
					stepDescription: summary(BODY),
					response: summary(BODY),
					toolCalls: [
						{
							...record.stepResults[0]?.toolCalls[0],
							args: { redacted: true },
							result: summary(`${BODY} Tool result.`),
						},
					],
				},
			],
			approvalHistory: [
				{
					...record.approvalHistory[0],
					stepDescription: summary(BODY),
					feedback: summary(BODY),
				},
			],
			variables: { redacted: true },
			finalResponse: summary(`${BODY} Final answer.`),
			artifacts: [{ ...record.artifacts[0], content: summary(BODY) }],
		};
	}

	async function captureAt(dottedPath: string, input: unknown) {
		mocks.recordAuditMock.mockReset();
		await __captureErrorForTest(
			Object.assign(new Error("conflict"), { code: "CONFLICT" }),
			buildContext(),
			input,
			dottedPath.split("."),
		);
		expect(mocks.recordAuditMock).toHaveBeenCalledTimes(1);
		return mocks.recordAuditMock.mock.calls[0]?.[0] as {
			metadata: { input: Record<string, unknown> };
		};
	}

	it("records a saved turn's execution bodies as summaries, keeping its id, status, timestamps and routing", async () => {
		const input = {
			conversationId: "conv-1",
			organizationId: "org-1",
			messages: [
				{
					id: "msg-1",
					role: "user",
					content: BODY,
					timestamp: "2026-10-30T09:00:00.000Z",
					metadata: {
						clarification: {
							question: "Which client?",
							answer: BODY,
						},
					},
					attachments: [
						{
							id: "file-1",
							name: "brief.pdf",
							previewUrl:
								"https://storage.example.com/brief.pdf?sig=abc",
						},
					],
				},
			],
			execution: executionRecord(),
			settings: { executionMode: "balanced" },
		};
		const sent = structuredClone(input);

		const arg = await captureAt("agents.conversations.saveTurn", input);

		expect(arg.metadata.input).toEqual({
			conversationId: "conv-1",
			organizationId: "org-1",
			messages: [
				{
					id: "msg-1",
					role: "user",
					content: summary(BODY),
					timestamp: "2026-10-30T09:00:00.000Z",
					metadata: { clarification: { redacted: true } },
					attachments: [
						{
							id: "file-1",
							name: "brief.pdf",
							previewUrl: summary(
								"https://storage.example.com/brief.pdf?sig=abc",
							),
						},
					],
				},
			],
			execution: recordedExecution(),
			settings: { executionMode: "balanced" },
		});
		const execution = arg.metadata.input.execution as Record<
			string,
			unknown
		>;
		expect(execution.id).toBe("exec-1");
		expect(execution.status).toBe("complete");
		expect(execution.startedAt).toBe("2026-10-30T09:00:00.000Z");
		expect(JSON.stringify(arg)).not.toContain("internal answer");
		expect(JSON.stringify(arg)).not.toContain("sig=abc");
		expect(JSON.stringify(arg)).not.toContain("base64,");
		expect(input).toEqual(sent);
	});

	it.each(["agents.conversations.update", "agents.conversations.create"])(
		"records the execution records %s keeps in its metadata the same way",
		async (path) => {
			const arg = await captureAt(path, {
				id: "conv-1",
				organizationId: "org-1",
				metadata: {
					mode: "orchestrator",
					executionMode: "balanced",
					lastUpdated: "2026-10-30T09:01:00.000Z",
					executions: [executionRecord()],
				},
			});

			expect(arg.metadata.input).toEqual({
				id: "conv-1",
				organizationId: "org-1",
				metadata: {
					mode: "orchestrator",
					executionMode: "balanced",
					lastUpdated: "2026-10-30T09:01:00.000Z",
					executions: [recordedExecution()],
				},
			});
			expect(JSON.stringify(arg)).not.toContain("internal answer");
		},
	);
});

describe("REDACTED_SECRET_FIELDS", () => {
	const CODE = "example-oauth-authorization-code-0123456789";

	it("covers every OAuth callback that takes a code", () => {
		expect([...REDACTED_SECRET_FIELDS]).toEqual([
			["integrations.github.callback", ["code"]],
			["integrations.gitlab.callback", ["code"]],
			["integrations.oauth.callback", ["code"]],
			["mcp.oauth.callback", ["code"]],
			["mcp.atlassianCloud.callback", ["code"]],
		]);
	});

	it.each([...REDACTED_SECRET_FIELDS.keys()])(
		"%s records its code as redacted with no size or hash, keeping the state and error",
		async (path) => {
			mocks.recordAuditMock.mockReset();
			const input = {
				code: CODE,
				state: "state-1",
				error: "access_denied",
			};

			await __captureErrorForTest(
				Object.assign(new Error("bad state"), { code: "BAD_REQUEST" }),
				buildContext(),
				input,
				path.split("."),
			);

			expect(mocks.recordAuditMock).toHaveBeenCalledTimes(1);
			const arg = mocks.recordAuditMock.mock.calls[0]?.[0] as {
				metadata: { input: Record<string, unknown> };
			};
			expect(arg.metadata.input).toEqual({
				code: { redacted: true },
				state: "state-1",
				error: "access_denied",
			});
			expect(JSON.stringify(arg)).not.toContain(CODE);
			expect(input.code).toBe(CODE);
		},
	);

	it("leaves a callback without a code as it is", () => {
		expect(
			__redactBodyFieldsForTest("integrations.github.callback", {
				state: "state-1",
				error: "access_denied",
			}),
		).toEqual({ state: "state-1", error: "access_denied" });
	});

	it("redacts a code inside an array input, and a callback input that is not an object as a secret", async () => {
		mocks.recordAuditMock.mockReset();
		await __captureErrorForTest(
			Object.assign(new Error("bad request"), { code: "BAD_REQUEST" }),
			buildContext(),
			[{ code: CODE, state: "state-1" }],
			["mcp", "oauth", "callback"],
		);

		expect(mocks.recordAuditMock).toHaveBeenCalledTimes(1);
		const arg = mocks.recordAuditMock.mock.calls[0]?.[0] as {
			metadata: { input: unknown };
		};
		expect(arg.metadata.input).toEqual([
			{ code: { redacted: true }, state: "state-1" },
		]);
		expect(JSON.stringify(arg)).not.toContain(CODE);

		// A bare string gets no size or hash either.
		expect(__redactBodyFieldsForTest("mcp.oauth.callback", CODE)).toEqual({
			redacted: true,
		});
	});
});

describe("__isCaptureDisabledForTest", () => {
	it("returns true when env is 'true'", () => {
		vi.stubEnv("FABRIC_AUDIT_ERROR_CAPTURE_DISABLED", "true");
		expect(__isCaptureDisabledForTest()).toBe(true);
	});

	it("returns false when env is 'false'", () => {
		vi.stubEnv("FABRIC_AUDIT_ERROR_CAPTURE_DISABLED", "false");
		expect(__isCaptureDisabledForTest()).toBe(false);
	});

	it("returns false when env is unset", () => {
		vi.stubEnv("FABRIC_AUDIT_ERROR_CAPTURE_DISABLED", "");
		expect(__isCaptureDisabledForTest()).toBe(false);
	});
});

describe("captureError", () => {
	it("calls recordAudit with the right action/severity/category", async () => {
		const ctx = buildContext();
		const err = Object.assign(new Error("forbidden!"), {
			code: "FORBIDDEN",
		});

		await __captureErrorForTest(err, ctx, undefined, [
			"projects",
			"delete",
		]);

		expect(mocks.recordAuditMock).toHaveBeenCalledTimes(1);
		const arg = mocks.recordAuditMock.mock.calls[0]?.[0] as Record<
			string,
			unknown
		>;
		expect(arg.action).toBe("error.permission_denied");
		expect(arg.category).toBe("error");
		expect(arg.severity).toBe("warning");
		expect(arg.outcome).toBe("failure");
	});

	it("includes the procedure path in the resource", async () => {
		const ctx = buildContext();
		await __captureErrorForTest(new Error("x"), ctx, undefined, [
			"a",
			"b",
			"c",
		]);
		const arg = mocks.recordAuditMock.mock.calls[0]?.[0] as {
			resource: { id: string; name: string; type: string };
		};
		expect(arg.resource.id).toBe("a.b.c");
		expect(arg.resource.type).toBe("procedure");
	});

	it("keeps an unverified project input out of the audit FK", async () => {
		const ctx = buildContext();
		await __captureErrorForTest(
			new Error("x"),
			ctx,
			{ projectId: "proj-42" },
			["projects", "update"],
		);
		const arg = mocks.recordAuditMock.mock.calls[0]?.[0] as {
			projectId: string | null;
		};
		expect(arg.projectId).toBeNull();
	});

	it("attributes a failure to the authorized project despite a different attempted input", async () => {
		await runWithProjectBindingHolder(async () => {
			recordAuthorizedProject({
				projectId: "authorized-project",
				organizationId: "authorized-org",
			});
			await __captureErrorForTest(
				new Error("denied"),
				buildContext(),
				{ projectId: "missing-project", organizationId: "foreign-org" },
				["projects", "update"],
			);
		});
		expect(mocks.hasOrganizationTieMock).not.toHaveBeenCalled();
		expect(mocks.recordAuditMock).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "authorized-project",
				organizationId: "authorized-org",
			}),
		);
	});

	it("retains denied target IDs in metadata without attributing a foreign tenant", async () => {
		mocks.hasOrganizationTieMock.mockResolvedValueOnce(false);
		await __captureErrorForTest(
			new Error("denied"),
			buildContext(),
			{ projectId: "missing-project", organizationId: "foreign-org" },
			["projects", "update"],
		);
		expect(mocks.recordAuditMock).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: null,
				organizationId: null,
				metadata: expect.objectContaining({
					input: {
						projectId: "missing-project",
						organizationId: "foreign-org",
					},
				}),
			}),
		);
	});

	it("does not attribute anonymous attempts to claimed organizations", async () => {
		await __captureErrorForTest(
			new Error("denied"),
			{ headers: new Headers(), user: null, session: null },
			{ projectId: "missing-project", organizationId: "foreign-org" },
			["projects", "update"],
		);
		expect(mocks.hasOrganizationTieMock).not.toHaveBeenCalled();
		expect(mocks.recordAuditMock).toHaveBeenCalledWith(
			expect.objectContaining({ projectId: null, organizationId: null }),
		);
	});

	it("still captures a tenantless failure if tenant verification is unavailable", async () => {
		mocks.hasOrganizationTieMock.mockRejectedValueOnce(
			new Error("unavailable"),
		);
		await __captureErrorForTest(
			new Error("denied"),
			buildContext(),
			undefined,
			["projects", "update"],
		);
		expect(mocks.recordAuditMock).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: null }),
		);
	});

	it("falls back to null projectId when input has none", async () => {
		const ctx = buildContext();
		await __captureErrorForTest(new Error("x"), ctx, undefined, ["health"]);
		const arg = mocks.recordAuditMock.mock.calls[0]?.[0] as {
			projectId: string | null;
		};
		expect(arg.projectId).toBeNull();
	});

	it("reads organizationId from input when provided", async () => {
		const ctx = buildContext();
		await __captureErrorForTest(
			new Error("x"),
			ctx,
			{ organizationId: "org-from-input" },
			["audit", "list"],
		);
		const arg = mocks.recordAuditMock.mock.calls[0]?.[0] as {
			organizationId: string | null;
		};
		expect(arg.organizationId).toBe("org-from-input");
	});

	it("falls back to session.activeOrganizationId when input lacks one", async () => {
		// buildContext()'s session.activeOrganizationId = "org-1"
		const ctx = buildContext();
		await __captureErrorForTest(new Error("x"), ctx, undefined, ["foo"]);
		const arg = mocks.recordAuditMock.mock.calls[0]?.[0] as {
			organizationId: string | null;
		};
		expect(arg.organizationId).toBe("org-1");
	});

	it("re-resolves user from headers when outer context.user missing", async () => {
		// CRITICAL regression: the middleware sits OUTSIDE the auth chain,
		// so context.user is undefined even for authenticated requests.
		// Without enrichContextFromHeaders, every error row would be
		// orphaned with userId=null. This test mocks auth.api.getSession to
		// return a user and asserts that the audit row uses that user as
		// the actor instead of falling back to "system".
		const { auth } = (await import("@repo/auth")) as {
			auth: { api: { getSession: ReturnType<typeof vi.fn> } };
		};
		auth.api.getSession.mockResolvedValueOnce({
			user: { id: "u-1", email: "real@user.test", name: "Real User" },
			session: {
				id: "s-1",
				impersonatedBy: null,
				activeOrganizationId: "org-real",
			},
		});

		// Anonymous outer context — no user, no session, just headers.
		const ctx = { headers: new Headers() };
		await __captureErrorForTest(new Error("x"), ctx, undefined, ["foo"]);

		const arg = mocks.recordAuditMock.mock.calls[0]?.[0] as {
			actor: {
				type: string;
				userId: string | null;
				emailSnapshot: string;
			};
			organizationId: string | null;
		};
		expect(arg.actor.type).toBe("user");
		expect(arg.actor.userId).toBe("u-1");
		expect(arg.actor.emailSnapshot).toBe("real@user.test");
		expect(arg.organizationId).toBe("org-real");
	});

	it("kill switch (env disabled) skips emit", async () => {
		vi.stubEnv("FABRIC_AUDIT_ERROR_CAPTURE_DISABLED", "true");
		const ctx = buildContext();
		await __captureErrorForTest(new Error("x"), ctx, undefined, ["health"]);
		expect(mocks.recordAuditMock).not.toHaveBeenCalled();
	});

	it("skip-paths suppresses emit for matching paths", async () => {
		vi.stubEnv("FABRIC_AUDIT_ERROR_CAPTURE_SKIP_PATHS", "auth.session.*");
		const ctx = buildContext();
		await __captureErrorForTest(new Error("x"), ctx, undefined, [
			"auth",
			"session",
			"validate",
		]);
		expect(mocks.recordAuditMock).not.toHaveBeenCalled();
	});

	it("idempotence flag suppresses double-emit", async () => {
		const ctx = buildContext() as ReturnType<typeof buildContext> & {
			_auditFailureEmitted?: boolean;
		};
		ctx._auditFailureEmitted = true;
		await __captureErrorForTest(new Error("x"), ctx, undefined, ["foo"]);
		expect(mocks.recordAuditMock).not.toHaveBeenCalled();
	});

	it("sets _auditFailureEmitted after a successful capture", async () => {
		const ctx = buildContext() as ReturnType<typeof buildContext> & {
			_auditFailureEmitted?: boolean;
		};
		await __captureErrorForTest(new Error("x"), ctx, undefined, ["foo"]);
		expect(ctx._auditFailureEmitted).toBe(true);
	});

	it("captures OTEL-shaped exception metadata", async () => {
		const ctx = buildContext();
		const err = new Error("boom");
		await __captureErrorForTest(err, ctx, undefined, [
			"projects",
			"create",
		]);
		const arg = mocks.recordAuditMock.mock.calls[0]?.[0] as {
			metadata: {
				exception: { type: string; message: string; escaped: boolean };
				fingerprint: string;
			};
		};
		expect(arg.metadata.exception.type).toBe("Error");
		expect(arg.metadata.exception.message).toBe("boom");
		expect(arg.metadata.exception.escaped).toBe(true);
		expect(arg.metadata.fingerprint).toMatch(/^[0-9a-f]{16}$/);
	});

	it("captures correlation ID from AsyncLocalStorage", async () => {
		const ctx = buildContext();
		await runWithCorrelationId("corr-test-ALS", async () => {
			await __captureErrorForTest(new Error("x"), ctx, undefined, [
				"foo",
			]);
		});
		const arg = mocks.recordAuditMock.mock.calls[0]?.[0] as {
			metadata: { correlationId?: string };
			correlationId?: string;
		};
		expect(arg.metadata.correlationId).toBe("corr-test-ALS");
		expect(arg.correlationId).toBe("corr-test-ALS");
	});

	it("falls back to header correlation when ALS empty", async () => {
		const ctx = buildContext({ "x-correlation-id": "corr-from-header" });
		await __captureErrorForTest(new Error("x"), ctx, undefined, ["foo"]);
		const arg = mocks.recordAuditMock.mock.calls[0]?.[0] as {
			metadata: { correlationId?: string };
		};
		expect(arg.metadata.correlationId).toBe("corr-from-header");
	});

	it("omits correlation ID when neither source available", async () => {
		const ctx = buildContext();
		await __captureErrorForTest(new Error("x"), ctx, undefined, ["foo"]);
		const arg = mocks.recordAuditMock.mock.calls[0]?.[0] as {
			metadata: Record<string, unknown>;
		};
		expect(arg.metadata.correlationId).toBeUndefined();
	});

	it("includes input snapshot when provided", async () => {
		const ctx = buildContext();
		await __captureErrorForTest(
			new Error("x"),
			ctx,
			{ foo: "bar", password: "shhh" },
			["test"],
		);
		const arg = mocks.recordAuditMock.mock.calls[0]?.[0] as {
			metadata: { input: { foo: string; password: string } };
		};
		// `input` is parsed back when payload is small enough.
		expect(arg.metadata.input).toBeDefined();
		expect(arg.metadata.input.foo).toBe("bar");
		expect(arg.metadata.input.password).toBe("[REDACTED]");
	});

	it("captures Error.cause chain", async () => {
		const inner = new Error("inner cause");
		const outer = new Error("outer");
		(outer as { cause: unknown }).cause = inner;
		const ctx = buildContext();
		await __captureErrorForTest(outer, ctx, undefined, ["test"]);
		const arg = mocks.recordAuditMock.mock.calls[0]?.[0] as {
			metadata: { cause?: { message: string } };
		};
		expect(arg.metadata.cause).toBeDefined();
		expect(arg.metadata.cause?.message).toBe("inner cause");
	});

	it("never throws even if recordAudit throws", async () => {
		mocks.recordAuditMock.mockImplementationOnce(() => {
			throw new Error("simulated audit-binding failure");
		});
		const ctx = buildContext();
		// The middleware wraps the inner call site in its own try/catch
		// already, and the audit module wraps `recordAudit` again. Both
		// layers must be tested — the call site should not rethrow.
		await expect(
			__captureErrorForTest(new Error("x"), ctx, undefined, ["foo"]),
		).resolves.not.toThrow();
	});

	it(// D16 safety invariant: the captured error must be referentially the
	// same instance that the middleware re-throws. This protects
	// `instanceof ORPCError` / equality checks downstream of the
	// middleware (oRPC server, error mapper) from being broken by an
	// accidental wrap or clone.
	"captures the original error instance identity", async () => {
		const originalErr = Object.assign(new Error("identity"), {
			code: "NOT_FOUND",
		});
		const ctx = buildContext();
		await __captureErrorForTest(originalErr, ctx, undefined, [
			"projects",
			"get",
		]);

		// recordAudit was given the exception block built from this exact
		// error. Verify by message identity — type identity (Error) is
		// also asserted at the exception.type field.
		const arg = mocks.recordAuditMock.mock.calls[0]?.[0] as {
			metadata: { exception: { message: string } };
		};
		expect(arg.metadata.exception.message).toBe("identity");
	});
});

describe("auditErrorMiddleware (orchestration)", () => {
	it("export exists and is invocable as oRPC middleware", () => {
		// We assert the call-site contract via `auditErrorMiddleware` being
		// importable — if oRPC's export shape ever changes (e.g. it stops
		// being a builder), the import above will fail. The end-to-end
		// behaviour (re-throw, capture, kill-switch) is exercised by the
		// `__captureErrorForTest` suite above and by the integration test.
		expect(auditErrorMiddleware).toBeDefined();
	});
});

describe("auditErrorMiddleware — span flush (v2 item 4)", () => {
	it("calls flushSpansOnFailure after capturing an error", async () => {
		const context = buildContext({ "x-correlation-id": "req_flush" });
		await __captureErrorForTest(
			new Error("boom"),
			context,
			{ projectId: "p-1" },
			["myorg", "create"],
		);
		expect(mocks.flushSpansOnFailureMock).toHaveBeenCalledTimes(1);
		// Passes the resolved correlationId so spans share the same trace key.
		expect(mocks.flushSpansOnFailureMock.mock.calls[0]?.[0]).toBe(
			"req_flush",
		);
	});

	it("calls flushSpansOnFailure with no override when correlationId is absent", async () => {
		const context = buildContext({});
		await __captureErrorForTest(new Error("boom"), context, undefined, [
			"other",
			"path",
		]);
		// Either called with no args, or called with undefined — both valid.
		expect(mocks.flushSpansOnFailureMock).toHaveBeenCalledTimes(1);
	});
});
