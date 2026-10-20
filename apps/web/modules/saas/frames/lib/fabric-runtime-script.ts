import {
	PAGE_DOWNLOAD_MAX_BYTES,
	PAGE_FILE_MAX_BYTES,
} from "@repo/utils/page-limits";
import {
	FRAME_RUNTIME_CALL_TIMEOUT_MS,
	FRAME_RUNTIME_HELLO_TYPE,
	FRAME_RUNTIME_HOST_READY_TYPE,
} from "./frame-embed-protocol";

/** How long a `fabric.call` waits for the host before the page is told no. */
export const FABRIC_RUNTIME_CALL_TIMEOUT_MS = FRAME_RUNTIME_CALL_TIMEOUT_MS;

const MEGABYTE = 1024 * 1024;

const RUNTIME_SOURCE = `
(function () {
	var pending = {};
	var seq = 0;
	var ready = false;
	var queue = [];

	function post(message) {
		try {
			window.parent.postMessage(message, "*");
			return true;
		} catch (e) {
			return false;
		}
	}

	function send(message, fail) {
		if (!ready) {
			queue.push({ message: message, fail: fail });
			return;
		}
		if (!post(message) && fail) {
			fail();
		}
	}

	function flush() {
		var held = queue;
		queue = [];
		for (var i = 0; i < held.length; i++) {
			var entry = held[i];
			if (entry.message.requestId && !pending[entry.message.requestId]) {
				continue;
			}
			if (entry.message.expiresAt <= Date.now()) {
				pending[entry.message.requestId].expire();
				continue;
			}
			if (!post(entry.message) && entry.fail) {
				entry.fail();
			}
		}
	}

	window.addEventListener("message", function (e) {
		var d = e.data;
		if (e.source !== window.parent || !d) {
			return;
		}
		if (d.type === ${JSON.stringify(FRAME_RUNTIME_HOST_READY_TYPE)}) {
			if (ready) {
				return;
			}
			ready = true;
			flush();
			return;
		}
		if (d.type !== "fabric-frame:call-result" || typeof d.requestId !== "string") {
			return;
		}
		var p = pending[d.requestId];
		if (!p) {
			return;
		}
		if (Date.now() >= p.expiresAt) {
			p.expire();
			return;
		}
		delete pending[d.requestId];
		clearTimeout(p.timer);
		if (d.ok === true) {
			p.resolve(d.result);
		} else {
			var failure = new Error(typeof d.error === "string" ? d.error : "Fabric call failed");
			if (typeof d.reason === "string") {
				failure.reason = d.reason;
			}
			if (typeof d.retryable === "boolean") {
				failure.retryable = d.retryable;
			}
			p.reject(failure);
		}
	});

	function call(name, args) {
		return new Promise(function (resolve, reject) {
			if (typeof name !== "string" || !name) {
				reject(new Error("fabric.call needs a tool name"));
				return;
			}
			if (args === undefined || args === null) {
				args = {};
			}
			if (typeof args !== "object" || Array.isArray(args)) {
				reject(new Error("fabric.call arguments must be an object"));
				return;
			}
			var id = "call-" + (++seq);
			var expiresAt = Date.now() + ${FABRIC_RUNTIME_CALL_TIMEOUT_MS};
			function expire() {
				if (!pending[id]) return;
				delete pending[id];
				clearTimeout(timer);
				queue = queue.filter(function (entry) { return entry.message.requestId !== id; });
				post({ type: "fabric-frame:cancel-call", requestId: id });
				reject(new Error("Fabric did not answer"));
			}
			var timer = setTimeout(expire, ${FABRIC_RUNTIME_CALL_TIMEOUT_MS});
			pending[id] = { resolve: resolve, reject: reject, timer: timer, expire: expire, expiresAt: expiresAt };
			send({ type: "fabric-frame:call", requestId: id, name: name, args: args, expiresAt: expiresAt }, function () {
				delete pending[id];
				clearTimeout(timer);
				reject(new Error("fabric.call arguments cannot be sent"));
			});
		});
	}

	function fail(message) {
		return Promise.reject(new Error(message));
	}

	function named(value) {
		return typeof value === "string" && value.length > 0;
	}

	function present(object) {
		var out = {};
		for (var key in object) {
			if (Object.prototype.hasOwnProperty.call(object, key) && object[key] !== undefined) {
				out[key] = object[key];
			}
		}
		return out;
	}

	function toList(value) {
		return Array.isArray(value) ? value : [value];
	}

	function toBase64(bytes) {
		var binary = "";
		for (var i = 0; i < bytes.length; i += 8192) {
			binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
		}
		return btoa(binary);
	}

	function fromBase64(encoded) {
		var binary = atob(encoded);
		var bytes = new Uint8Array(binary.length);
		for (var i = 0; i < binary.length; i++) {
			bytes[i] = binary.charCodeAt(i);
		}
		return bytes;
	}

	function bytesOf(data) {
		if (typeof data === "string") {
			return Promise.resolve(new TextEncoder().encode(data));
		}
		if (data instanceof ArrayBuffer) {
			return Promise.resolve(new Uint8Array(data));
		}
		if (ArrayBuffer.isView(data)) {
			return Promise.resolve(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
		}
		if (data && typeof data.arrayBuffer === "function") {
			return data.arrayBuffer().then(function (buffer) {
				return new Uint8Array(buffer);
			});
		}
		return fail("Expected text, a Blob, an ArrayBuffer or a typed array");
	}

	var data = {
		list: function (collection, options) {
			if (!named(collection)) {
				return fail("fabric.data.list needs a collection name");
			}
			var o = options || {};
			return call("fabric_page_data_list", present({
				collection: collection,
				scope: o.scope,
				since: o.since,
				cursor: o.cursor,
				limit: o.limit
			}));
		},
		get: function (collection, key, options) {
			if (!named(collection) || !named(key)) {
				return fail("fabric.data.get needs a collection name and a key");
			}
			return call("fabric_page_data_get", present({
				collection: collection,
				key: key,
				scope: (options || {}).scope
			}));
		},
		set: function (collection, records) {
			if (!named(collection)) {
				return fail("fabric.data.set needs a collection name");
			}
			if (records === undefined || records === null) {
				return fail("fabric.data.set needs a record or a list of records");
			}
			return call("fabric_page_data_set", { collection: collection, records: toList(records) });
		},
		delete: function (collection, keys) {
			if (!named(collection)) {
				return fail("fabric.data.delete needs a collection name");
			}
			if (keys === undefined || keys === null) {
				return fail("fabric.data.delete needs a key or a list of keys");
			}
			return call("fabric_page_data_delete", { collection: collection, keys: toList(keys) });
		}
	};

	var files = {
		upload: function (file, options) {
			if (!file || typeof file.arrayBuffer !== "function") {
				return fail("fabric.files.upload needs a File or a Blob");
			}
			var name = (options && options.name) || file.name;
			if (!named(name)) {
				return fail("fabric.files.upload needs a file name");
			}
			if (file.size > ${PAGE_FILE_MAX_BYTES}) {
				return fail("A file may be at most ${PAGE_FILE_MAX_BYTES / MEGABYTE} MB");
			}
			return bytesOf(file).then(function (bytes) {
				return call("fabric_page_file_upload", {
					name: name,
					contentType: file.type || "application/octet-stream",
					dataBase64: toBase64(bytes)
				});
			});
		},
		list: function () {
			return call("fabric_page_file_list", {});
		},
		read: function (id) {
			if (!named(id)) {
				return fail("fabric.files.read needs a file id");
			}
			return call("fabric_page_file_read", { id: id }).then(function (file) {
				if (!file || typeof file.dataBase64 !== "string") {
					return file;
				}
				var blob = new Blob([fromBase64(file.dataBase64)], { type: file.contentType });
				return Object.assign({}, file, { blobUrl: URL.createObjectURL(blob) });
			});
		},
		delete: function (id) {
			if (!named(id)) {
				return fail("fabric.files.delete needs a file id");
			}
			return call("fabric_page_file_delete", { id: id });
		}
	};

	function ask(question, options) {
		if (!named(question)) {
			return fail("fabric.ask needs a question");
		}
		var o = options || {};
		return call("fabric_page_ask", present({
			question: question,
			context: o.context,
			format: o.format
		})).then(function (result) {
			return { answer: result && result.answer };
		});
	}

	function download(filename, mimeType, content) {
		if (!named(filename) || !named(mimeType)) {
			return fail("fabric.download needs a file name and a type");
		}
		return bytesOf(content).then(function (bytes) {
			if (bytes.length > ${PAGE_DOWNLOAD_MAX_BYTES}) {
				throw new Error("A download may be at most ${PAGE_DOWNLOAD_MAX_BYTES / MEGABYTE} MB");
			}
			send({
				type: "fabric-frame:download",
				filename: filename,
				mimeType: mimeType,
				dataBase64: toBase64(bytes)
			});
		});
	}

	function connected(provider, tool, args) {
		if (!named(provider) || !named(tool)) {
			return fail("fabric.connected needs a provider and a tool");
		}
		return call("fabric_page_read_connected", { provider: provider, tool: tool, args: args || {} });
	}

	var fabric = {
		call: call,
		openAgent: function (prompt) {
			send({ type: "fabric-frame:open-agent", prompt: String(prompt) });
		},
		navigate: function (path) {
			send({ type: "fabric-frame:navigate", path: String(path) });
		},
		viewer: function () {
			return call("fabric_get_page_viewer", {});
		},
		data: Object.freeze(data),
		ask: ask,
		files: Object.freeze(files),
		download: download,
		connected: connected
	};

	Object.defineProperty(window, "fabric", {
		value: Object.freeze(fabric),
		configurable: false,
		enumerable: true
	});
	post({ type: ${JSON.stringify(FRAME_RUNTIME_HELLO_TYPE)} });
})();
`;

/** One line per line of source, without the indentation the source is read with. */
function compact(source: string): string {
	return source
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.join("\n");
}

/**
 * The page runtime, `window.fabric`, defined before any script of the page
 * runs. The page has no credentials and loads nothing from the network, so every
 * function only posts a request to the parent; the host page decides whether to
 * act on it, as the person looking at the page. The protocol is in
 * `frame-embed-protocol`, and the host's rules in `frame-runtime-host`.
 *
 * - `fabric.call(tool, args)` runs a Fabric tool the page declared when it was
 *   saved, and resolves with its result or rejects with an Error. When the tool
 *   gave one, the Error carries `reason` (`version_conflict`, `busy`, `limit`,
 *   `rate_limited`, `usage_limit`) and `retryable`.
 * - `fabric.viewer()`, `fabric.data.*`, `fabric.ask`, `fabric.files.*` and
 *   `fabric.connected` are `fabric.call` for the tool of the same purpose, with
 *   the arguments put in shape; the page declares those tools like any other.
 * - `fabric.download(name, type, data)` offers the viewer a file, which they
 *   still have to accept.
 * - `fabric.openAgent(prompt)` opens Fabric Agent with `prompt` ready to send.
 * - `fabric.navigate(path)` goes to a page of the app (`/app/...`).
 *
 * A page's script can run before the embed that relays for it is listening, so
 * a request made at load would reach no one. Requests are therefore held until
 * the parent has said it is listening (`host-ready`, see `frame-embed-protocol`)
 * and sent in the order they were made, once; the runtime announces itself with
 * `runtime-hello` when it starts, for a parent that attached first and so has
 * to be told the page is there. A `host-ready` after the first changes nothing.
 *
 * A reply, and `host-ready`, are believed only from the parent window, and the
 * object is frozen and fixed on `window` so a later script cannot swap it for
 * another.
 */
export const FABRIC_RUNTIME_SCRIPT = compact(RUNTIME_SOURCE);
