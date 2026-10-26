import type { orpcClient } from "@shared/lib/orpc-client";

export type ParlumeSettings = Awaited<
	ReturnType<typeof orpcClient.parlumeSettings.get>
>;

export type ParlumeAttendeeCheck = Awaited<
	ReturnType<typeof orpcClient.parlumeSettings.testAttendee>
>;

export type ParlumeRealtimeCheck = Awaited<
	ReturnType<typeof orpcClient.parlumeSettings.testRealtimeVoice>
>["hosts"][number];

export type TeamsLoginChoice = "anonymous" | "only_if_required" | "always";

export const TEAMS_LOGIN_CHOICES: ReadonlyArray<{
	value: TeamsLoginChoice;
	label: string;
	description: string;
}> = [
	{
		value: "anonymous",
		label: "Anonymous guest",
		description:
			"Joins without signing in. Some meetings keep anonymous guests out of the lobby or the chat.",
	},
	{
		value: "only_if_required",
		label: "Sign in when the meeting requires it",
		description:
			"Joins as a guest, and signs in only where the meeting admits signed-in users alone.",
	},
	{
		value: "always",
		label: "Always sign in",
		description: "Joins every meeting signed in to Teams.",
	},
];

export function teamsChoiceFrom(
	mode: ParlumeSettings["attendee"]["teamsLoginMode"],
): TeamsLoginChoice {
	return mode ?? "anonymous";
}

export function teamsModeFrom(
	choice: TeamsLoginChoice,
): ParlumeSettings["attendee"]["teamsLoginMode"] {
	return choice === "anonymous" ? null : choice;
}

export function describeAttendeeCheck(check: ParlumeAttendeeCheck): {
	ok: boolean;
	message: string;
} {
	switch (check.status) {
		case "ok":
			return {
				ok: true,
				message: "Connected. Attendee accepted the key.",
			};
		case "invalid_key":
			return {
				ok: false,
				message: `Attendee rejected the key (HTTP ${check.httpStatus}).`,
			};
		case "error":
			return {
				ok: false,
				message: [
					check.httpStatus
						? `Attendee answered HTTP ${check.httpStatus}.`
						: "Attendee could not be reached.",
					check.detail,
				]
					.filter(Boolean)
					.join(" "),
			};
		default: {
			const unknown: never = check;
			throw new Error(`Unsupported Attendee check: ${String(unknown)}`);
		}
	}
}

export function realtimeHostLabel(
	provider: ParlumeRealtimeCheck["provider"],
): string {
	switch (provider) {
		case "AZURE_AI_FOUNDRY":
			return "Azure AI Foundry";
		case "OPENAI_DIRECT":
			return "OpenAI";
		default: {
			const unknown: never = provider;
			throw new Error(`Unsupported realtime host: ${String(unknown)}`);
		}
	}
}

/** The server's refusal message, which names the field it rejected. */
export function errorMessage(error: unknown, fallback: string): string {
	return error instanceof Error && error.message ? error.message : fallback;
}
