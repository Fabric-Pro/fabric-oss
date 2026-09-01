import { describe, expect, it } from "vitest";
import {
	FEATURE_FLAG_REGISTRY,
	isFeatureFlagKey,
	resolveFlag,
} from "../lib/feature-flag-registry";

describe("FEATURE_FLAG_REGISTRY", () => {
	it("registers PERSONAL_MEETINGS with its env var and default", () => {
		expect(FEATURE_FLAG_REGISTRY.PERSONAL_MEETINGS.envVar).toBe(
			"FABRIC_FEATURE_PERSONAL_MEETINGS",
		);
		expect(FEATURE_FLAG_REGISTRY.PERSONAL_MEETINGS.default).toBe(false);
	});

	// #2170. This flag gates the only path that writes personal meeting content
	// to the database, so a default of `true` would publish it on deploy. The
	// assertion is on the default specifically, not just the env var name.
	it("registers MEETING_CONTEXT_IMPORT off by default", () => {
		expect(FEATURE_FLAG_REGISTRY.MEETING_CONTEXT_IMPORT.envVar).toBe(
			"FABRIC_FEATURE_MEETING_CONTEXT_IMPORT",
		);
		expect(FEATURE_FLAG_REGISTRY.MEETING_CONTEXT_IMPORT.default).toBe(
			false,
		);
	});

	// Independent of PERSONAL_MEETINGS on purpose: withdrawing the import must
	// not take the read-only personal lane down with it, and vice versa.
	it("resolves MEETING_CONTEXT_IMPORT independently of PERSONAL_MEETINGS", () => {
		expect(
			resolveFlag("MEETING_CONTEXT_IMPORT", true, {
				FABRIC_FEATURE_PERSONAL_MEETINGS: "false",
			}).enabled,
		).toBe(true);
		expect(
			resolveFlag("MEETING_CONTEXT_IMPORT", undefined, {
				FABRIC_FEATURE_PERSONAL_MEETINGS: "true",
			}).enabled,
		).toBe(false);
	});

	// #2210. The capability was gated twice before this entry existed — a runtime
	// server variable and a build-time public twin with a different parser. The
	// assertion is on the env var name specifically: keeping it is what lets an
	// existing deployment carry its setting across the migration unchanged.
	it("registers LIVING_DOCS_REFRESH as the rollout gate, on its own env var", () => {
		// The env var name is load-bearing. FABRIC_FEATURE_LIVING_DOCS_REFRESH is
		// the SWEEP kill switch and is true in every environment, so binding the
		// rollout to it would have launched the feature on deploy.
		expect(FEATURE_FLAG_REGISTRY.LIVING_DOCS_REFRESH.envVar).toBe(
			"FABRIC_FEATURE_LIVING_DOCS_REFRESH_ROLLOUT",
		);
		expect(FEATURE_FLAG_REGISTRY.LIVING_DOCS_REFRESH.default).toBe(false);
	});

	it("registers LIVING_DOCS_REFRESH_SWEEP on the original kill-switch env var", () => {
		expect(FEATURE_FLAG_REGISTRY.LIVING_DOCS_REFRESH_SWEEP.envVar).toBe(
			"FABRIC_FEATURE_LIVING_DOCS_REFRESH",
		);
		expect(FEATURE_FLAG_REGISTRY.LIVING_DOCS_REFRESH_SWEEP.default).toBe(
			false,
		);
	});

	// The two must stay independent: an operator holds "not rolled out" and
	// "brakes armed" at the same time, which is the state every environment is in
	// today. A change that makes one imply the other breaks that.
	it("resolves the rollout and sweep gates independently", () => {
		const env = { FABRIC_FEATURE_LIVING_DOCS_REFRESH: "true" };
		expect(
			resolveFlag("LIVING_DOCS_REFRESH_SWEEP", undefined, env).enabled,
		).toBe(true);
		expect(resolveFlag("LIVING_DOCS_REFRESH", undefined, env).enabled).toBe(
			false,
		);
	});

	// An admin's explicit OFF must beat a truthy env var, or the runtime switch
	// this flag was registered for would be unable to stop an in-flight refresh
	// on a deployment whose env var says on.
	it("lets an explicit LIVING_DOCS_REFRESH override beat a truthy env var", () => {
		const on = { FABRIC_FEATURE_LIVING_DOCS_REFRESH_ROLLOUT: "true" };
		expect(resolveFlag("LIVING_DOCS_REFRESH", false, on)).toEqual({
			enabled: false,
			source: "override",
		});
		expect(resolveFlag("LIVING_DOCS_REFRESH", undefined, on)).toEqual({
			enabled: true,
			source: "env",
		});
		expect(resolveFlag("LIVING_DOCS_REFRESH", undefined, {})).toEqual({
			enabled: false,
			source: "default",
		});
	});

	// The same override discipline on the brakes: an admin's OFF must stop an
	// in-flight sweep even though every environment sets the env var to true.
	it("lets an explicit LIVING_DOCS_REFRESH_SWEEP override beat a truthy env var", () => {
		expect(
			resolveFlag("LIVING_DOCS_REFRESH_SWEEP", false, {
				FABRIC_FEATURE_LIVING_DOCS_REFRESH: "true",
			}),
		).toEqual({ enabled: false, source: "override" });
	});

	it("registers PROJECT_SHORTCUTS with its env var and default", () => {
		expect(FEATURE_FLAG_REGISTRY.PROJECT_SHORTCUTS.envVar).toBe(
			"FABRIC_FEATURE_PROJECT_SHORTCUTS",
		);
		expect(FEATURE_FLAG_REGISTRY.PROJECT_SHORTCUTS.default).toBe(false);
	});

	it("registers PROJECT_FAVORITES with its env var and default", () => {
		expect(FEATURE_FLAG_REGISTRY.PROJECT_FAVORITES.envVar).toBe(
			"FABRIC_FEATURE_PROJECT_FAVORITES",
		);
		expect(FEATURE_FLAG_REGISTRY.PROJECT_FAVORITES.default).toBe(false);
	});

	// The two #1694 flags are deliberately independent: the shortcuts work from
	// recency alone, so a fault on the favorite write surface must not force the
	// shortcuts off with it.
	it("keeps the two project-shortcut flags independently resolvable", () => {
		expect(resolveFlag("PROJECT_FAVORITES", true, {}).enabled).toBe(true);
		expect(resolveFlag("PROJECT_SHORTCUTS", undefined, {}).enabled).toBe(
			false,
		);
	});
});

describe("resolveFlag", () => {
	it("prefers the override row over everything", () => {
		const env = { FABRIC_FEATURE_PERSONAL_MEETINGS: "false" };
		expect(resolveFlag("PERSONAL_MEETINGS", true, env)).toEqual({
			enabled: true,
			source: "override",
		});
	});

	it("honours an override of false over a truthy env var", () => {
		const env = { FABRIC_FEATURE_PERSONAL_MEETINGS: "true" };
		expect(resolveFlag("PERSONAL_MEETINGS", false, env)).toEqual({
			enabled: false,
			source: "override",
		});
	});

	it("falls back to the env var when no override exists", () => {
		const env = { FABRIC_FEATURE_PERSONAL_MEETINGS: "true" };
		expect(resolveFlag("PERSONAL_MEETINGS", undefined, env)).toEqual({
			enabled: true,
			source: "env",
		});
	});

	it("accepts the opt-in aliases the existing reader accepts", () => {
		for (const raw of ["true", "1", "on", "yes", "TRUE", " yes "]) {
			expect(
				resolveFlag("PERSONAL_MEETINGS", undefined, {
					FABRIC_FEATURE_PERSONAL_MEETINGS: raw,
				}).enabled,
			).toBe(true);
		}
	});

	it("falls back to the registry default when neither is set", () => {
		expect(resolveFlag("PERSONAL_MEETINGS", undefined, {})).toEqual({
			enabled: false,
			source: "default",
		});
	});
});

describe("isFeatureFlagKey", () => {
	it("accepts a registered key", () => {
		expect(isFeatureFlagKey("PERSONAL_MEETINGS")).toBe(true);
	});

	it("rejects an unregistered key", () => {
		expect(isFeatureFlagKey("PERSONAL_MEETNGS")).toBe(false);
		expect(isFeatureFlagKey("FABRIC_FEATURE_PERSONAL_MEETINGS")).toBe(
			false,
		);
	});
});

describe("MEETING_AGENDA", () => {
	it("is registered and defaults to off", () => {
		expect(isFeatureFlagKey("MEETING_AGENDA")).toBe(true);
		expect(FEATURE_FLAG_REGISTRY.MEETING_AGENDA.default).toBe(false);
		expect(FEATURE_FLAG_REGISTRY.MEETING_AGENDA.envVar).toBe(
			"FABRIC_FEATURE_MEETING_AGENDA",
		);
	});

	it("reads the flag's own env var when no override row exists", () => {
		const resolved = resolveFlag("MEETING_AGENDA", undefined, {
			FABRIC_FEATURE_MEETING_AGENDA: "true",
		} as NodeJS.ProcessEnv);
		expect(resolved).toEqual({ enabled: true, source: "env" });
	});

	it("falls back to the registry default when neither is set", () => {
		const resolved = resolveFlag(
			"MEETING_AGENDA",
			undefined,
			{} as NodeJS.ProcessEnv,
		);
		expect(resolved).toEqual({ enabled: false, source: "default" });
	});
});

describe("MEETING_ACTION_ITEM_LINKING", () => {
	it("is registered and defaults to off", () => {
		expect(isFeatureFlagKey("MEETING_ACTION_ITEM_LINKING")).toBe(true);
		expect(FEATURE_FLAG_REGISTRY.MEETING_ACTION_ITEM_LINKING.default).toBe(
			false,
		);
		expect(FEATURE_FLAG_REGISTRY.MEETING_ACTION_ITEM_LINKING.envVar).toBe(
			"FABRIC_FEATURE_MEETING_ACTION_ITEM_LINKING",
		);
	});

	it("reads the flag's own env var when no override row exists", () => {
		const resolved = resolveFlag("MEETING_ACTION_ITEM_LINKING", undefined, {
			FABRIC_FEATURE_MEETING_ACTION_ITEM_LINKING: "true",
		} as NodeJS.ProcessEnv);
		expect(resolved).toEqual({ enabled: true, source: "env" });
	});

	it("lets an explicit admin off-override beat a truthy env var", () => {
		const resolved = resolveFlag("MEETING_ACTION_ITEM_LINKING", false, {
			FABRIC_FEATURE_MEETING_ACTION_ITEM_LINKING: "true",
		} as NodeJS.ProcessEnv);
		expect(resolved).toEqual({ enabled: false, source: "override" });
	});

	it("falls back to the registry default when neither is set", () => {
		const resolved = resolveFlag(
			"MEETING_ACTION_ITEM_LINKING",
			undefined,
			{} as NodeJS.ProcessEnv,
		);
		expect(resolved).toEqual({ enabled: false, source: "default" });
	});
});

describe("PERSONAL_INSIGHTS_CACHE (#2104)", () => {
	it("is registered and defaults to off", () => {
		const flag = FEATURE_FLAG_REGISTRY.PERSONAL_INSIGHTS_CACHE;
		expect(flag).toBeDefined();
		expect(flag.default).toBe(false);
	});

	it("uses the conventional env var name", () => {
		expect(FEATURE_FLAG_REGISTRY.PERSONAL_INSIGHTS_CACHE.envVar).toBe(
			"FABRIC_FEATURE_PERSONAL_INSIGHTS_CACHE",
		);
	});

	it("is separate from PERSONAL_MEETINGS so it can be rolled back alone", () => {
		expect(FEATURE_FLAG_REGISTRY.PERSONAL_INSIGHTS_CACHE.envVar).not.toBe(
			FEATURE_FLAG_REGISTRY.PERSONAL_MEETINGS.envVar,
		);
	});
});

describe("UNIFIED_AGENT_INTERFACE", () => {
	it("is registered and defaults ON", () => {
		expect(isFeatureFlagKey("UNIFIED_AGENT_INTERFACE")).toBe(true);
		expect(FEATURE_FLAG_REGISTRY.UNIFIED_AGENT_INTERFACE.default).toBe(
			true,
		);
		expect(FEATURE_FLAG_REGISTRY.UNIFIED_AGENT_INTERFACE.envVar).toBe(
			"FABRIC_FEATURE_UNIFIED_AGENT_INTERFACE",
		);
	});

	it("serves the unified interface when nothing is configured", () => {
		const resolved = resolveFlag(
			"UNIFIED_AGENT_INTERFACE",
			undefined,
			{} as NodeJS.ProcessEnv,
		);
		expect(resolved).toEqual({ enabled: true, source: "default" });
	});

	it("rolls back from an admin override, which is the whole point of the flag", () => {
		const resolved = resolveFlag(
			"UNIFIED_AGENT_INTERFACE",
			false,
			{} as NodeJS.ProcessEnv,
		);
		expect(resolved).toEqual({ enabled: false, source: "override" });
	});

	it("rolls back from the env var, so a deploy can disable it without a database write", () => {
		// The reader only treats the opt-in aliases as true, so any other
		// value reads false — that is what lets a default-ON flag be turned
		// off through the same mechanism the opt-in flags use to turn on.
		const resolved = resolveFlag("UNIFIED_AGENT_INTERFACE", undefined, {
			FABRIC_FEATURE_UNIFIED_AGENT_INTERFACE: "false",
		} as NodeJS.ProcessEnv);
		expect(resolved).toEqual({ enabled: false, source: "env" });
	});

	it("lets an override of true win back over an env rollback", () => {
		const resolved = resolveFlag("UNIFIED_AGENT_INTERFACE", true, {
			FABRIC_FEATURE_UNIFIED_AGENT_INTERFACE: "false",
		} as NodeJS.ProcessEnv);
		expect(resolved).toEqual({ enabled: true, source: "override" });
	});
});

describe("NEWSLETTER_APPROVAL_CHAT (#2203)", () => {
	it("is registered and defaults ON", () => {
		expect(isFeatureFlagKey("NEWSLETTER_APPROVAL_CHAT")).toBe(true);
		expect(FEATURE_FLAG_REGISTRY.NEWSLETTER_APPROVAL_CHAT.default).toBe(
			true,
		);
		expect(FEATURE_FLAG_REGISTRY.NEWSLETTER_APPROVAL_CHAT.envVar).toBe(
			"FABRIC_FEATURE_NEWSLETTER_APPROVAL_CHAT",
		);
	});

	// The Bicep parameter that used to set this env var is deleted in the same
	// change, so nothing sets it in a deployed environment. This default is
	// what actually governs there — which is the whole point of the move.
	it("resolves ON when neither an override nor the env var is set", () => {
		expect(
			resolveFlag(
				"NEWSLETTER_APPROVAL_CHAT",
				undefined,
				{} as NodeJS.ProcessEnv,
			),
		).toEqual({ enabled: true, source: "default" });
	});

	it("rolls back from the env var, so a deploy can disable it with no database write", () => {
		expect(
			resolveFlag("NEWSLETTER_APPROVAL_CHAT", undefined, {
				FABRIC_FEATURE_NEWSLETTER_APPROVAL_CHAT: "false",
			} as NodeJS.ProcessEnv),
		).toEqual({ enabled: false, source: "env" });
	});

	// The admin console is the intended kill switch, so an override of false
	// must beat both a truthy env var and the ON default.
	//
	// Note this one assertion is NOT sensitive to registration: `resolveFlag`
	// returns from its override branch before it ever indexes the registry, so
	// this passed while NEWSLETTER_APPROVAL_CHAT did not exist. It is kept
	// because it states the kill-switch contract at this flag's level, not
	// because it covers the entry — the three above do that.
	it("lets an admin off-override beat a truthy env var", () => {
		expect(
			resolveFlag("NEWSLETTER_APPROVAL_CHAT", false, {
				FABRIC_FEATURE_NEWSLETTER_APPROVAL_CHAT: "true",
			} as NodeJS.ProcessEnv),
		).toEqual({ enabled: false, source: "override" });
	});
});

describe("ROLE_TAG_ENFORCEMENT", () => {
	it("is registered and defaults to false", () => {
		expect(FEATURE_FLAG_REGISTRY.ROLE_TAG_ENFORCEMENT).toBeDefined();
		expect(FEATURE_FLAG_REGISTRY.ROLE_TAG_ENFORCEMENT.default).toBe(false);
		expect(FEATURE_FLAG_REGISTRY.ROLE_TAG_ENFORCEMENT.envVar).toBe(
			"FABRIC_FEATURE_ROLE_TAG_ENFORCEMENT",
		);
	});

	it("resolves off when nothing is set, and an admin OFF beats a truthy env var", () => {
		expect(resolveFlag("ROLE_TAG_ENFORCEMENT", undefined, {}).enabled).toBe(
			false,
		);
		expect(
			resolveFlag("ROLE_TAG_ENFORCEMENT", undefined, {
				FABRIC_FEATURE_ROLE_TAG_ENFORCEMENT: "true",
			}).enabled,
		).toBe(true);
		expect(
			resolveFlag("ROLE_TAG_ENFORCEMENT", false, {
				FABRIC_FEATURE_ROLE_TAG_ENFORCEMENT: "true",
			}).enabled,
		).toBe(false);
	});
});

describe("PUBLISHING_INBOX", () => {
	it("is registered, defaults ON, and is seeded by its env var", () => {
		expect(FEATURE_FLAG_REGISTRY.PUBLISHING_INBOX).toBeDefined();
		expect(FEATURE_FLAG_REGISTRY.PUBLISHING_INBOX.default).toBe(true);
		expect(FEATURE_FLAG_REGISTRY.PUBLISHING_INBOX.envVar).toBe(
			"FABRIC_FEATURE_PUBLISHING_INBOX",
		);
	});

	// Nothing sets FABRIC_FEATURE_PUBLISHING_INBOX in any deployed
	// environment: no Bicep parameter, no workflow step, no .env template.
	// Every occurrence of the name is inert — this registry entry, these
	// tests, and the changeset that ships the flip (which is consumed and
	// deleted at release). That makes this default the thing that actually
	// governs staging and production, which is the whole point of flipping it
	// rather than setting an env var.
	it("resolves ON when neither an override nor the env var is set", () => {
		expect(resolveFlag("PUBLISHING_INBOX", undefined, {})).toEqual({
			enabled: true,
			source: "default",
		});
	});

	it("rolls back from the env var, so a deploy can disable it with no database write", () => {
		expect(
			resolveFlag("PUBLISHING_INBOX", undefined, {
				FABRIC_FEATURE_PUBLISHING_INBOX: "false",
			}),
		).toEqual({ enabled: false, source: "env" });
	});

	// An explicit admin OFF must beat a truthy env var — that is the whole
	// point of the override row, and the reason rollback needs no redeploy.
	//
	// This one assertion is NOT sensitive to registration: `resolveFlag`
	// returns from its override branch before it ever indexes the registry, so
	// it would pass even if the key did not exist. It is kept because it
	// states the kill-switch contract; the three above cover the entry.
	it("lets an admin off-override beat a truthy env var", () => {
		expect(
			resolveFlag("PUBLISHING_INBOX", false, {
				FABRIC_FEATURE_PUBLISHING_INBOX: "true",
			}),
		).toEqual({ enabled: false, source: "override" });
	});
});
