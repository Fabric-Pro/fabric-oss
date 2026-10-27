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
	resolveParlumeAttendeeSettings,
	resolveParlumeAttendeeSettingsForSession,
	resolveParlumeRealtimeDeployment,
	teamsLoginModeFromStored,
	teamsLoginModeToStored,
} from "../parlume-provider-settings";

function storedRow(overrides: Record<string, unknown> = {}) {
	return {
		encryptedAttendeeApiKey: "cipher",
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
			source: "organization",
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
			source: "environment",
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

describe("resolveParlumeRealtimeDeployment", () => {
	it("uses the organization's deployment name", async () => {
		mocks.settingsFindUnique.mockResolvedValue({
			realtimeDeployment: "example-realtime",
		});

		await expect(
			resolveParlumeRealtimeDeployment("org-1"),
		).resolves.toEqual({
			deployment: "example-realtime",
			source: "organization",
		});
	});

	it("names the deployment after the model otherwise, even with a key saved", async () => {
		mocks.settingsFindUnique.mockResolvedValue({
			realtimeDeployment: null,
		});

		await expect(
			resolveParlumeRealtimeDeployment("org-1"),
		).resolves.toEqual({
			deployment: "gpt-realtime-2.1",
			source: "default",
		});
		await expect(resolveParlumeRealtimeDeployment(null)).resolves.toEqual({
			deployment: "gpt-realtime-2.1",
			source: "default",
		});
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
