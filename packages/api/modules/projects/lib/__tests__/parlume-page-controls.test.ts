import { afterEach, describe, expect, it, vi } from "vitest";
import { ParlumeBridgeUnavailableError } from "../parlume-attendee";
import { sendParlumeReadAloud } from "../parlume-page-controls";

const settings = {
	bridgeUrl: "wss://bridge.fabric.example/live",
	callbackUrl: "https://fabric.example/api/internal/parlume/callback",
	serviceSecret: "service-secret",
};

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

afterEach(() => {
	fetchMock.mockReset();
});

const readAloud = () =>
	sendParlumeReadAloud({
		settings,
		sessionId: "session-1",
		suggestionId: "suggestion-1",
		text: "The release is planned for Thursday.",
		actor: { id: "user-1", name: "Dana Member" },
	});

describe("sendParlumeReadAloud", () => {
	it("asks the session's bridge, with the service secret, to say the suggestion for the member", async () => {
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ spoken: true }), { status: 200 }),
		);

		await expect(readAloud()).resolves.toEqual({ spoken: true });

		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(String(url)).toBe(
			"https://bridge.fabric.example/live/session-1?action=read-aloud",
		);
		expect(init.method).toBe("POST");
		expect(init.headers.Authorization).toBe("Bearer service-secret");
		expect(JSON.parse(init.body)).toEqual({
			text: "The release is planned for Thursday.",
			suggestionId: "suggestion-1",
			actor: { id: "user-1", name: "Dana Member" },
		});
	});

	it("reports a suggestion the bridge held back as not spoken", async () => {
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ spoken: false }), { status: 200 }),
		);

		await expect(readAloud()).resolves.toEqual({ spoken: false });
	});

	it("treats a bridge that refuses the request as unavailable", async () => {
		fetchMock.mockResolvedValue(
			new Response("Bad request", { status: 400 }),
		);

		await expect(readAloud()).rejects.toBeInstanceOf(
			ParlumeBridgeUnavailableError,
		);
	});
});
