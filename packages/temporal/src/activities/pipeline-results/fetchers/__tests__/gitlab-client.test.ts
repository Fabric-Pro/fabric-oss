import { describe, expect, it } from "vitest";
import { gitlabApiBaseFromRepoUrl } from "../gitlab-client";

describe("gitlabApiBaseFromRepoUrl", () => {
	it("derives the /api/v4 base for public GitLab hosts", () => {
		expect(gitlabApiBaseFromRepoUrl("https://gitlab.com/acme/store")).toBe(
			"https://gitlab.com/api/v4",
		);
		expect(
			gitlabApiBaseFromRepoUrl(
				"https://gitlab.internal.corp:8443/team/app",
			),
		).toBe("https://gitlab.internal.corp:8443/api/v4");
		expect(gitlabApiBaseFromRepoUrl("http://10.0.0.5/team/app")).toBeNull();
	});

	it("rejects cloud-metadata hosts (SSRF guard)", () => {
		expect(
			gitlabApiBaseFromRepoUrl("http://169.254.169.254/acme/store"),
		).toBeNull();
		expect(
			gitlabApiBaseFromRepoUrl("http://metadata.google.internal/x/y"),
		).toBeNull();
		expect(
			gitlabApiBaseFromRepoUrl("http://[fd00:ec2::254]/x/y"),
		).toBeNull();
		expect(
			gitlabApiBaseFromRepoUrl("http://[::ffff:169.254.169.254]/x/y"),
		).toBeNull();
		expect(
			gitlabApiBaseFromRepoUrl("http://metadata.google.internal./x/y"),
		).toBeNull();
	});

	it("rejects non-http(s) schemes and unparseable URLs", () => {
		expect(gitlabApiBaseFromRepoUrl("file:///etc/passwd")).toBeNull();
		expect(gitlabApiBaseFromRepoUrl("ftp://gitlab.com/x")).toBeNull();
		expect(gitlabApiBaseFromRepoUrl("not a url")).toBeNull();
	});
});
