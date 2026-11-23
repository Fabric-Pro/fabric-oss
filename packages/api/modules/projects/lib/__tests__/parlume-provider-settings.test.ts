import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	settingsFindUnique: vi.fn(),
	sessionFindUnique: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		organizationParlumeSettings: { findUnique: mocks.settingsFindUnique },
		parlumeMeetingSession: { findUnique: mocks.sessionFindUnique },
	},
}));

vi.mock("@repo/utils", () => ({
	decryptApiKey: (value: string) => `decrypted:${value}`,
}));

import {
	attendeeSourceToStored,
	resolveParlumeAttendeeSettings,
	resolveParlumeAttendeeSettingsForSession,
	resolveParlumeGuestPolicy,
	resolveParlumeRealtimeDeployment,
	resolveParlumeWebhookSecret,
	teamsLoginModeFromStored,
	teamsLoginModeToStored,
} from "../parlume-provider-settings";

function storedRow(overrides: Record<string, unknown> = {}) {
	return {
		encryptedAttendeeApiKey: "cipher",
		encryptedAttendeeWebhookSecret: "secret-cipher",
		attendeeBaseUrl: null,
		teamsLoginMode: null,
		realtimeDeployment: null,
		updatedAt: new Date("2026-10-26T12:00:00Z"),
		...overrides,
	};
}

beforeEach(() => {
	vi.resetAllMocks();
	vi.stubEnv("PARLUME_ATTENDEE_API_KEY", "operator-key");
	vi.stubEnv("PARLUME_ATTENDEE_BASE_URL", "");
	vi.stubEnv("PARLUME_ATTENDEE_TEAMS_LOGIN", "always");
	vi.stubEnv("PARLUME_ATTENDEE_WEBHOOK_SECRET", "operator-webhook-secret");
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("resolveParlumeAttendeeSettings", () => {
	it("uses the organization's own key, URL and Teams sign-in over the environment", async () => {
		mocks.settingsFindUnique.mockResolvedValue(
			storedRow({
				attendeeBaseUrl: "https://attendee.example.com",
				teamsLoginMode: "ONLY_IF_REQUIRED",
			}),
		);

		await expect(resolveParlumeAttendeeSettings("org-1")).resolves.toEqual({
			apiKey: "decrypted:cipher",
			baseUrl: "https://attendee.example.com",
			teamsLoginMode: "only_if_required",
			webhookSecret: "decrypted:secret-cipher",
			source: "organization",
		});
		expect(mocks.settingsFindUnique).toHaveBeenCalledWith(
			expect.objectContaining({ where: { organizationId: "org-1" } }),
		);
	});

	it("keeps the organization's key on the hosted service and anonymous, never the environment's mode", async () => {
		mocks.settingsFindUnique.mockResolvedValue(storedRow());

		await expect(resolveParlumeAttendeeSettings("org-1")).resolves.toEqual({
			apiKey: "decrypted:cipher",
			baseUrl: "https://app.attendee.dev",
			teamsLoginMode: null,
			webhookSecret: "decrypted:secret-cipher",
			source: "organization",
		});
	});

	it("never lends the operator's webhook secret to the organization's own project", async () => {
		mocks.settingsFindUnique.mockResolvedValue(
			storedRow({ encryptedAttendeeWebhookSecret: null }),
		);

		await expect(
			resolveParlumeAttendeeSettings("org-1"),
		).resolves.toMatchObject({
			source: "organization",
			webhookSecret: null,
		});
	});

	it("falls back to the environment as a whole when the organization saved no key", async () => {
		mocks.settingsFindUnique.mockResolvedValue(
			storedRow({
				encryptedAttendeeApiKey: null,
				attendeeBaseUrl: "https://attendee.example.com",
				realtimeDeployment: "example-realtime",
			}),
		);

		await expect(resolveParlumeAttendeeSettings("org-1")).resolves.toEqual({
			apiKey: "operator-key",
			baseUrl: "https://app.attendee.dev",
			teamsLoginMode: "always",
			teamsLoginGroup: null,
			webhookSecret: "operator-webhook-secret",
			source: "environment",
		});
	});

	it("signs the organization's bot in with its own Teams login group", async () => {
		mocks.settingsFindUnique.mockResolvedValue(
			storedRow({
				teamsLoginMode: "ALWAYS",
				teamsLoginGroup: "example-org bot",
			}),
		);

		await expect(
			resolveParlumeAttendeeSettings("org-1"),
		).resolves.toMatchObject({
			source: "organization",
			teamsLoginMode: "always",
			teamsLoginGroup: "example-org bot",
		});
	});

	it("never carries an organization's login group to the operator's project", async () => {
		mocks.settingsFindUnique.mockResolvedValue(
			storedRow({
				encryptedAttendeeApiKey: null,
				teamsLoginGroup: "example-org bot",
			}),
		);

		await expect(
			resolveParlumeAttendeeSettings("org-1"),
		).resolves.toMatchObject({
			source: "environment",
			teamsLoginGroup: null,
		});
	});

	it("falls back to the environment for an organization with no settings row", async () => {
		mocks.settingsFindUnique.mockResolvedValue(null);
		vi.stubEnv(
			"PARLUME_ATTENDEE_BASE_URL",
			"https://attendee.example.com/api/v1/",
		);

		await expect(
			resolveParlumeAttendeeSettings("org-1"),
		).resolves.toMatchObject({
			baseUrl: "https://attendee.example.com",
			source: "environment",
		});
	});

	it("resolves nothing when neither the organization nor the environment has a key", async () => {
		mocks.settingsFindUnique.mockResolvedValue(null);
		vi.stubEnv("PARLUME_ATTENDEE_API_KEY", "");

		await expect(
			resolveParlumeAttendeeSettings("org-1"),
		).resolves.toBeNull();
	});

	it("resolves a session's settings through its organization", async () => {
		mocks.sessionFindUnique.mockResolvedValue({ organizationId: "org-2" });
		mocks.settingsFindUnique.mockResolvedValue(storedRow());

		await expect(
			resolveParlumeAttendeeSettingsForSession("session-1"),
		).resolves.toMatchObject({ source: "organization" });
		expect(mocks.settingsFindUnique).toHaveBeenCalledWith(
			expect.objectContaining({ where: { organizationId: "org-2" } }),
		);

		mocks.sessionFindUnique.mockResolvedValue(null);
		await expect(
			resolveParlumeAttendeeSettingsForSession("missing"),
		).resolves.toBeNull();
	});
});

describe("resolveParlumeWebhookSecret", () => {
	it("records the project a bot is created on", () => {
		expect(attendeeSourceToStored("environment")).toBe("ENVIRONMENT");
		expect(attendeeSourceToStored("organization")).toBe("ORGANIZATION");
	});

	it("verifies an operator-created bot against the operator's secret after the organization saves its own key", async () => {
		mocks.settingsFindUnique.mockResolvedValue(storedRow());

		await expect(
			resolveParlumeWebhookSecret({
				organizationId: "org-1",
				attendeeSource: "ENVIRONMENT",
			}),
		).resolves.toBe("operator-webhook-secret");
		expect(mocks.settingsFindUnique).not.toHaveBeenCalled();
	});

	it("verifies an organization-created bot against the organization's secret after it removes its key", async () => {
		mocks.settingsFindUnique.mockResolvedValue(
			storedRow({ encryptedAttendeeApiKey: null }),
		);

		await expect(
			resolveParlumeWebhookSecret({
				organizationId: "org-1",
				attendeeSource: "ORGANIZATION",
			}),
		).resolves.toBe("decrypted:secret-cipher");
	});

	it("never lends the operator's secret to an organization-created bot", async () => {
		mocks.settingsFindUnique.mockResolvedValue(null);

		await expect(
			resolveParlumeWebhookSecret({
				organizationId: "org-1",
				attendeeSource: "ORGANIZATION",
			}),
		).resolves.toBeNull();
	});

	it("resolves the organization's current settings for a session from before the source was recorded", async () => {
		mocks.settingsFindUnique.mockResolvedValue(storedRow());

		await expect(
			resolveParlumeWebhookSecret({
				organizationId: "org-1",
				attendeeSource: null,
			}),
		).resolves.toBe("decrypted:secret-cipher");

		mocks.settingsFindUnique.mockResolvedValue(null);
		await expect(
			resolveParlumeWebhookSecret({
				organizationId: "org-1",
				attendeeSource: null,
			}),
		).resolves.toBe("operator-webhook-secret");
	});
});

describe("resolveParlumeRealtimeDeployment", () => {
	it("uses the organization's deployment name", async () => {
		mocks.settingsFindUnique.mockResolvedValue({
			realtimeDeployment: "example-realtime",
		});

		await expect(resolveParlumeRealtimeDeployment("org-1")).resolves.toBe(
			"example-realtime",
		);
	});

	it("names none otherwise, so the meeting keeps the classic voice", async () => {
		mocks.settingsFindUnique.mockResolvedValue({
			realtimeDeployment: null,
		});

		await expect(
			resolveParlumeRealtimeDeployment("org-1"),
		).resolves.toBeNull();
		await expect(
			resolveParlumeRealtimeDeployment(null),
		).resolves.toBeNull();
	});
});

describe("resolveParlumeGuestPolicy", () => {
	it("keeps notes and stays quiet unless the organization chose internal meetings only", async () => {
		mocks.settingsFindUnique.mockResolvedValue(null);
		await expect(resolveParlumeGuestPolicy("org-1")).resolves.toBe(
			"NOTES_ONLY",
		);

		mocks.settingsFindUnique.mockResolvedValue({
			guestPolicy: "INTERNAL_ONLY",
		});
		await expect(resolveParlumeGuestPolicy("org-1")).resolves.toBe(
			"INTERNAL_ONLY",
		);
	});
});

describe("Teams sign-in mode storage", () => {
	it("round-trips every mode", () => {
		for (const mode of ["always", "only_if_required", null] as const) {
			expect(teamsLoginModeFromStored(teamsLoginModeToStored(mode))).toBe(
				mode,
			);
		}
	});
});
