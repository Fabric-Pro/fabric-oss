import type {
	ParlumeAction,
	ParlumeRequest,
	ParlumeSession,
} from "../../lib/parlume-format";

export const PROJECT_BASE_PATH = "/app/example-org/projects/example-project";

export function session(
	overrides: Partial<ParlumeSession> = {},
): ParlumeSession {
	return {
		id: "s1",
		agentKind: "FABRIC_AGENT",
		agentLabel: "Fabric Agent — this project",
		agentInstanceSId: null,
		status: "ENDED",
		wakePhrase: "Hey Fabric",
		toolsReadOnly: true,
		endReason: null,
		lastError: null,
		joinedAt: new Date("2026-09-30T10:00:00Z"),
		hardStopAt: null,
		leaveRequestedAt: null,
		endedAt: new Date("2026-09-30T10:30:00Z"),
		transcriptContextId: null,
		createdAt: new Date("2026-09-30T09:59:00Z"),
		updatedAt: new Date("2026-09-30T10:30:00Z"),
		requestCount: 0,
		notes: null,
		notesStatus: null,
		...overrides,
	};
}

export function liveSession(
	overrides: Partial<ParlumeSession> = {},
): ParlumeSession {
	return session({
		id: "live1",
		status: "ACTIVE",
		endedAt: null,
		joinedAt: new Date(Date.now() - 5 * 60_000),
		createdAt: new Date(Date.now() - 6 * 60_000),
		...overrides,
	});
}

export function action(overrides: Partial<ParlumeAction> = {}): ParlumeAction {
	return {
		id: "a1",
		toolName: "example_tool",
		arguments: { itemKey: "EX-1", target: "Sprint 2" },
		summary: "Move EX-1 to Sprint 2.",
		status: "COMPLETED",
		createdAt: new Date("2026-09-30T10:05:00Z"),
		presentedAt: new Date("2026-09-30T10:05:05Z"),
		expiresAt: new Date("2026-09-30T10:07:00Z"),
		confirmedAt: new Date("2026-09-30T10:05:40Z"),
		completedAt: new Date("2026-09-30T10:06:00Z"),
		confirmationTurnId: "t2",
		outcome: "Moved EX-1.",
		...overrides,
	};
}

export function request(
	overrides: Partial<ParlumeRequest> = {},
): ParlumeRequest {
	return {
		id: "t1",
		sessionId: "s1",
		speakerId: "speaker-1",
		speakerName: "Attendee One",
		requestText: "What is the status?",
		responseText: "On track.",
		status: "COMPLETED",
		error: null,
		createdAt: new Date("2026-09-30T10:05:00Z"),
		startedAt: null,
		completedAt: null,
		firstAudioAt: null,
		spokenAt: null,
		interruptedAt: null,
		session: {
			agentLabel: "Fabric Agent — this project",
			toolsReadOnly: true,
		},
		actions: [],
		...overrides,
	};
}
