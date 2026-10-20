/**
 * `fabric connect chatgpt` shows the real outcome in the ChatGPT tab: the
 * loopback holds the browser's reply until Fabric has answered the upload,
 * then writes "Connected" or the refusal, escaped. A held tab still ends —
 * after a timeout, or when the browser goes away — and the terminal sets a
 * refusal apart as a "Not connected:" block.
 */
import { get } from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
	connectedPage,
	notConnectedMessage,
} from "../src/commands/connect/chatgpt.js";
import { signInWithChatGpt } from "../src/lib/chatgpt-plan/flow.js";
import { startLoopbackListener } from "../src/lib/oauth/loopback.js";

vi.mock("../src/lib/config.js", () => ({
	getConfigPath: () => "/tmp/fabric-cli-example/config.json",
}));

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

function idToken(claims: Record<string, unknown>): string {
	const encode = (value: object) =>
		Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "RS256" })}.${encode(claims)}.signature`;
}

const FALLBACK = { title: "Check your terminal", body: "Still waiting." };

describe("loopback listener with a held reply", () => {
	it("answers only once finish writes the outcome, escaped, even after close", async () => {
		const listener = await startLoopbackListener({
			state: "s",
			timeoutMs: 5_000,
			deferPage: { fallback: FALLBACK },
		});
		let answered = false;
		const page = fetchBody(`${listener.redirectUri}?state=s&code=c`).then(
			(response) => {
				answered = true;
				return response;
			},
		);
		await listener.result;
		listener.close();
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(answered).toBe(false);

		await listener.finish({
			title: "Not connected",
			body: `Refused <script>alert("x")</script> & more`,
		});
		const { status, body } = await page;
		expect(status).toBe(200);
		expect(body).toContain(
			'<h1 style="font-weight:400">Not connected</h1>',
		);
		expect(body).toContain(
			"Refused &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; more",
		);
		expect(body).not.toContain("<script>");
		expect(body).toContain("</body>");
		// A second call has nothing left to write.
		await expect(
			listener.finish({ title: "Again", body: "" }),
		).resolves.toBeUndefined();
	});

	it("writes the fallback page when nobody finishes in time", async () => {
		const listener = await startLoopbackListener({
			state: "s",
			timeoutMs: 5_000,
			deferPage: { fallback: FALLBACK, timeoutMs: 50 },
		});
		const page = fetchBody(`${listener.redirectUri}?state=s&code=c`);
		await listener.result;
		listener.close();
		const { body } = await page;
		expect(body).toContain("Check your terminal");
	});

	it("settles finish when the browser has already gone", async () => {
		const listener = await startLoopbackListener({
			state: "s",
			timeoutMs: 5_000,
			deferPage: { fallback: FALLBACK },
		});
		const request = get(`${listener.redirectUri}?state=s&code=c`);
		request.on("error", () => {});
		await listener.result;
		listener.close();
		request.destroy();
		await new Promise((resolve) => setTimeout(resolve, 50));
		await expect(
			listener.finish({ title: "Connected", body: "" }),
		).resolves.toBeUndefined();
	});

	it("still answers at once without deferPage", async () => {
		const listener = await startLoopbackListener({
			state: "s",
			timeoutMs: 5_000,
		});
		const page = fetchBody(`${listener.redirectUri}?state=s&code=c`);
		await listener.result;
		listener.close();
		expect((await page).body).toContain("Signed in");
	});
});

describe("ChatGPT sign-in with the tab held", () => {
	/** Plays ChatGPT in the browser and keeps what the tab finally shows. */
	function browser() {
		let shown: Promise<{ status: number; body: string }> | undefined;
		let authorize: URL | undefined;
		const open = (url: string) => {
			authorize = new URL(url);
			const query = new URLSearchParams({
				state: authorize.searchParams.get("state") ?? "",
				code: "code-1",
				client_id: "oaiapp_new",
			});
			shown = fetchBody(
				`${authorize.searchParams.get("redirect_uri")}?${query}`,
			);
		};
		return {
			open,
			nonce: () => authorize?.searchParams.get("nonce"),
			shown: () => {
				if (!shown) {
					throw new Error("the browser was never opened");
				}
				return shown;
			},
		};
	}

	it("keeps the tab waiting, then shows that the plan is connected", async () => {
		const tab = browser();
		const signIn = await signInWithChatGpt({
			registration: { hostId: "urn:uuid:host" },
			open: tab.open,
			preferredPort: 0,
			holdBrowserPage: true,
			fetchImpl: vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							access_token: "access",
							refresh_token: "refresh",
							id_token: idToken({
								sub: "subject-1",
								nonce: tab.nonce(),
							}),
							token_type: "Bearer",
							expires_in: 3600,
							scope: "openid offline_access chatgpt.tokens.use.direct",
						}),
						{ status: 200 },
					),
			),
		});
		await signIn.finishBrowser(
			connectedPage({
				connected: true,
				email: "person@example.com",
				organizations: [
					{ slug: "example-org", name: "Example Org", enabled: true },
				],
			}),
		);
		const { body } = await tab.shown();
		expect(body).toContain("Connected");
		expect(body).toContain(
			"Connected your ChatGPT plan (person@example.com) to Fabric.",
		);
		expect(body).toContain("Example Org");
		expect(body).not.toContain("Signed in");
	});

	it("shows why in the tab when the sign-in fails after the code arrived", async () => {
		const tab = browser();
		await expect(
			signInWithChatGpt({
				registration: { hostId: "urn:uuid:host" },
				open: tab.open,
				preferredPort: 0,
				holdBrowserPage: true,
				fetchImpl: vi.fn(
					async () =>
						new Response(
							JSON.stringify({ error: "invalid_grant" }),
							{
								status: 400,
							},
						),
				),
			}),
		).rejects.toThrow(/invalid_grant/);
		const { body } = await tab.shown();
		expect(body).toContain("Not connected");
		expect(body).toContain("invalid_grant");
	});
});

describe("terminal refusal", () => {
	it("sets the reason apart after a blank line", () => {
		expect(
			notConnectedMessage(
				"This ChatGPT account is already shared by another organization.",
			),
		).toBe(
			"\n✗ Not connected: This ChatGPT account is already shared by another organization.\n",
		);
	});

	it("says the shared account is connected, naming its organization", () => {
		const page = connectedPage({
			connected: true,
			email: null,
			shared: {
				organization: { slug: "example-org", name: "Example Org" },
				created: true,
			},
		});
		expect(page.title).toBe("Connected");
		expect(page.body).toContain(
			"Connected the ChatGPT account as a shared account of Example Org.",
		);
	});
});
