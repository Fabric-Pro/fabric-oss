import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	FRAME_RUNTIME_HELLO_TYPE,
	FRAME_RUNTIME_HOST_READY_TYPE,
} from "../frame-embed-protocol";
import {
	FABRIC_RUNTIME_CALL_TIMEOUT_MS,
	FABRIC_RUNTIME_SCRIPT,
} from "../fabric-runtime-script";

/**
 * The page runtime runs inside the sandboxed document, so it is exercised the
 * way the document runs it: the script is evaluated against a stand-in window
 * whose parent records what is posted and whose message listener the test can
 * drive. What it must never do is believe an answer from anyone but its parent.
 *
 * A request is held until the parent has said it is listening, so most cases
 * start from a page whose parent already has (`hostReady`, the default); the
 * cases about the handshake itself start from one that has not.
 */

interface Posted {
	message: Record<string, unknown>;
	targetOrigin: string;
}

type Listener = (event: { source: unknown; data: unknown }) => void;

type Later = (...args: unknown[]) => Promise<unknown>;

interface PageFabric {
	call: (name: unknown, args?: unknown) => Promise<unknown>;
	openAgent: (prompt: unknown) => void;
	navigate: (path: unknown) => void;
	viewer: Later;
	data: { list: Later; get: Later; set: Later; delete: Later };
	ask: Later;
	files: { upload: Later; list: Later; read: Later; delete: Later };
	download: Later;
	connected: Later;
}

const HOST_READY = { type: FRAME_RUNTIME_HOST_READY_TYPE };

function runInPage(options: { failPost?: boolean; hostReady?: boolean } = {}) {
	const { hostReady = true } = options;
	const posted: Posted[] = [];
	const hellos: Posted[] = [];
	const listeners: Listener[] = [];
	const parent = {
		postMessage: (
			message: Record<string, unknown>,
			targetOrigin: string,
		) => {
			if (options.failPost) {
				throw new Error("DataCloneError");
			}
			(message.type === FRAME_RUNTIME_HELLO_TYPE ? hellos : posted).push({
				message,
				targetOrigin,
			});
		},
	};
	const page: Record<string, unknown> & { fabric?: PageFabric } = {
		parent,
		addEventListener: (type: string, listener: Listener) => {
			if (type === "message") {
				listeners.push(listener);
			}
		},
	};
	new Function("window", FABRIC_RUNTIME_SCRIPT)(page);
	const fabric = page.fabric;
	if (!fabric) {
		throw new Error("the runtime did not define window.fabric");
	}
	const deliver = (data: unknown, source: unknown = parent) => {
		for (const listener of listeners) {
			listener({ source, data });
		}
	};
	if (hostReady) {
		deliver(HOST_READY);
	}
	return { page, fabric, posted, hellos, parent, deliver };
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("window.fabric.call", () => {
	it("asks the parent to run the tool and resolves with the result it sends back", async () => {
		const { fabric, posted, deliver } = runInPage();

		const result = fabric.call("fabric_list_workflows", { limit: 2 });

		expect(posted).toHaveLength(1);
		expect(posted[0].message).toEqual({
			type: "fabric-frame:call",
			requestId: expect.any(String),
			name: "fabric_list_workflows",
			args: { limit: 2 },
		});
		deliver({
			type: "fabric-frame:call-result",
			requestId: posted[0].message.requestId,
			ok: true,
			result: { workflows: [] },
		});
		await expect(result).resolves.toEqual({ workflows: [] });
	});

	it("rejects with the reason the parent gives", async () => {
		const { fabric, posted, deliver } = runInPage();

		const result = fabric.call("fabric_execute_workflow");
		deliver({
			type: "fabric-frame:call-result",
			requestId: posted[0].message.requestId,
			ok: false,
			error: "The viewer did not allow fabric_execute_workflow.",
		});

		await expect(result).rejects.toThrow(
			"The viewer did not allow fabric_execute_workflow.",
		);
	});

	it("sends an empty argument object when none is given", () => {
		const { fabric, posted } = runInPage();

		void fabric.call("fabric_list_workflows");
		void fabric.call("fabric_list_workflows", null);

		expect(posted.map((entry) => entry.message.args)).toEqual([{}, {}]);
	});

	it("keeps concurrent calls apart", async () => {
		const { fabric, posted, deliver } = runInPage();

		const first = fabric.call("fabric_list_workflows");
		const second = fabric.call("fabric_get_frame");
		const [one, two] = posted.map((entry) => entry.message.requestId);
		expect(one).not.toBe(two);

		deliver({
			type: "fabric-frame:call-result",
			requestId: two,
			ok: true,
			result: "second",
		});
		deliver({
			type: "fabric-frame:call-result",
			requestId: one,
			ok: true,
			result: "first",
		});

		await expect(first).resolves.toBe("first");
		await expect(second).resolves.toBe("second");
	});

	it("does not believe an answer from any window but its parent", async () => {
		const { fabric, posted, deliver } = runInPage();

		const result = fabric.call("fabric_list_workflows");
		deliver(
			{
				type: "fabric-frame:call-result",
				requestId: posted[0].message.requestId,
				ok: true,
				result: "forged",
			},
			{ not: "the parent" },
		);
		deliver({
			type: "fabric-frame:call-result",
			requestId: posted[0].message.requestId,
			ok: true,
			result: "genuine",
		});

		await expect(result).resolves.toBe("genuine");
	});

	it("ignores answers it did not ask for and answers it has already used", async () => {
		const { fabric, posted, deliver } = runInPage();

		const result = fabric.call("fabric_list_workflows");
		const requestId = posted[0].message.requestId;
		deliver({
			type: "fabric-frame:call-result",
			requestId: "call-999",
			ok: true,
			result: "stray",
		});
		deliver({
			type: "fabric-frame:call-result",
			requestId,
			ok: true,
			result: "once",
		});
		deliver({
			type: "fabric-frame:call-result",
			requestId,
			ok: true,
			result: "twice",
		});
		deliver(null);
		deliver({ type: "something-else", requestId });

		await expect(result).resolves.toBe("once");
	});

	it("rejects a call without a tool name or with arguments that are not an object", async () => {
		const { fabric, posted } = runInPage();

		await expect(fabric.call("")).rejects.toThrow("tool name");
		await expect(fabric.call(42)).rejects.toThrow("tool name");
		await expect(fabric.call("fabric_get_frame", "x")).rejects.toThrow(
			"must be an object",
		);
		await expect(fabric.call("fabric_get_frame", [1])).rejects.toThrow(
			"must be an object",
		);
		expect(posted).toEqual([]);
	});

	it("rejects at once when the arguments cannot be sent", async () => {
		const { fabric } = runInPage({ failPost: true });

		await expect(
			fabric.call("fabric_get_frame", { id: "f1" }),
		).rejects.toThrow("cannot be sent");
	});

	it("gives up waiting when the host never answers", async () => {
		const { fabric } = runInPage();

		const result = fabric.call("fabric_list_workflows");
		const settled = expect(result).rejects.toThrow("did not answer");
		await vi.advanceTimersByTimeAsync(FABRIC_RUNTIME_CALL_TIMEOUT_MS);

		await settled;
	});
});

describe("window.fabric helpers", () => {
	it("asks the parent to open Fabric Agent with the prompt", () => {
		const { fabric, posted } = runInPage();

		fabric.openAgent("Explain this chart");

		expect(posted[0]).toEqual({
			message: {
				type: "fabric-frame:open-agent",
				prompt: "Explain this chart",
			},
			targetOrigin: "*",
		});
	});

	it("asks the parent to navigate", () => {
		const { fabric, posted } = runInPage();

		fabric.navigate("/app/example-org/projects");

		expect(posted[0].message).toEqual({
			type: "fabric-frame:navigate",
			path: "/app/example-org/projects",
		});
	});

	it("sends strings whatever it is handed", () => {
		const { fabric, posted } = runInPage();

		fabric.openAgent(undefined);
		fabric.navigate({ toString: () => "/app/x" });

		expect(posted.map((entry) => entry.message)).toEqual([
			{ type: "fabric-frame:open-agent", prompt: "undefined" },
			{ type: "fabric-frame:navigate", path: "/app/x" },
		]);
	});
});

describe("the runtime object", () => {
	it("is fixed on the window, so a later script cannot swap it", () => {
		const { page, fabric } = runInPage();

		expect(Object.isFrozen(fabric)).toBe(true);
		expect(
			Object.getOwnPropertyDescriptor(page, "fabric")?.configurable,
		).toBe(false);
		expect(() => {
			page.fabric = { ...fabric, call: async () => "swapped" };
		}).toThrow();
		expect(page.fabric).toBe(fabric);
	});

	it("freezes the groups of functions as well, so none of them can be replaced", () => {
		const { fabric } = runInPage();

		expect(Object.isFrozen(fabric.data)).toBe(true);
		expect(Object.isFrozen(fabric.files)).toBe(true);
		expect(Object.keys(fabric).sort()).toEqual([
			"ask",
			"call",
			"connected",
			"data",
			"download",
			"files",
			"navigate",
			"openAgent",
			"viewer",
		]);
	});
});

describe("what the helpers ask the host to run", () => {
	/** The call a helper posted last, and a way to answer it. */
	function lastCall(h: ReturnType<typeof runInPage>) {
		const message = h.posted.at(-1)?.message ?? {};
		return {
			name: message.name,
			args: message.args,
			answer: (result: unknown) =>
				h.deliver({
					type: "fabric-frame:call-result",
					requestId: message.requestId,
					ok: true,
					result,
				}),
		};
	}

	it("asks who is viewing with fabric.viewer, which resolves with what the tool returns", async () => {
		const h = runInPage();

		const result = h.fabric.viewer();
		const sent = lastCall(h);
		sent.answer({ id: "u1", name: "Sam Example", isOwner: false });

		expect(sent.name).toBe("fabric_get_page_viewer");
		expect(sent.args).toEqual({});
		await expect(result).resolves.toEqual({
			id: "u1",
			name: "Sam Example",
			isOwner: false,
		});
	});

	describe("fabric.data", () => {
		it("lists a collection with the options it was given and none it was not", () => {
			const h = runInPage();

			void h.fabric.data.list("votes", { scope: "mine", limit: 20 });

			expect(lastCall(h)).toMatchObject({
				name: "fabric_page_data_list",
				args: { collection: "votes", scope: "mine", limit: 20 },
			});
			expect(Object.keys(lastCall(h).args as object).sort()).toEqual([
				"collection",
				"limit",
				"scope",
			]);
		});

		it("lists with just a collection", () => {
			const h = runInPage();

			void h.fabric.data.list("votes");

			expect(lastCall(h).args).toEqual({ collection: "votes" });
		});

		it("gets one record, in its scope", () => {
			const h = runInPage();

			void h.fabric.data.get("votes", "@me", { scope: "mine" });

			expect(lastCall(h)).toMatchObject({
				name: "fabric_page_data_get",
				args: { collection: "votes", key: "@me", scope: "mine" },
			});
		});

		it("sets one record as a list of one, and a list as it is", () => {
			const h = runInPage();

			void h.fabric.data.set("votes", {
				key: "@me",
				value: { pick: "a" },
			});
			const single = lastCall(h).args;
			void h.fabric.data.set("votes", [
				{ key: "a", value: 1, expectedVersion: 2 },
				{ key: "b", value: 2 },
			]);
			const several = lastCall(h).args;

			expect(single).toEqual({
				collection: "votes",
				records: [{ key: "@me", value: { pick: "a" } }],
			});
			expect(several).toEqual({
				collection: "votes",
				records: [
					{ key: "a", value: 1, expectedVersion: 2 },
					{ key: "b", value: 2 },
				],
			});
			expect(lastCall(h).name).toBe("fabric_page_data_set");
		});

		it("deletes one key or several", () => {
			const h = runInPage();

			void h.fabric.data.delete("votes", "a");
			const one = lastCall(h).args;
			void h.fabric.data.delete("votes", ["a", "b"]);

			expect(one).toEqual({ collection: "votes", keys: ["a"] });
			expect(lastCall(h)).toMatchObject({
				name: "fabric_page_data_delete",
				args: { collection: "votes", keys: ["a", "b"] },
			});
		});

		it("rejects, and sends nothing, when what it needs is missing", async () => {
			const h = runInPage();

			await expect(h.fabric.data.list("")).rejects.toThrow("collection");
			await expect(h.fabric.data.get("votes")).rejects.toThrow("key");
			await expect(h.fabric.data.set("votes")).rejects.toThrow("record");
			await expect(h.fabric.data.set("votes", null)).rejects.toThrow(
				"record",
			);
			await expect(h.fabric.data.delete("votes")).rejects.toThrow("key");
			await expect(h.fabric.data.delete(7)).rejects.toThrow("collection");
			expect(h.posted).toEqual([]);
		});
	});

	describe("fabric.ask", () => {
		it("asks the question with its context and format, and resolves with the answer alone", async () => {
			const h = runInPage();

			const result = h.fabric.ask("Summarise", {
				context: "the poll",
				format: "markdown",
			});
			const sent = lastCall(h);
			sent.answer({
				answer: "Two of three chose a.",
				usage: { inputTokens: 40, outputTokens: 9 },
			});

			expect(sent).toMatchObject({
				name: "fabric_page_ask",
				args: {
					question: "Summarise",
					context: "the poll",
					format: "markdown",
				},
			});
			await expect(result).resolves.toEqual({
				answer: "Two of three chose a.",
			});
		});

		it("sends no context or format it was not given", () => {
			const h = runInPage();

			void h.fabric.ask("Summarise");

			expect(lastCall(h).args).toEqual({ question: "Summarise" });
		});

		it("rejects without a question", async () => {
			const h = runInPage();

			await expect(h.fabric.ask("")).rejects.toThrow("question");
			expect(h.posted).toEqual([]);
		});
	});

	describe("fabric.files", () => {
		const blobOf = (text: string, type = "text/plain", name?: string) => ({
			size: text.length,
			type,
			name,
			arrayBuffer: async () => new TextEncoder().encode(text).buffer,
		});

		it("uploads a file as base64 under its own name and type", async () => {
			const h = runInPage();

			const result = h.fabric.files.upload(
				blobOf("hi", "text/plain", "note.txt"),
			);
			await Promise.resolve();
			await Promise.resolve();
			const sent = lastCall(h);
			sent.answer({ id: "file-1" });

			expect(sent).toMatchObject({
				name: "fabric_page_file_upload",
				args: {
					name: "note.txt",
					contentType: "text/plain",
					dataBase64: "aGk=",
				},
			});
			await expect(result).resolves.toEqual({ id: "file-1" });
		});

		it("takes the name it is given over the file's own, and a generic type for a file with none", async () => {
			const h = runInPage();

			void h.fabric.files.upload(blobOf("x", "", "own.bin"), {
				name: "given.bin",
			});
			await Promise.resolve();
			await Promise.resolve();

			expect(lastCall(h).args).toMatchObject({
				name: "given.bin",
				contentType: "application/octet-stream",
			});
		});

		it("refuses a file over 4 MB, or one with no name, or something that is not a file, before sending anything", async () => {
			const h = runInPage();

			await expect(
				h.fabric.files.upload({
					...blobOf("x", "text/plain", "big.txt"),
					size: 4 * 1024 * 1024 + 1,
				}),
			).rejects.toThrow("4 MB");
			await expect(
				h.fabric.files.upload(blobOf("x", "text/plain")),
			).rejects.toThrow("name");
			await expect(h.fabric.files.upload("text")).rejects.toThrow(
				"File or a Blob",
			);
			expect(h.posted).toEqual([]);
		});

		it("lists the files of the page", () => {
			const h = runInPage();

			void h.fabric.files.list();

			expect(lastCall(h)).toMatchObject({
				name: "fabric_page_file_list",
				args: {},
			});
		});

		it("reads a file and adds a blob address the page can show, made from the same bytes", async () => {
			const created: unknown[] = [];
			const original = URL.createObjectURL;
			URL.createObjectURL = (blob: Blob) => {
				created.push(blob);
				return "blob:example/1";
			};
			try {
				const h = runInPage();

				const result = h.fabric.files.read("file-1");
				const sent = lastCall(h);
				sent.answer({
					name: "a.png",
					contentType: "image/png",
					dataBase64: "aGk=",
				});
				const file = (await result) as Record<string, unknown>;

				expect(sent).toMatchObject({
					name: "fabric_page_file_read",
					args: { id: "file-1" },
				});
				expect(file).toEqual({
					name: "a.png",
					contentType: "image/png",
					dataBase64: "aGk=",
					blobUrl: "blob:example/1",
				});
				expect(created).toHaveLength(1);
				expect((created[0] as Blob).type).toBe("image/png");
				expect((created[0] as Blob).size).toBe(2);
			} finally {
				URL.createObjectURL = original;
			}
		});

		it("returns what the tool returned when it carries no data to show", async () => {
			const h = runInPage();

			const result = h.fabric.files.read("file-1");
			lastCall(h).answer({ name: "gone.png" });

			await expect(result).resolves.toEqual({ name: "gone.png" });
		});

		it("deletes a file by id, and refuses to read or delete without one", async () => {
			const h = runInPage();

			void h.fabric.files.delete("file-1");
			const sent = lastCall(h);
			await expect(h.fabric.files.read("")).rejects.toThrow("id");
			await expect(h.fabric.files.delete(undefined)).rejects.toThrow(
				"id",
			);

			expect(sent).toMatchObject({
				name: "fabric_page_file_delete",
				args: { id: "file-1" },
			});
			expect(h.posted).toHaveLength(1);
		});
	});

	describe("fabric.connected", () => {
		it("reads from the viewer's own server through the one read tool", () => {
			const h = runInPage();

			void h.fabric.connected("linear", "list_issues", { first: 5 });

			expect(lastCall(h)).toMatchObject({
				name: "fabric_page_read_connected",
				args: {
					provider: "linear",
					tool: "list_issues",
					args: { first: 5 },
				},
			});
		});

		it("sends empty arguments when there are none, and refuses a call without a provider or a tool", async () => {
			const h = runInPage();

			void h.fabric.connected("linear", "list_issues");
			const sent = lastCall(h).args;
			await expect(h.fabric.connected("", "list_issues")).rejects.toThrow(
				"provider",
			);
			await expect(h.fabric.connected("linear", "")).rejects.toThrow(
				"tool",
			);

			expect(sent).toEqual({
				provider: "linear",
				tool: "list_issues",
				args: {},
			});
			expect(h.posted).toHaveLength(1);
		});
	});
});

describe("a call that fails", () => {
	function failWith(
		h: ReturnType<typeof runInPage>,
		answer: Record<string, unknown>,
	) {
		const sent = h.posted.at(-1)?.message ?? {};
		h.deliver({
			type: "fabric-frame:call-result",
			requestId: sent.requestId,
			ok: false,
			...answer,
		});
	}

	it("rejects with an Error that carries the reason the tool gave and whether to try again", async () => {
		const h = runInPage();

		const result = h.fabric.data.set("votes", { key: "@me", value: 1 });
		failWith(h, {
			error: "The page is busy. Try again in a moment.",
			reason: "busy",
			retryable: true,
		});

		await expect(result).rejects.toMatchObject({
			message: "The page is busy. Try again in a moment.",
			reason: "busy",
			retryable: true,
		});
	});

	it.each(["version_conflict", "limit", "rate_limited", "usage_limit"])(
		"hands on the reason %s as it came",
		async (reason) => {
			const h = runInPage();

			const result = h.fabric.ask("Summarise");
			failWith(h, { error: "Refused.", reason });

			await expect(result).rejects.toMatchObject({ reason });
		},
	);

	it("gives an Error with no reason when the tool gave none", async () => {
		const h = runInPage();

		const result = h.fabric.viewer();
		failWith(h, { error: "Nope." });
		const error = await result.catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe("Nope.");
		expect(error).not.toHaveProperty("reason");
		expect(error).not.toHaveProperty("retryable");
	});

	it("ignores a reason or a retry flag of the wrong kind", async () => {
		const h = runInPage();

		const result = h.fabric.viewer();
		failWith(h, { error: "Nope.", reason: 7, retryable: "yes" });
		const error = await result.catch((caught: unknown) => caught);

		expect(error).not.toHaveProperty("reason");
		expect(error).not.toHaveProperty("retryable");
	});
});

describe("fabric.download", () => {
	const downloads = (h: ReturnType<typeof runInPage>) =>
		h.posted.filter(
			(entry) => entry.message.type === "fabric-frame:download",
		);

	it("offers text as base64 under the name and type it was given", async () => {
		const h = runInPage();

		await h.fabric.download("report.csv", "text/csv", "a,b\n1,2\n");

		expect(downloads(h)).toEqual([
			{
				message: {
					type: "fabric-frame:download",
					filename: "report.csv",
					mimeType: "text/csv",
					dataBase64: btoa("a,b\n1,2\n"),
				},
				targetOrigin: "*",
			},
		]);
	});

	it("encodes text as UTF-8", async () => {
		const h = runInPage();

		await h.fabric.download("note.txt", "text/plain", "é€");

		expect(downloads(h)[0].message.dataBase64).toBe("w6nigqw=");
	});

	it("offers bytes from a typed array, an array buffer and a blob alike", async () => {
		const h = runInPage();
		const bytes = Uint8Array.from([104, 105]);

		await h.fabric.download("a.png", "image/png", bytes);
		await h.fabric.download("b.png", "image/png", bytes.buffer);
		await h.fabric.download("c.png", "image/png", {
			arrayBuffer: async () => bytes.buffer,
		});

		expect(downloads(h).map((entry) => entry.message.dataBase64)).toEqual([
			"aGk=",
			"aGk=",
			"aGk=",
		]);
	});

	it("holds the offer until the parent is listening, like any request", async () => {
		const h = runInPage({ hostReady: false });

		await h.fabric.download("report.csv", "text/csv", "x");
		expect(downloads(h)).toEqual([]);
		h.deliver(HOST_READY);

		expect(downloads(h)).toHaveLength(1);
	});

	it("refuses something it cannot turn into bytes, a missing name or type, and anything over 10 MB, sending nothing", async () => {
		const h = runInPage();

		await expect(
			h.fabric.download("a.json", "application/json", { not: "bytes" }),
		).rejects.toThrow("Expected text");
		await expect(h.fabric.download("", "text/csv", "x")).rejects.toThrow(
			"file name",
		);
		await expect(h.fabric.download("a.csv", "", "x")).rejects.toThrow(
			"file name",
		);
		await expect(
			h.fabric.download(
				"big.txt",
				"text/plain",
				new Uint8Array(10 * 1024 * 1024 + 1),
			),
		).rejects.toThrow("10 MB");
		expect(downloads(h)).toEqual([]);
	});

	it("is not a call: nothing waits for an answer", async () => {
		const h = runInPage();

		await expect(
			h.fabric.download("report.csv", "text/csv", "x"),
		).resolves.toBeUndefined();
	});
});

describe("the handshake with the parent", () => {
	it("says hello to its parent once, when it starts, and sends nothing else", () => {
		const { hellos, posted } = runInPage({ hostReady: false });

		expect(hellos).toEqual([
			{ message: { type: FRAME_RUNTIME_HELLO_TYPE }, targetOrigin: "*" },
		]);
		expect(posted).toEqual([]);
	});

	it("holds a call made before the parent is listening, and sends it once the parent says it is", async () => {
		const { fabric, posted, deliver } = runInPage({ hostReady: false });

		const result = fabric.call("fabric_list_workflows", { limit: 2 });
		expect(posted).toEqual([]);

		deliver(HOST_READY);

		expect(posted).toHaveLength(1);
		expect(posted[0].message).toEqual({
			type: "fabric-frame:call",
			requestId: expect.any(String),
			name: "fabric_list_workflows",
			args: { limit: 2 },
		});
		deliver({
			type: "fabric-frame:call-result",
			requestId: posted[0].message.requestId,
			ok: true,
			result: { workflows: [] },
		});
		await expect(result).resolves.toEqual({ workflows: [] });
	});

	it("holds the other requests too, and sends them all in the order they were made", () => {
		const { fabric, posted, deliver } = runInPage({ hostReady: false });

		void fabric.call("fabric_list_workflows");
		fabric.openAgent("Explain this");
		fabric.navigate("/app/example-org/projects");
		void fabric.call("fabric_get_frame", { frameId: "f1" });
		expect(posted).toEqual([]);

		deliver(HOST_READY);

		expect(posted.map((entry) => entry.message.type)).toEqual([
			"fabric-frame:call",
			"fabric-frame:open-agent",
			"fabric-frame:navigate",
			"fabric-frame:call",
		]);
		expect(posted.map((entry) => entry.targetOrigin)).toEqual([
			"*",
			"*",
			"*",
			"*",
		]);
	});

	it("sends a call made after the parent said it is listening at once", () => {
		const { fabric, posted, deliver } = runInPage({ hostReady: false });
		deliver(HOST_READY);

		void fabric.call("fabric_list_workflows");

		expect(posted).toHaveLength(1);
	});

	it("sends nothing twice when the parent says it is listening again", () => {
		const { fabric, posted, deliver } = runInPage({ hostReady: false });
		void fabric.call("fabric_list_workflows");
		fabric.navigate("/app/example-org");

		deliver(HOST_READY);
		deliver(HOST_READY);
		deliver(HOST_READY);

		expect(posted).toHaveLength(2);
		void fabric.call("fabric_get_frame");
		deliver(HOST_READY);
		expect(posted).toHaveLength(3);
		const callIds = posted
			.filter((entry) => entry.message.type === "fabric-frame:call")
			.map((entry) => entry.message.requestId);
		expect(callIds).toHaveLength(2);
		expect(new Set(callIds).size).toBe(2);
	});

	it("does not take a window other than its parent for the parent", () => {
		const { page, fabric, posted, deliver } = runInPage({
			hostReady: false,
		});
		void fabric.call("fabric_list_workflows");

		deliver(HOST_READY, { not: "the parent" });
		deliver(HOST_READY, null);
		deliver(HOST_READY, page);

		expect(posted).toEqual([]);
		deliver(HOST_READY);
		expect(posted).toHaveLength(1);
	});

	it("keeps waiting through messages that are not the parent's word that it is listening", () => {
		const { fabric, posted, deliver } = runInPage({ hostReady: false });
		void fabric.call("fabric_list_workflows");

		deliver(null);
		deliver({ type: "fabric-frame:ready" });
		deliver({ type: "fabric-frame:runtime-hello" });
		deliver({
			type: "fabric-frame:call-result",
			requestId: "call-1",
			ok: true,
		});

		expect(posted).toEqual([]);
	});

	it("rejects a held call whose arguments cannot be sent when it comes to send it", async () => {
		const { fabric, deliver } = runInPage({
			hostReady: false,
			failPost: true,
		});
		const result = fabric.call("fabric_get_frame", { id: "f1" });
		const settled = expect(result).rejects.toThrow("cannot be sent");

		deliver(HOST_READY);

		await settled;
	});

	it("gives up on a held call when the parent never says it is listening", async () => {
		const { fabric, posted } = runInPage({ hostReady: false });

		const result = fabric.call("fabric_list_workflows");
		const settled = expect(result).rejects.toThrow("did not answer");
		await vi.advanceTimersByTimeAsync(FABRIC_RUNTIME_CALL_TIMEOUT_MS);

		await settled;
		expect(posted).toEqual([]);
	});

	it("does not send a call that has already given up when the parent finally says it is listening", async () => {
		const { fabric, posted, deliver } = runInPage({ hostReady: false });

		const result = fabric.call("fabric_list_workflows");
		const settled = expect(result).rejects.toThrow("did not answer");
		await vi.advanceTimersByTimeAsync(FABRIC_RUNTIME_CALL_TIMEOUT_MS);
		await settled;

		deliver(HOST_READY);

		expect(posted).toEqual([]);
	});

	it("sends the held calls that are still waiting and drops only the ones that gave up", async () => {
		const { fabric, posted, deliver } = runInPage({ hostReady: false });
		const early = fabric.call("fabric_list_workflows");
		const earlySettled = expect(early).rejects.toThrow("did not answer");
		await vi.advanceTimersByTimeAsync(FABRIC_RUNTIME_CALL_TIMEOUT_MS - 1);
		void fabric.call("fabric_get_frame", { frameId: "f1" });
		await vi.advanceTimersByTimeAsync(1);
		await earlySettled;

		deliver(HOST_READY);

		expect(posted.map((entry) => entry.message.name)).toEqual([
			"fabric_get_frame",
		]);
	});
});
