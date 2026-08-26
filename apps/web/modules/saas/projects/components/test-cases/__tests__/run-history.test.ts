import { describe, expect, it } from "vitest";
import { resolveRunActor } from "../run-history";

/**
 * `resolveRunActor` decides who/what to credit for a run event with safe
 * fallbacks so a history row never renders a blank actor. It stays i18n-free —
 * the component substitutes an "unknown" label when this returns `null`.
 */
describe("resolveRunActor", () => {
	it("credits the PM provenance label for a PM_SYNC event", () => {
		expect(
			resolveRunActor({
				source: "PM_SYNC",
				actorLabel: "Azure DevOps · run 123",
				changedByUser: null,
			}),
		).toEqual({ source: "PM_SYNC", label: "Azure DevOps · run 123" });
	});

	it("falls back to null (not the user) when a PM_SYNC event has no label", () => {
		// PM_SYNC provenance is the actorLabel only — never a Fabric user, even if
		// one is somehow present — so the source distinction stays trustworthy.
		expect(
			resolveRunActor({
				source: "PM_SYNC",
				actorLabel: "  ",
				changedByUser: { name: "Jane Doe", email: "jane@acme.test" },
			}),
		).toEqual({ source: "PM_SYNC", label: null });
	});

	it("credits the CI provenance label for a PIPELINE event, never a user", () => {
		expect(
			resolveRunActor({
				source: "PIPELINE",
				actorLabel: "GitHub Actions · run 42",
				changedByUser: { name: "Jane Doe", email: "jane@acme.test" },
			}),
		).toEqual({ source: "PIPELINE", label: "GitHub Actions · run 42" });
	});

	it("credits the acting user's name for a MANUAL mark", () => {
		expect(
			resolveRunActor({
				source: "MANUAL",
				actorLabel: null,
				changedByUser: { name: "Jane Doe", email: "jane@acme.test" },
			}),
		).toEqual({ source: "MANUAL", label: "Jane Doe" });
	});

	it("falls back to the user's email when the name is blank", () => {
		expect(
			resolveRunActor({
				source: "MANUAL",
				actorLabel: null,
				changedByUser: { name: "   ", email: "jane@acme.test" },
			}),
		).toEqual({ source: "MANUAL", label: "jane@acme.test" });
	});

	it("returns a null label for a MANUAL mark with no resolvable user", () => {
		expect(
			resolveRunActor({
				source: "MANUAL",
				actorLabel: null,
				changedByUser: null,
			}),
		).toEqual({ source: "MANUAL", label: null });
	});
});
