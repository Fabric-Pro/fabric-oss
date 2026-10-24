// @vitest-environment node
/**
 * The web relay for worker realtime events (Fizzy #2946): a worker without
 * Upstash POSTs each event here with the service secret, and the route
 * publishes it on the web's Realtime client. The publish itself
 * (`publishRelayedEvent`) is covered in `packages/api/lib/__tests__`, where
 * `@upstash/realtime` can be mocked; here it is the seam.
 *
 * The secret is shared by every internal caller, so the route also checks
 * the event's target against the database before publishing. `@repo/database`
 * is a small in-memory stand-in that answers the route's queries from the rows
 * each test sets up.
 */

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = { id: string; projectId: string };
type Where = {
	id: string;
	projectId?: string;
	NOT?: { projectId: string };
	messages?: { array_contains: Array<{ id: string }> };
};

const mocks = vi.hoisted(() => {
	const store = {
		projects: new Set<string>(),
		documents: [] as Row[],
		contexts: [] as Row[],
		contextSyncs: [] as Row[],
		conversations: [] as Array<{ id: string; messageIds: string[] }>,
		users: new Map<string, string | null>(),
		/** `${projectId}:${userId}` pairs `hasProjectAccess` answers true for. */
		access: new Set<string>(),
	};
	function rowsMatching(rows: () => Row[]) {
		return vi.fn(
			async ({ where }: { where: Where }) =>
				rows().find(
					(row) =>
						row.id === where.id &&
						(where.projectId === undefined ||
							row.projectId === where.projectId) &&
						(where.NOT === undefined ||
							row.projectId !== where.NOT.projectId),
				) ?? null,
		);
	}
	return {
		publish: vi.fn(),
		store,
		project: vi.fn(async ({ where }: { where: { id: string } }) =>
			store.projects.has(where.id) ? { id: where.id } : null,
		),
		document: rowsMatching(() => store.documents),
		context: rowsMatching(() => store.contexts),
		contextSync: rowsMatching(() => store.contextSyncs),
		conversation: vi.fn(async ({ where }: { where: Where }) => {
			const messageId = where.messages?.array_contains[0]?.id;
			const conversation = store.conversations.find(
				(row) =>
					row.id === where.id &&
					messageId !== undefined &&
					row.messageIds.includes(messageId),
			);
			return conversation ? { id: conversation.id } : null;
		}),
		hasProjectAccess: vi.fn(async (projectId: string, userId: string) =>
			store.access.has(`${projectId}:${userId}`),
		),
		getUserById: vi.fn(async (id: string) =>
			store.users.has(id) ? { id, name: store.users.get(id) } : null,
		),
	};
});

vi.mock("@repo/api/lib/realtime", () => ({
	publishRelayedEvent: (...args: unknown[]) => mocks.publish(...args),
}));

vi.mock("@repo/database", () => ({
	db: {
		project: { findUnique: mocks.project },
		projectDocument: { findFirst: mocks.document },
		projectContext: { findFirst: mocks.context },
		projectContextRepositorySync: { findFirst: mocks.contextSync },
		agentConversation: { findFirst: mocks.conversation },
	},
	hasProjectAccess: mocks.hasProjectAccess,
	getUserById: mocks.getUserById,
}));

import { POST } from "../route";

const SECRET = "synthetic-service-secret";
const URL = "https://app.example.com/api/internal/realtime-emit";

const documentChange = {
	projectId: "proj-1",
	documentId: "doc-1",
	action: "updated",
	userId: "user-1",
	userName: "Fabric",
};

const relayedDocumentChange = {
	channel: "project",
	id: "proj-1",
	event: "document_change",
	data: documentChange,
};

const messageAppended = {
	conversationId: "conv-1",
	messageId: "msg-1",
	appendedAt: "2026-10-23T10:00:00.000Z",
};

const relayedMessage = {
	channel: "conversation",
	id: "conv-1",
	event: "message_appended",
	data: messageAppended,
};

function contextChange(overrides: Record<string, unknown> = {}) {
	const data = {
		projectId: "proj-1",
		contextId: "ctx-1",
		action: "updated",
		userId: "user-1",
		userName: "Example Dev",
		contextType: "TEXT",
		...overrides,
	};
	return {
		channel: "project",
		id: data.projectId,
		event: "context_change",
		data,
	};
}

function activity(overrides: Record<string, unknown> = {}) {
	const data = {
		projectId: "proj-1",
		userId: "user-1",
		userName: "Example Dev",
		activityType: "context_deleted",
		resourceType: "context",
		resourceId: "ctx-gone",
		resourceName: "notes/glossary.md",
		timestamp: "2026-10-23T10:00:00.000Z",
		...overrides,
	};
	return { channel: "project", id: data.projectId, event: "activity", data };
}

function request(
	body: unknown,
	headers: Record<string, string> = { "X-Agent-Service-Token": SECRET },
) {
	return new NextRequest(URL, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.publish.mockResolvedValue(true);
	vi.stubEnv("AGENT_SERVICE_SECRET", SECRET);
	const { store } = mocks;
	store.projects = new Set(["proj-1", "proj-2"]);
	store.documents = [
		{ id: "doc-1", projectId: "proj-1" },
		{ id: "doc-2", projectId: "proj-2" },
	];
	store.contexts = [
		{ id: "ctx-1", projectId: "proj-1" },
		{ id: "ctx-2", projectId: "proj-2" },
	];
	store.contextSyncs = [{ id: "sync-1", projectId: "proj-1" }];
	store.conversations = [{ id: "conv-1", messageIds: ["msg-0", "msg-1"] }];
	store.users = new Map([["user-1", "Example Dev"]]);
	store.access = new Set(["proj-1:user-1"]);
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("POST /api/internal/realtime-emit", () => {
	it("refuses a caller without the service token", async () => {
		const response = await POST(request(relayedDocumentChange, {}));

		expect(response.status).toBe(401);
		expect(mocks.publish).not.toHaveBeenCalled();
	});

	it("refuses a wrong service token", async () => {
		const response = await POST(
			request(relayedDocumentChange, {
				"X-Agent-Service-Token": "not-the-secret",
			}),
		);

		expect(response.status).toBe(401);
		expect(mocks.publish).not.toHaveBeenCalled();
	});

	it("refuses everything when the secret is not configured", async () => {
		vi.stubEnv("AGENT_SERVICE_SECRET", undefined);

		const response = await POST(request(relayedDocumentChange));

		expect(response.status).toBe(401);
		expect(mocks.publish).not.toHaveBeenCalled();
	});

	it("publishes a valid event once, with the validated payload", async () => {
		const response = await POST(
			request({
				...relayedDocumentChange,
				data: { ...documentChange, injected: "not in the schema" },
			}),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
		expect(mocks.publish).toHaveBeenCalledTimes(1);
		expect(mocks.publish).toHaveBeenCalledWith({
			channel: "project",
			id: "proj-1",
			event: "document_change",
			data: documentChange,
		});
	});

	it("publishes a conversation's message_appended", async () => {
		const response = await POST(request(relayedMessage));

		expect(response.status).toBe(200);
		expect(mocks.publish).toHaveBeenCalledWith(relayedMessage);
	});

	it.each([
		[
			"an event the worker does not publish",
			{ ...relayedDocumentChange, event: "presence_update" },
		],
		[
			"data the event's schema rejects",
			{
				...relayedDocumentChange,
				data: { ...documentChange, action: "generating" },
			},
		],
		[
			"an id that is not the payload's project",
			{ ...relayedDocumentChange, id: "proj-2" },
		],
		[
			"a project event on a conversation channel",
			{ ...relayedDocumentChange, channel: "conversation" },
		],
		["a body that is not JSON", "{not json"],
	])("rejects %s with 400", async (_label, body) => {
		const response = await POST(request(body));

		expect(response.status).toBe(400);
		expect(mocks.publish).not.toHaveBeenCalled();
	});

	it("rejects a declared oversized body with 413", async () => {
		const response = await POST(
			request({
				...relayedDocumentChange,
				data: { ...documentChange, documentTitle: "x".repeat(20_000) },
			}),
		);

		expect(response.status).toBe(413);
		expect(mocks.publish).not.toHaveBeenCalled();
	});

	it("stops reading a chunked body without a length as soon as it passes the cap", async () => {
		let pulls = 0;
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulls++;
				if (pulls > 64) {
					controller.close();
					return;
				}
				controller.enqueue(new Uint8Array(4096).fill(0x20));
			},
			cancel() {
				cancelled = true;
			},
		});
		const init = {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"X-Agent-Service-Token": SECRET,
			},
			body,
			duplex: "half",
		};

		const response = await POST(
			new NextRequest(
				URL,
				init as ConstructorParameters<typeof NextRequest>[1],
			),
		);

		expect(response.status).toBe(413);
		expect(cancelled).toBe(true);
		expect(pulls).toBeLessThan(16);
		expect(mocks.publish).not.toHaveBeenCalled();
	});

	it("answers 503 when the web has no realtime client", async () => {
		mocks.publish.mockResolvedValue(false);

		const response = await POST(request(relayedDocumentChange));

		expect(response.status).toBe(503);
	});

	it("answers 502 when the publish fails, logging neither the payload nor the secret", async () => {
		const errorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		mocks.publish.mockRejectedValue(new Error("Redis down"));

		const response = await POST(request(relayedDocumentChange));

		expect(response.status).toBe(502);
		const logged = JSON.stringify(errorSpy.mock.calls);
		expect(logged).toContain("document_change");
		expect(logged).not.toContain(SECRET);
		expect(logged).not.toContain("doc-1");
		expect(logged).not.toContain("Fabric");
	});
});

/**
 * The shared secret lets any internal caller reach this route, so the target
 * is checked against the database first: an event can only name rows of the
 * project or conversation it is published on. Every refusal reads the same.
 */
describe("target checks", () => {
	async function refused(body: unknown) {
		const publishedBefore = mocks.publish.mock.calls.length;
		const response = await POST(request(body));
		expect(response.status).toBe(404);
		expect(mocks.publish).toHaveBeenCalledTimes(publishedBefore);
		return response.json();
	}

	it("refuses an unknown project, a deletion naming a gone row included", async () => {
		await refused({
			...relayedDocumentChange,
			id: "proj-x",
			data: { ...documentChange, projectId: "proj-x" },
		});
		await refused(
			contextChange({
				projectId: "proj-x",
				contextId: "ctx-gone",
				action: "deleted",
			}),
		);
	});

	it("refuses a document of another project, asking for it in the named one", async () => {
		await refused({
			...relayedDocumentChange,
			data: { ...documentChange, documentId: "doc-2" },
		});

		expect(mocks.document).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "doc-2", projectId: "proj-1" },
			}),
		);
	});

	it("refuses an unknown conversation, and a message the conversation does not hold", async () => {
		await refused({
			...relayedMessage,
			id: "conv-x",
			data: { ...messageAppended, conversationId: "conv-x" },
		});
		await refused({
			...relayedMessage,
			data: { ...messageAppended, messageId: "msg-9" },
		});

		expect(mocks.conversation).toHaveBeenLastCalledWith(
			expect.objectContaining({
				where: {
					id: "conv-1",
					messages: { array_contains: [{ id: "msg-9" }] },
				},
			}),
		);
	});

	it("reads every refusal the same, whatever failed", async () => {
		const unknownProject = await refused({
			...relayedDocumentChange,
			id: "proj-x",
			data: { ...documentChange, projectId: "proj-x" },
		});
		const foreignDocument = await refused({
			...relayedDocumentChange,
			data: { ...documentChange, documentId: "doc-2" },
		});
		const unknownMessage = await refused({
			...relayedMessage,
			data: { ...messageAppended, messageId: "msg-9" },
		});

		expect(foreignDocument).toEqual(unknownProject);
		expect(unknownMessage).toEqual(unknownProject);
	});

	it("publishes a context change for a context or the repository sync of the project", async () => {
		expect((await POST(request(contextChange()))).status).toBe(200);
		expect(
			(await POST(request(contextChange({ contextId: "sync-1" }))))
				.status,
		).toBe(200);
		expect(mocks.publish).toHaveBeenCalledTimes(2);
	});

	it("refuses a context change naming another project's context", async () => {
		await refused(contextChange({ contextId: "ctx-2" }));
	});

	it("publishes a deletion whose context is already gone, but not one naming another project's live context", async () => {
		expect(
			(
				await POST(
					request(
						contextChange({
							contextId: "ctx-gone",
							action: "deleted",
						}),
					),
				)
			).status,
		).toBe(200);

		await refused(contextChange({ contextId: "ctx-2", action: "deleted" }));
		expect(mocks.context).toHaveBeenLastCalledWith(
			expect.objectContaining({
				where: { id: "ctx-2", NOT: { projectId: "proj-1" } },
			}),
		);
	});

	it("publishes an activity with the user's own name from the database", async () => {
		const response = await POST(
			request(activity({ userName: "Someone Else" })),
		);

		expect(response.status).toBe(200);
		expect(mocks.publish).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "activity",
				data: expect.objectContaining({ userName: "Example Dev" }),
			}),
		);
	});

	it("refuses an activity by a user without access to the project", async () => {
		mocks.store.users.set("user-2", "Another Dev");

		await refused(activity({ userId: "user-2" }));
	});

	it("refuses an activity naming another project's resource", async () => {
		await refused(activity({ resourceId: "ctx-2" }));
	});
});

describe("text checks", () => {
	async function rejected(body: unknown) {
		const response = await POST(request(body));
		expect(response.status).toBe(400);
		expect(mocks.publish).not.toHaveBeenCalled();
	}

	it.each([
		["a control character in a name", { resourceName: "notes\u0007.md" }],
		["a line break in a name", { resourceName: "notes\n.md" }],
		["an oversized name", { resourceName: "x".repeat(600) }],
		[
			"an activity type that is not a plain identifier",
			{ activityType: "Deleted <b>it</b>" },
		],
		[
			"a resource type the worker does not publish",
			{ resourceType: "invoice" },
		],
		["a timestamp that is not a date", { timestamp: "yesterday" }],
	])("refuses an activity with %s", async (_label, overrides) => {
		await rejected(activity(overrides));
	});

	it("refuses a control character in a context change's name", async () => {
		await rejected(contextChange({ contextName: "glossary\u001b[31m.md" }));
	});
});
