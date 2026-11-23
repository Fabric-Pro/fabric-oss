import type {
	ParlumeAction,
	ParlumeRequest,
	ParlumeSession,
	ParlumeSuggestionItem,
} from "../../lib/parlume-format";

export const PROJECT_BASE_PATH = "/app/example-org/projects/example-project";
export const SETTINGS_BASE_PATH = "/app/example-org/settings";

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
		suggestionsEnabled: false,
		suggestionAudience: "MEETING",
		endReason: null,
		lastError: null,
		channelChatStatus: "ATTENDEE",
		channelChatError: null,
		joinedAt: new Date("2026-09-30T10:00:00Z"),
		pausedAt: null,
		pausedBy: null,
		confidential: false,
		confidentialSince: null,
		confidentialBy: null,
		transcriptDeletedAt: null,
		hardStopAt: null,
		leaveRequestedAt: null,
		endedAt: new Date("2026-09-30T10:30:00Z"),
		transcriptContextId: null,
		trigger: "MANUAL",
		linkedMeeting: null,
		createdAt: new Date("2026-09-30T09:59:00Z"),
		updatedAt: new Date("2026-09-30T10:30:00Z"),
		requestCount: 0,
		suggestionCount: 0,
		notes: null,
		notesItems: [],
		notesStatus: null,
		notesRequestedAt: null,
		canRegenerateNotes: false,
		canProposeActionItems: false,
		contentWithheld: false,
		canReadTranscript: true,
		canDeleteSession: true,
		canMarkConfidential: false,
		canClearConfidential: false,
		guestsPresent: false,
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

export function suggestion(
	overrides: Partial<ParlumeSuggestionItem> = {},
): ParlumeSuggestionItem {
	return {
		id: "suggestion-1",
		kind: "ANSWER",
		audience: "MEETING",
		text: "EX-12 already covers the export.",
		speaker: "Attendee One",
		quote: "we still need an export",
		topic: "Roadmap export",
		chatTag: "P2",
		chatDelivery: null,
		createdAt: new Date("2026-09-30T10:07:00Z"),
		...overrides,
	};
}

export function action(overrides: Partial<ParlumeAction> = {}): ParlumeAction {
	return {
		id: "a1",
		toolName: "example_tool",
		arguments: { itemKey: "EX-1", target: "Sprint 2" },
		summary: "Move EX-1 to Sprint 2.",
		status: "COMPLETED",
		expiresAt: new Date("2026-10-01T10:05:00Z"),
		chatTag: "P2",
		chatDelivery: null,
		createdAt: new Date("2026-09-30T10:05:00Z"),
		completedAt: new Date("2026-09-30T10:06:00Z"),
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
		speakerMark: "member",
		requestText: "What is the status?",
		responseText: "On track.",
		replyChannel: "VOICE",
		status: "COMPLETED",
		error: null,
		createdAt: new Date("2026-09-30T10:05:00Z"),
		startedAt: null,
		completedAt: null,
		firstAudioAt: null,
		spokenAt: null,
		interruptedAt: null,
		stopCause: null,
		stoppedBy: null,
		chatTags: [],
		chatUnshownTags: [],
		session: {
			agentLabel: "Fabric Agent — this project",
			toolsReadOnly: true,
		},
		actions: [],
		...overrides,
	};
}
