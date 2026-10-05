/**
 * `resolveGitLabPMSource` serves a project's PM container, which names a
 * project on ONE GitLab instance (recorded next to it as `gitlabOrigin`; none
 * recorded means gitlab.com). A caller whose GitLab is on another instance is
 * refused before anything is sent: the same id there is an unrelated project.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveGitLabSource = vi.hoisted(() => vi.fn());
vi.mock("../../src/gitlab/source", async (importOriginal) => ({
	...(await importOriginal<object>()),
	resolveGitLabSource: (...args: unknown[]) => resolveGitLabSource(...args),
}));

import {
	GitLabPmOriginMismatchError,
	resolveGitLabPMSource,
} from "../../src/gitlab/pm-adapter";
import {
	gitlabPmOriginMatches,
	recordedGitLabPmOrigin,
	withGitLabPmOrigin,
} from "../../src/gitlab/pm-origin";

function restSource(apiBase: string) {
	return {
		kind: "rest-adapter",
		credential: { token: "connection-token", apiBase },
	};
}

const tenant = { userId: "user-1", organizationId: "org-1" };

beforeEach(() => {
	resolveGitLabSource.mockReset();
});

describe("resolveGitLabPMSource — the container's instance", () => {
	it("serves a gitlab.com connection for a container with no recorded instance", async () => {
		resolveGitLabSource.mockResolvedValue(
			restSource("https://gitlab.com/api/v4"),
		);

		await expect(
			resolveGitLabPMSource({ ...tenant, pmAdditionalContext: null }),
		).resolves.toMatchObject({ kind: "rest-adapter" });
	});

	it("refuses a self-hosted connection for a container chosen on gitlab.com", async () => {
		resolveGitLabSource.mockResolvedValue(
			restSource("https://gitlab.example.com/api/v4"),
		);

		await expect(
			resolveGitLabPMSource({ ...tenant, pmAdditionalContext: {} }),
		).rejects.toBeInstanceOf(GitLabPmOriginMismatchError);
	});

	it("refuses a gitlab.com connection for a container recorded on a self-hosted instance", async () => {
		resolveGitLabSource.mockResolvedValue(
			restSource("https://gitlab.com/api/v4"),
		);

		await expect(
			resolveGitLabPMSource({
				...tenant,
				pmAdditionalContext: {
					gitlabOrigin: "https://gitlab.example.com",
				},
			}),
		).rejects.toBeInstanceOf(GitLabPmOriginMismatchError);
	});

	it("serves a connection on the recorded instance, and reports no connection as before", async () => {
		resolveGitLabSource.mockResolvedValueOnce(
			restSource("https://gitlab.example.com/api/v4"),
		);
		await expect(
			resolveGitLabPMSource({
				...tenant,
				pmAdditionalContext: {
					gitlabOrigin: "https://gitlab.example.com",
				},
			}),
		).resolves.toMatchObject({ kind: "rest-adapter" });

		resolveGitLabSource.mockResolvedValueOnce(null);
		await expect(
			resolveGitLabPMSource({ ...tenant, pmAdditionalContext: null }),
		).resolves.toBeNull();
	});
});

describe("recorded GitLab PM origin", () => {
	it("reads none as gitlab.com and refuses an address no GitLab call may use", () => {
		expect(recordedGitLabPmOrigin(null)).toEqual({
			ok: true,
			origin: "https://gitlab.com",
		});
		expect(
			recordedGitLabPmOrigin({ gitlabOrigin: "http://gitlab.com" }).ok,
		).toBe(false);
		expect(
			recordedGitLabPmOrigin({ gitlabOrigin: "https://127.0.0.1" }).ok,
		).toBe(false);
		expect(
			gitlabPmOriginMatches(
				{ gitlabOrigin: "http://gitlab.com" },
				"http://gitlab.com",
			),
		).toBe(false);
		expect(gitlabPmOriginMatches(null, null)).toBe(false);
	});

	it("sets and clears the key without touching the others", () => {
		expect(
			withGitLabPmOrigin({ a: "1" }, "https://gitlab.example.com"),
		).toEqual({
			a: "1",
			gitlabOrigin: "https://gitlab.example.com",
		});
		expect(withGitLabPmOrigin({ a: "1", gitlabOrigin: "x" }, null)).toEqual(
			{
				a: "1",
			},
		);
	});
});
