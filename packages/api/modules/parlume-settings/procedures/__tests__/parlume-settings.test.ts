/**
 * The meeting-assistant settings procedures. The Attendee key is a secret the
 * organization hands Fabric: it is stored encrypted, shown only by its last
 * four characters, never audited, and never sent to a URL the operator's key
 * does not belong to.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findUnique: vi.fn(),
	upsert: vi.fn(),
	isFeatureEnabled: vi.fn(),
	recordAudit: vi.fn(),
	checkConnection: vi.fn(),
	checkHosts: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		organizationParlumeSettings: {
			findUnique: mocks.findUnique,
			upsert: mocks.upsert,
		},
	},
	isFeatureEnabled: mocks.isFeatureEnabled,
}));

vi.mock("@repo/utils", () => ({
	encryptApiKey: (key: string) => `encrypted:${key}`,
	decryptApiKey: (value: string) => value.replace(/^encrypted:/, ""),
}));

vi.mock("../../../../lib/audit", () => ({
	recordAuditFromRequest: mocks.recordAudit,
}));

vi.mock("../../../projects/lib/parlume-attendee", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../projects/lib/parlume-attendee")
	>()),
	checkAttendeeConnection: mocks.checkConnection,
}));

vi.mock("../../../projects/lib/parlume-realtime-session", () => ({
	checkParlumeRealtimeHosts: mocks.checkHosts,
}));

vi.mock("../../../../orpc/procedures", () => {
	interface Chain {
		use: (middleware: { permission: string }) => Chain;
		route: () => Chain;
		input: () => Chain;
		output: () => Chain;
		handler: (fn: (...args: never[]) => Promise<unknown>) => unknown;
	}
	const chain = (permission: string | null): Chain => ({
		use: (middleware) => chain(middleware.permission),
		route: () => chain(permission),
		input: () => chain(permission),
		output: () => chain(permission),
		handler: (fn) => ({ _handler: fn, permission }),
	});
	return {
		tenantProtectedProcedure: chain(null),
		requireInputOrgPermission: (
			permission: string,
			options: { requireOrganization?: boolean },
		) => ({
			permission: options.requireOrganization
				? `${permission}:org-required`
				: permission,
		}),
		Permissions: {
			ORG_INTEGRATIONS_READ: "org:integrations:read",
			ORG_INTEGRATIONS_MANAGE: "org:integrations:manage",
		},
	};
});

import { getParlumeSettings } from "../get-parlume-settings";
import {
	testParlumeAttendeeConnection,
	testParlumeRealtimeVoice,
} from "../test-parlume-connections";
import { updateParlumeSettings } from "../update-parlume-settings";

interface Procedure {
	_handler: (args: { input: unknown; context: unknown }) => Promise<unknown>;
	permission: string | null;
}

const context = {
	user: { id: "user-1", email: "admin@example.com" },
	session: { id: "s1", activeOrganizationId: "org-1" },
};

function call(procedure: unknown, input: Record<string, unknown> = {}) {
	return (procedure as Procedure)._handler({
		input: { organizationId: "org-1", ...input },
		context,
	});
}

const SAVED_KEY = "attendee-saved-key-1234";
const NEW_KEY = "attendee-new-key-abcd9876";

function storedRow(overrides: Record<string, unknown> = {}) {
	return {
		encryptedAttendeeApiKey: `encrypted:${SAVED_KEY}`,
		attendeeBaseUrl: null,
		teamsLoginMode: null,
		realtimeDeployment: null,
		updatedAt: new Date("2026-10-26T12:00:00Z"),
		...overrides,
	};
}

function savedData() {
	return mocks.upsert.mock.calls[0][0].update;
}

beforeEach(() => {
	vi.resetAllMocks();
	vi.stubEnv("PARLUME_ATTENDEE_API_KEY", "");
	vi.stubEnv("PARLUME_ATTENDEE_BASE_URL", "");
	vi.stubEnv("PARLUME_ATTENDEE_TEAMS_LOGIN", "");
	vi.stubEnv("PARLUME_ATTENDEE_ALLOWED_HOSTS", "");
	mocks.isFeatureEnabled.mockResolvedValue(true);
	mocks.findUnique.mockResolvedValue(storedRow());
	mocks.upsert.mockResolvedValue(undefined);
	mocks.checkConnection.mockResolvedValue({ status: "ok" });
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("Parlume settings permissions", () => {
	it("reads with the integrations read permission and changes with manage, in an organization only", () => {
		expect((getParlumeSettings as unknown as Procedure).permission).toBe(
			"org:integrations:read:org-required",
		);
		for (const procedure of [
			updateParlumeSettings,
			testParlumeAttendeeConnection,
			testParlumeRealtimeVoice,
		]) {
			expect((procedure as unknown as Procedure).permission).toBe(
				"org:integrations:manage:org-required",
			);
		}
	});

	it("hides the settings while the rollout gate is off", async () => {
		mocks.isFeatureEnabled.mockResolvedValue(false);

		await expect(call(getParlumeSettings)).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		await expect(
			call(updateParlumeSettings, { attendeeApiKey: NEW_KEY }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.isFeatureEnabled).toHaveBeenCalledWith(
			"PARLUME_MEETINGS",
			"org-1",
		);
		expect(mocks.upsert).not.toHaveBeenCalled();
	});
});

describe("getParlumeSettings", () => {
	it("shows only the last four characters of the saved key", async () => {
		const view = await call(getParlumeSettings);

		expect(view).toMatchObject({
			attendee: {
				maskedApiKey: "••••1234",
				baseUrl: null,
				teamsLoginMode: null,
				effectiveSource: "organization",
			},
			voice: { realtimeDeployment: null },
			defaults: {
				attendeeBaseUrl: "https://app.attendee.dev",
				realtimeDeployment: "gpt-realtime-2.1",
			},
		});
		expect(JSON.stringify(view)).not.toContain(SAVED_KEY);
		expect(JSON.stringify(view)).not.toContain("encrypted:");
	});

	it("says invitations use the operator's project when the organization saved no key", async () => {
		mocks.findUnique.mockResolvedValue(null);
		vi.stubEnv("PARLUME_ATTENDEE_API_KEY", "operator-key");

		const view = await call(getParlumeSettings);

		expect(view).toMatchObject({
			attendee: { maskedApiKey: null, effectiveSource: "environment" },
		});
		expect(JSON.stringify(view)).not.toContain("operator-key");
	});
});

describe("updateParlumeSettings", () => {
	it("encrypts a new key and audits that it changed, never the key itself", async () => {
		await call(updateParlumeSettings, {
			attendeeApiKey: `  ${NEW_KEY}  `,
			teamsLoginMode: "always",
		});

		expect(mocks.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { organizationId: "org-1" },
				create: expect.objectContaining({ organizationId: "org-1" }),
			}),
		);
		expect(savedData()).toEqual({
			encryptedAttendeeApiKey: `encrypted:${NEW_KEY}`,
			attendeeBaseUrl: null,
			teamsLoginMode: "ALWAYS",
			updatedById: "user-1",
		});
		expect(mocks.recordAudit).toHaveBeenCalledWith(
			context,
			expect.objectContaining({
				action: "org.integration.config_updated",
				organizationId: "org-1",
				resource: expect.objectContaining({ id: "parlume" }),
				metadata: {
					keyChanged: true,
					keyCleared: false,
					customAttendeeUrl: false,
					teamsLoginMode: "ALWAYS",
					realtimeDeploymentSet: false,
				},
			}),
		);
		const audited = JSON.stringify(mocks.recordAudit.mock.calls);
		expect(audited).not.toContain(NEW_KEY);
		expect(audited).not.toContain(NEW_KEY.slice(-4));
	});

	it("keeps the stored key when the key field is left empty and the URL is unchanged", async () => {
		mocks.findUnique.mockResolvedValue(
			storedRow({ attendeeBaseUrl: "https://attendee.example.com" }),
		);

		await call(updateParlumeSettings, {
			attendeeApiKey: "   ",
			attendeeBaseUrl: "https://attendee.example.com/api/v1/",
			teamsLoginMode: "always",
		});

		expect(savedData()).not.toHaveProperty("encryptedAttendeeApiKey");
		expect(savedData()).toMatchObject({
			attendeeBaseUrl: "https://attendee.example.com",
			teamsLoginMode: "ALWAYS",
		});
		expect(mocks.recordAudit.mock.calls[0][1].metadata).toMatchObject({
			keyChanged: false,
			customAttendeeUrl: true,
		});
		expect(JSON.stringify(mocks.recordAudit.mock.calls)).not.toContain(
			"attendee.example.com",
		);
	});

	it.each([
		["to a new host", null, "https://attendee.example.com"],
		["back to the default", "https://attendee.example.com", null],
		[
			"from one host to another",
			"https://attendee.example.com",
			"https://other-attendee.example.com",
		],
	])(
		"refuses to point the stored key %s without the key typed again",
		async (_label, storedUrl, attendeeBaseUrl) => {
			mocks.findUnique.mockResolvedValue(
				storedRow({ attendeeBaseUrl: storedUrl }),
			);

			await expect(
				call(updateParlumeSettings, {
					attendeeApiKey: "",
					attendeeBaseUrl,
				}),
			).rejects.toMatchObject({
				code: "BAD_REQUEST",
				message:
					"Enter the Attendee API key again to change the Attendee URL.",
			});
			expect(mocks.upsert).not.toHaveBeenCalled();
			expect(mocks.recordAudit).not.toHaveBeenCalled();
		},
	);

	it("changes the URL when the key is typed again in the same request", async () => {
		await call(updateParlumeSettings, {
			attendeeApiKey: NEW_KEY,
			attendeeBaseUrl: "https://attendee.example.com",
		});

		expect(savedData()).toMatchObject({
			encryptedAttendeeApiKey: `encrypted:${NEW_KEY}`,
			attendeeBaseUrl: "https://attendee.example.com",
		});
	});

	it("removes the key together with the URL and Teams sign-in it belongs to", async () => {
		mocks.findUnique.mockResolvedValue(
			storedRow({
				attendeeBaseUrl: "https://attendee.example.com",
				teamsLoginMode: "ALWAYS",
				realtimeDeployment: "example-realtime",
			}),
		);

		await call(updateParlumeSettings, { clearAttendeeApiKey: true });

		expect(savedData()).toEqual({
			encryptedAttendeeApiKey: null,
			attendeeBaseUrl: null,
			teamsLoginMode: null,
			updatedById: "user-1",
		});
		expect(mocks.recordAudit.mock.calls[0][1].metadata).toMatchObject({
			keyCleared: true,
			realtimeDeploymentSet: true,
		});
	});

	it("refuses a new key and a removal in one request", async () => {
		await expect(
			call(updateParlumeSettings, {
				attendeeApiKey: NEW_KEY,
				clearAttendeeApiKey: true,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.upsert).not.toHaveBeenCalled();
	});

	it("refuses a key with spaces in it", async () => {
		await expect(
			call(updateParlumeSettings, { attendeeApiKey: "not a key value" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it.each([
		{ attendeeBaseUrl: "https://attendee.example.com" },
		{ teamsLoginMode: "only_if_required" },
	])(
		"refuses %o without the organization's own key, so the operator's key never meets it",
		async (input) => {
			mocks.findUnique.mockResolvedValue(null);

			await expect(
				call(updateParlumeSettings, input),
			).rejects.toMatchObject({
				code: "BAD_REQUEST",
				message: expect.stringContaining("Attendee API key"),
			});
			expect(mocks.upsert).not.toHaveBeenCalled();
		},
	);

	it.each([
		"http://attendee.example.com",
		"https://attendee.example.com/?token=secret",
		"https://user:pass@attendee.example.com",
		"https://169.254.169.254",
	])("refuses to save the Attendee URL %s", async (attendeeBaseUrl) => {
		await expect(
			call(updateParlumeSettings, { attendeeBaseUrl }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.upsert).not.toHaveBeenCalled();
	});

	it("saves a realtime deployment name the bridge accepts and refuses others", async () => {
		await call(updateParlumeSettings, {
			realtimeDeployment: " example-realtime ",
		});
		expect(savedData().realtimeDeployment).toBe("example-realtime");

		await expect(
			call(updateParlumeSettings, {
				realtimeDeployment: "Example Realtime",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("clears the deployment name back to the model id on an empty value", async () => {
		await call(updateParlumeSettings, { realtimeDeployment: "" });

		expect(savedData().realtimeDeployment).toBeNull();
	});
});

describe("testParlumeAttendeeConnection", () => {
	it("tests a typed key against the typed URL", async () => {
		mocks.checkConnection.mockResolvedValue({
			status: "invalid_key",
			httpStatus: 401,
		});

		await expect(
			call(testParlumeAttendeeConnection, {
				attendeeApiKey: NEW_KEY,
				attendeeBaseUrl: "https://attendee.example.com/",
			}),
		).resolves.toEqual({ status: "invalid_key", httpStatus: 401 });
		expect(mocks.checkConnection).toHaveBeenCalledWith({
			apiKey: NEW_KEY,
			baseUrl: "https://attendee.example.com",
		});
	});

	it("tests the saved key when the key field is empty", async () => {
		await call(testParlumeAttendeeConnection, { attendeeBaseUrl: "" });

		expect(mocks.checkConnection).toHaveBeenCalledWith({
			apiKey: SAVED_KEY,
			baseUrl: "https://app.attendee.dev",
		});
	});

	it("tests the saved key against its own saved URL", async () => {
		mocks.findUnique.mockResolvedValue(
			storedRow({ attendeeBaseUrl: "https://attendee.example.com" }),
		);

		await call(testParlumeAttendeeConnection, {
			attendeeBaseUrl: "https://attendee.example.com/",
		});

		expect(mocks.checkConnection).toHaveBeenCalledWith({
			apiKey: SAVED_KEY,
			baseUrl: "https://attendee.example.com",
		});
	});

	it.each([
		[null, "https://attendee.example.com"],
		["https://attendee.example.com", ""],
	])(
		"never sends the saved key (saved URL %s) to a different URL (%s)",
		async (storedUrl, attendeeBaseUrl) => {
			mocks.findUnique.mockResolvedValue(
				storedRow({ attendeeBaseUrl: storedUrl }),
			);

			await expect(
				call(testParlumeAttendeeConnection, { attendeeBaseUrl }),
			).rejects.toMatchObject({
				code: "BAD_REQUEST",
				message:
					"Enter the Attendee API key again to change the Attendee URL.",
			});
			expect(mocks.checkConnection).not.toHaveBeenCalled();
		},
	);

	it("tests the operator's project as configured, but never sends its key to a typed URL", async () => {
		mocks.findUnique.mockResolvedValue(null);
		vi.stubEnv("PARLUME_ATTENDEE_API_KEY", "operator-key");

		await call(testParlumeAttendeeConnection);
		expect(mocks.checkConnection).toHaveBeenCalledWith({
			apiKey: "operator-key",
			baseUrl: "https://app.attendee.dev",
		});

		mocks.checkConnection.mockClear();
		await expect(
			call(testParlumeAttendeeConnection, {
				attendeeBaseUrl: "https://attendee.example.com",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.checkConnection).not.toHaveBeenCalled();
	});

	it("refuses to call an internal address", async () => {
		await expect(
			call(testParlumeAttendeeConnection, {
				attendeeApiKey: NEW_KEY,
				attendeeBaseUrl: "https://169.254.169.254",
			}),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: expect.stringContaining("PARLUME_ATTENDEE_ALLOWED_HOSTS"),
		});
		expect(mocks.checkConnection).not.toHaveBeenCalled();
	});
});

describe("testParlumeRealtimeVoice", () => {
	it("checks the organization's realtime hosts for the caller", async () => {
		const hosts = [
			{
				provider: "AZURE_AI_FOUNDRY",
				model: "example-realtime",
				ok: true,
				status: null,
				message: null,
			},
		];
		mocks.checkHosts.mockResolvedValue(hosts);

		await expect(call(testParlumeRealtimeVoice)).resolves.toEqual({
			hosts,
		});
		expect(mocks.checkHosts).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "org-1",
		});
	});
});
