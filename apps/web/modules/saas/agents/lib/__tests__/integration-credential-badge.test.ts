import { describe, expect, it } from "vitest";
import { integrationCredentialBadge } from "../integration-credential-badge";

describe("integrationCredentialBadge", () => {
	it("asks for a reconnect on a GitLab connection whose grant died", () => {
		expect(
			integrationCredentialBadge({
				hasCredentials: false,
				connectionState: "needs-reconnect",
			}),
		).toBe("Reconnect");
	});

	it("keeps 'No creds' for an integration without credentials", () => {
		expect(integrationCredentialBadge({ hasCredentials: false })).toBe(
			"No creds",
		);
		expect(
			integrationCredentialBadge({
				hasCredentials: false,
				connectionState: "not-connected",
			}),
		).toBe("No creds");
	});

	it("shows no badge for a usable integration", () => {
		expect(
			integrationCredentialBadge({
				hasCredentials: true,
				connectionState: "connected",
			}),
		).toBeNull();
	});
});
