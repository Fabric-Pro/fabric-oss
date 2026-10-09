/**
 * Which access level a connected server's tool has, and which scopes reach it
 * (security audit of the MCP gateway, findings 1 and 2).
 *
 * A name like `get_` or `list_` is a guess. A person at a keyboard (a browser
 * session, their own personal key) is held to the guess only for deciding
 * whether a runtime grant is asked for. A delegated credential (an OAuth
 * sign-in, an `org_` key) acts for someone else, so it is held to what the
 * server itself declared.
 */

import { describe, expect, it } from "vitest";
import { classifyConnectedToolAccess } from "../authority-service";
import { scopeSatisfied } from "../tool-scope";
import type { GatewayCredential } from "../types";

const DELEGATED: GatewayCredential[] = ["oauth", "organization-key"];
const OWN: GatewayCredential[] = ["session", "personal-key"];

describe("classifyConnectedToolAccess", () => {
	it.each(DELEGATED)(
		"treats an unannotated get_/list_ tool as a write for %s",
		(credential) => {
			expect(
				classifyConnectedToolAccess(
					"linear__get_issue",
					undefined,
					credential,
				),
			).toBe("WRITE");
			expect(
				classifyConnectedToolAccess(
					"linear__list_issues",
					{},
					credential,
				),
			).toBe("WRITE");
		},
	);

	it.each(DELEGATED)(
		"treats a tool as a read for %s only when the server declares readOnlyHint",
		(credential) => {
			expect(
				classifyConnectedToolAccess(
					"linear__fetch_report",
					{ readOnlyHint: true },
					credential,
				),
			).toBe("READ");
			expect(
				classifyConnectedToolAccess(
					"linear__fetch_report",
					{ readOnlyHint: false },
					credential,
				),
			).toBe("WRITE");
		},
	);

	it.each(OWN)("keeps the name heuristic for %s", (credential) => {
		expect(
			classifyConnectedToolAccess(
				"linear__get_issue",
				undefined,
				credential,
			),
		).toBe("READ");
		expect(
			classifyConnectedToolAccess(
				"linear__delete_issue",
				undefined,
				credential,
			),
		).toBe("WRITE");
	});
});

describe("scopeSatisfied — personal data and the mcp:read umbrella", () => {
	const chats = { scope: "chats:read", kind: "read" } as const;
	const features = { scope: "features:read", kind: "read" } as const;

	it("does not let mcp:read reach a person's AI chats through an OAuth sign-in", () => {
		expect(scopeSatisfied(["mcp:read"], chats, "oauth")).toBe(false);
		expect(scopeSatisfied(["mcp:read", "mcp:write"], chats, "oauth")).toBe(
			false,
		);
	});

	it("still lets mcp:read reach the organization's projects through an OAuth sign-in", () => {
		expect(scopeSatisfied(["mcp:read"], features, "oauth")).toBe(true);
	});

	it.each(["organization-key", "personal-key", "session"] as const)(
		"keeps the umbrella over chats for %s",
		(credential) => {
			expect(scopeSatisfied(["mcp:read"], chats, credential)).toBe(true);
		},
	);
});
