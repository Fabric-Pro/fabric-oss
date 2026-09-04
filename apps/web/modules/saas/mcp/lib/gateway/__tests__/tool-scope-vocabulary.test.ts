/**
 * Every scope the platform tools demand can actually be granted (Fizzy #2380).
 *
 * Three lists have to agree and none of them knows about the others: what the
 * MCP tools require, what the create procedure accepts, and what the settings
 * picker offers. Two ways for that to go wrong, and both had already happened:
 *
 *  - A tool demands a scope the procedure rejects, so no key can ever be made
 *    that reaches it. Adding `features:read` to the tool map before adding it
 *    to the vocabulary would have done exactly this — an organization key could
 *    tick "Projects Read" and still be refused on `fabric_list_features`, with
 *    nothing in the interface to explain why.
 *  - The procedure accepts a scope the picker never shows, so it exists but is
 *    unreachable. The picker was five scopes behind: `audit_log:read`,
 *    `audit_log:export`, `system_health:read`, `status_updates:read` and `*`.
 *
 * This is a static consistency check, not a behavioural one — the enforcement
 * itself is covered in `tool-scope-enforcement.test.ts`.
 */

import { ORG_API_KEY_SCOPES } from "@repo/api/modules/organizations/procedures/api-keys/create";
import { describe, expect, it } from "vitest";
import { AVAILABLE_SCOPES } from "../../../../organizations/components/OrganizationApiKeysSettings";
import { TOOL_SCOPES } from "../platform-tools";

const accepted = new Set<string>(ORG_API_KEY_SCOPES);
const offered = new Set(AVAILABLE_SCOPES.map((scope) => scope.id));

describe("the scope vocabularies agree", () => {
	it("every scope a tool requires can be granted to an organization key", () => {
		const ungrantable = [
			...new Set(Object.values(TOOL_SCOPES).map((s) => s.scope)),
		]
			.filter((scope) => !accepted.has(scope))
			.sort();

		expect(ungrantable).toEqual([]);
	});

	it("every scope a tool requires is offered in the settings picker", () => {
		const unofferable = [
			...new Set(Object.values(TOOL_SCOPES).map((s) => s.scope)),
		]
			.filter((scope) => !offered.has(scope))
			.sort();

		expect(unofferable).toEqual([]);
	});

	// `*` is accepted by the procedure and deliberately absent from the picker.
	// A "full access" checkbox sitting beside twenty fine-grained ones invites
	// the click that makes the other twenty pointless; a key that broad should
	// take a deliberate API call, not a tick.
	it("the picker offers everything the procedure accepts, bar the wildcard", () => {
		const missing = ORG_API_KEY_SCOPES.filter(
			(scope) => scope !== "*" && !offered.has(scope),
		).sort();

		expect(missing).toEqual([]);
	});

	it("the picker offers nothing the procedure would reject", () => {
		const rejected = [...offered].filter((s) => !accepted.has(s)).sort();

		expect(rejected).toEqual([]);
	});
});
