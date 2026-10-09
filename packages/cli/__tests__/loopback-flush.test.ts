/**
 * The loopback listener settles only after its last page is written
 * (Fizzy #2770). Callers close the listener the moment the result settles —
 * `fabric connect chatgpt` and `fabric auth login` alike — and closing used to
 * race the reply, so the browser intermittently showed "127.0.0.1 refused to
 * connect" instead of "Signed in".
 */
import { get, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startLoopbackListener } from "../src/lib/oauth/loopback.js";

/** Reads a whole response body the way a browser would, or fails on a cut connection. */
function fetchBody(url: string): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		get(url, (response) => {
			let body = "";
			response.setEncoding("utf8");
			response.on("data", (chunk: string) => {
				body += chunk;
			});
			response.on("end", () =>
				resolve({ status: response.statusCode ?? 0, body }),
			);
			response.on("error", reject);
		}).on("error", reject);
	});
}

async function signInOnce(query: string) {
	const listener = await startLoopbackListener({
		state: "expected-state",
		timeoutMs: 5_000,
	});
	const page = fetchBody(
		`${listener.redirectUri}?state=expected-state&${query}`,
	);
	// Exactly what a caller does: close as soon as the result settles.
	const settled = listener.result.then(
		() => listener.close(),
		() => listener.close(),
	);
	const [response] = await Promise.all([page, settled]);
	return response;
}

describe("loopback listener — last page before close", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	// The race, made deterministic: the page leaves the process a little after
	// `end` is called, as it can on a busy socket. Settling at `end` (before
	// the flush) let the caller's close destroy the connection first.
	it("waits for a slow flush before settling", async () => {
		const end = ServerResponse.prototype.end;
		vi.spyOn(ServerResponse.prototype, "end").mockImplementation(function (
			this: ServerResponse,
			...args: unknown[]
		) {
			setTimeout(() => {
				(end as (...a: unknown[]) => void).apply(this, args);
			}, 50);
			return this;
		});
		const { status, body } = await signInOnce("code=code-1");
		expect(status).toBe(200);
		expect(body).toContain("Signed in");
	});

	it("delivers the whole Signed in page before the caller closes", async () => {
		for (let run = 0; run < 25; run++) {
			const { status, body } = await signInOnce("code=code-1");
			expect(status).toBe(200);
			expect(body).toContain("Signed in");
			expect(body).toContain("</body>");
		}
	});

	it("delivers the whole cancelled page before the caller closes", async () => {
		for (let run = 0; run < 25; run++) {
			const { status, body } = await signInOnce("error=access_denied");
			expect(status).toBe(200);
			expect(body).toContain("Sign-in cancelled");
			expect(body).toContain("</body>");
		}
	});

	it("tells the browser the connection ends with the page", async () => {
		const listener = await startLoopbackListener({
			state: "expected-state",
			timeoutMs: 5_000,
		});
		const headers = await new Promise<Record<string, unknown>>(
			(resolve) => {
				get(
					`${listener.redirectUri}?state=expected-state&code=c`,
					(response) => {
						response.resume();
						resolve(response.headers);
					},
				);
			},
		);
		await listener.result;
		listener.close();
		expect(headers.connection).toBe("close");
	});
});
