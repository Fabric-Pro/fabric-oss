/**
 * The shared parts of a pull-request webhook delivery.
 *
 * This file used to test a SHARED endpoint — one deployment-wide secret, and a
 * handler that resolved the repository URL out of the payload to whichever
 * projects had connected it. That endpoint is retired, so those tests went with
 * it; the behaviour they covered now lives in
 * `project-pull-request-webhook.test.ts`, where the project is named in the URL
 * rather than inferred from the payload.
 *
 * One deleted test is worth remembering rather than merely removing. It set up
 * three projects in three DIFFERENT tenants and asserted that one signed delivery
 * started a review in all three — so the cross-tenant reach was not just
 * untested, it was pinned by a passing test that read as a feature.
 *
 * What remains is the URL-matching helper, which the old endpoint and the new one
 * need for the same reason: GitHub sends two spellings of a repository URL, and a
 * project stored whichever its connection flow produced.
 */

import { describe, expect, it } from "vitest";

import { repositoryUrlCandidates } from "../github-pull-request-webhook";

describe("repositoryUrlCandidates", () => {
	it("offers both spellings, most specific first, without duplicates", () => {
		expect(
			repositoryUrlCandidates({
				clone_url: "https://github.com/acme/widgets.git",
				html_url: "https://github.com/acme/widgets",
			}),
		).toEqual([
			"https://github.com/acme/widgets.git",
			"https://github.com/acme/widgets",
		]);
	});

	it("adds the .git form when only the browser URL is sent", () => {
		expect(
			repositoryUrlCandidates({
				html_url: "https://github.com/acme/widgets/",
			}),
		).toEqual([
			"https://github.com/acme/widgets",
			"https://github.com/acme/widgets.git",
		]);
	});

	it("returns nothing when the payload names no repository", () => {
		expect(repositoryUrlCandidates(undefined)).toEqual([]);
		expect(repositoryUrlCandidates({})).toEqual([]);
	});
});
