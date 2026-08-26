/**
 * Action catalog coverage tests.
 *
 * Asserts every closed-taxonomy action key in the spec gets a descriptor
 * (label, icon, default severity, category) and that `describeAction`
 * falls back gracefully for unknown keys.
 */

import { describe, expect, it } from "vitest";
import {
	ACTION_CATALOG,
	describeAction,
	resourceIcon,
} from "../action-catalog";

const EXPECTED_KEYS = [
	// auth (8)
	"auth.login.success",
	"auth.login.failure",
	"auth.logout",
	"auth.mfa.enabled",
	"auth.mfa.disabled",
	"auth.password.changed",
	"auth.impersonation.started",
	"auth.impersonation.ended",
	// org (12)
	"org.created",
	"org.updated",
	"org.deleted",
	"org.settings.updated",
	"org.member.invited",
	"org.member.role_changed",
	"org.member.removed",
	"org.api_key.created",
	"org.api_key.revoked",
	"org.integration.connected",
	"org.integration.disconnected",
	"org.integration.config_updated",
	// project (10)
	"project.created",
	"project.meeting_digest.inclusion_changed",
	"project.updated",
	"project.archived",
	"project.deleted",
	"project.member.invited",
	"project.member.role_changed",
	"project.member.function_tags_changed",
	"project.member.function_tags_confirmed",
	"project.member.removed",
	// story (6)
	"story.created",
	"story.updated",
	"story.reprioritized",
	"story.deleted",
	"story.status_changed",
	"story.pm_pushed",
	// audit (3)
	// document assistant conversations (6)
	"document_assistant.conversation.created",
	"document_assistant.conversation.renamed",
	"document_assistant.conversation.archived",
	"document_assistant.conversation.deleted",
	"document_assistant.conversation.spilled",
	"document_assistant.conversation.visibility_changed",
	"audit.viewed",
	"audit.exported",
	"audit.retention.purged",
	// error (8)
	"error.permission_denied",
	"error.not_found",
	"error.validation",
	"error.rate_limited",
	"error.unavailable",
	"error.timeout",
	"error.conflict",
	"error.internal",
	// incident (6)
	"incident.fired",
	"incident.re_fired",
	"incident.acknowledged",
	"incident.commented",
	"incident.auto_resolved",
	"incident.manual_resolved",
];

describe("ACTION_CATALOG", () => {
	it("covers every closed-taxonomy key (45 success + 8 error + 6 incident = 59)", () => {
		// 8 auth + 12 org + 10 project + 6 story + 6 document_assistant +
		// 3 audit = 45 success keys, plus 8 open-namespace error keys (D16)
		// and 6 incident bridge keys (D17). The task spec's "27 success"
		// figure predates the org / audit / incident additions that landed
		// in Phase 2. Task 7 (Role/Function Tags Stage 1) adds
		// `project.member.function_tags_changed`; Fizzy #2264 adds
		// `project.member.function_tags_confirmed`; the roadmap Priority
		// feature adds `story.reprioritized` (one row per AI run).
		expect(EXPECTED_KEYS.length).toBe(59);
		for (const key of EXPECTED_KEYS) {
			expect(ACTION_CATALOG[key]).toBeDefined();
		}
	});

	it("every descriptor has a non-empty label and an icon", () => {
		for (const [key, descriptor] of Object.entries(ACTION_CATALOG)) {
			expect(descriptor.key, `key for ${key}`).toBe(key);
			expect(
				typeof descriptor.label === "string" &&
					descriptor.label.length > 0,
				`label for ${key}`,
			).toBe(true);
			expect(descriptor.icon, `icon for ${key}`).toBeDefined();
			expect(descriptor.defaultSeverity, `severity for ${key}`).toMatch(
				/^(info|warning|error|critical)$/,
			);
			expect(descriptor.category, `category for ${key}`).toMatch(
				/^(auth|org|project|story|audit|error|incident|weave)$/,
			);
		}
	});

	it("login failure is a warning, not info", () => {
		expect(ACTION_CATALOG["auth.login.failure"]?.defaultSeverity).toBe(
			"warning",
		);
	});

	it("incident.fired surfaces as error severity", () => {
		expect(ACTION_CATALOG["incident.fired"]?.defaultSeverity).toBe("error");
	});

	it("error.internal surfaces as error severity", () => {
		expect(ACTION_CATALOG["error.internal"]?.defaultSeverity).toBe("error");
	});
});

describe("describeAction", () => {
	it("returns the catalog entry for a known key", () => {
		const d = describeAction("auth.login.success");
		expect(d.label).toBe("Sign-in success");
		expect(d.category).toBe("auth");
	});

	it("returns the unknown fallback for an unrecognized key", () => {
		const d = describeAction("totally.made.up");
		expect(d.label).toBe("Unknown action");
		expect(d.category).toBe("unknown");
		// preserves the raw key for display
		expect(d.key).toBe("totally.made.up");
	});

	it("is safe for empty string", () => {
		const d = describeAction("");
		expect(d.category).toBe("unknown");
	});
});

describe("resourceIcon", () => {
	it("returns an icon for each known resource type", () => {
		expect(resourceIcon("user")).toBeDefined();
		expect(resourceIcon("project")).toBeDefined();
		expect(resourceIcon("story")).toBeDefined();
		expect(resourceIcon("organization")).toBeDefined();
		expect(resourceIcon("api_key")).toBeDefined();
		expect(resourceIcon("integration")).toBeDefined();
	});

	it("returns the file fallback for unknown / null", () => {
		const known = resourceIcon("user");
		const unknown = resourceIcon("nonsense");
		const nullCase = resourceIcon(null);
		expect(unknown).toBeDefined();
		expect(nullCase).toBeDefined();
		// unknown and null both resolve to the generic file icon, distinct
		// from the user icon
		expect(unknown).toBe(nullCase);
		expect(unknown).not.toBe(known);
	});
});
