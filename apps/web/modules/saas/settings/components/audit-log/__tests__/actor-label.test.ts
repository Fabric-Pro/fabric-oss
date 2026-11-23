import { describe, expect, it } from "vitest";
import { auditActingFor, auditActorLabel } from "../actor-label";

const t = (key: string) => key;

function actor(over: Partial<Parameters<typeof auditActorLabel>[0]> = {}) {
	return {
		actorType: "user",
		actorEmailSnapshot: "dana@example.com",
		actorNameSnapshot: "Dana Member",
		metadata: null,
		...over,
	};
}

describe("auditActorLabel", () => {
	it("names a person by their email", () => {
		expect(auditActorLabel(actor(), t)).toBe("dana@example.com");
	});

	it("names an agent acting for a member by the agent", () => {
		expect(
			auditActorLabel(
				actor({
					actorType: "agent",
					actorEmailSnapshot: null,
					actorNameSnapshot: "Fabric Parlume",
				}),
				t,
			),
		).toBe("Fabric Parlume");
	});

	it("falls back to the email, then the system, for an unnamed agent", () => {
		expect(
			auditActorLabel(
				actor({ actorType: "agent", actorNameSnapshot: null }),
				t,
			),
		).toBe("dana@example.com");
		expect(
			auditActorLabel(
				actor({
					actorType: "agent",
					actorEmailSnapshot: null,
					actorNameSnapshot: null,
				}),
				t,
			),
		).toBe("settings.auditLog.badges.system");
	});

	it("names an API key by its name, then its prefix", () => {
		expect(
			auditActorLabel(
				actor({
					actorType: "api_key",
					actorEmailSnapshot: null,
					actorNameSnapshot: "SRE laptop",
				}),
				t,
			),
		).toBe("SRE laptop");
		expect(
			auditActorLabel(
				actor({
					actorType: "api_key",
					actorEmailSnapshot: null,
					actorNameSnapshot: null,
					metadata: { keyPrefix: "org_aaaaaaaa" },
				}),
				t,
			),
		).toBe("org_aaaaaaaa");
	});

	it("shows the system for a row with no actor email", () => {
		expect(
			auditActorLabel(
				actor({
					actorType: "system",
					actorEmailSnapshot: null,
					actorNameSnapshot: null,
				}),
				t,
			),
		).toBe("settings.auditLog.badges.system");
	});
});

describe("auditActingFor", () => {
	it("gives the email of the person an agent acted for", () => {
		expect(
			auditActingFor(
				actor({
					actorType: "agent",
					actorNameSnapshot: "Fabric Parlume",
				}),
			),
		).toBe("dana@example.com");
	});

	it("gives nothing for a person, an API key or the system", () => {
		expect(auditActingFor(actor())).toBeNull();
		expect(
			auditActingFor(
				actor({
					actorType: "api_key",
					actorNameSnapshot: "SRE laptop",
				}),
			),
		).toBeNull();
		expect(
			auditActingFor(
				actor({
					actorType: "system",
					actorEmailSnapshot: null,
					actorNameSnapshot: null,
				}),
			),
		).toBeNull();
	});

	it("gives nothing for an agent with no email, or one already named by it", () => {
		expect(
			auditActingFor(
				actor({
					actorType: "agent",
					actorEmailSnapshot: null,
					actorNameSnapshot: "Fabric Parlume",
				}),
			),
		).toBeNull();
		expect(
			auditActingFor(
				actor({ actorType: "agent", actorNameSnapshot: null }),
			),
		).toBeNull();
	});
});
