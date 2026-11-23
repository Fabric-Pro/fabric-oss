import {
	bridgeControlUrlForSession,
	type ParlumeBridgeSettings,
	ParlumeBridgeUnavailableError,
} from "./parlume-attendee";

/**
 * Asks the bridge to say a suggestion in the meeting, for the member who
 * pressed Say in meeting on the Parlume page. The bridge speaks it when it
 * holds the floor, and refuses while Parlume is paused or a guest is in the
 * meeting: `spoken` is false then. Throws `ParlumeBridgeUnavailableError`
 * when the bridge does not answer, or does not know the request.
 */
export async function sendParlumeReadAloud(input: {
	settings: ParlumeBridgeSettings;
	sessionId: string;
	suggestionId: string;
	text: string;
	actor: { id: string; name: string | null };
}): Promise<{ spoken: boolean }> {
	const url = new URL(
		bridgeControlUrlForSession(input.settings.bridgeUrl, input.sessionId),
	);
	url.searchParams.set("action", "read-aloud");
	const response = await fetch(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			Authorization: `Bearer ${input.settings.serviceSecret}`,
		},
		body: JSON.stringify({
			text: input.text,
			suggestionId: input.suggestionId,
			actor: input.actor,
		}),
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) {
		throw new ParlumeBridgeUnavailableError();
	}
	const body: unknown = await response.json();
	return {
		spoken:
			typeof body === "object" &&
			body !== null &&
			"spoken" in body &&
			body.spoken === true,
	};
}
