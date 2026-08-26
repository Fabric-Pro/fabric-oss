import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitlabPipelineApiBase, triggerGitlabPipeline } from "../gitlab";

const originalFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
	fetchMock = vi.fn();
	globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function reply(status: number, body: unknown = ""): Response {
	return new Response(
		typeof body === "string" ? body : JSON.stringify(body),
		{ status },
	);
}

const base = {
	token: "glpat-test",
	apiBase: "https://gitlab.com/api/v4",
	projectPath: "acme/store",
	ref: "main",
};

describe("triggerGitlabPipeline", () => {
	it("returns the created pipeline id and its web url", async () => {
		fetchMock.mockResolvedValue(
			reply(201, {
				id: 987,
				web_url: "https://gitlab.com/acme/store/-/pipelines/987",
			}),
		);

		const result = await triggerGitlabPipeline(base);

		expect(result).toEqual({
			ok: true,
			runId: "987",
			runUrl: "https://gitlab.com/acme/store/-/pipelines/987",
		});
	});

	it("drops a non-http run link rather than rendering it as an href", async () => {
		// `web_url` is whatever the GitLab host says, and self-managed instances
		// are supported — so the host is customer-controlled. React does not
		// sanitise href, so a javascript: value would become a live script link.
		// Losing the link is harmless; the run still started.
		fetchMock.mockResolvedValue(
			reply(201, { id: 5, web_url: "javascript:alert(document.cookie)" }),
		);

		const result = await triggerGitlabPipeline(base);

		expect(result).toEqual({ ok: true, runId: "5", runUrl: null });
	});

	it("keeps an ordinary https run link", async () => {
		fetchMock.mockResolvedValue(
			reply(201, {
				id: 5,
				web_url:
					"https://git.internal.acme.dev/acme/store/-/pipelines/5",
			}),
		);

		const result = await triggerGitlabPipeline(base);

		expect((result as { runUrl: string }).runUrl).toBe(
			"https://git.internal.acme.dev/acme/store/-/pipelines/5",
		);
	});

	it("url-encodes the namespaced project path", async () => {
		fetchMock.mockResolvedValue(reply(201, { id: 1 }));

		await triggerGitlabPipeline({
			...base,
			projectPath: "acme/sub/store",
		});

		expect(fetchMock.mock.calls[0][0]).toBe(
			"https://gitlab.com/api/v4/projects/acme%2Fsub%2Fstore/pipeline",
		);
	});

	it("sends variables in GitLab's key/value array shape, not a plain object", async () => {
		fetchMock.mockResolvedValue(reply(201, { id: 1 }));

		await triggerGitlabPipeline({ ...base, variables: { SUITE: "smoke" } });

		expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
			ref: "main",
			variables: [{ key: "SUITE", value: "smoke" }],
		});
	});

	it("distinguishes the api scope from read_api on a 403", async () => {
		// This is the whole point of the GitLab mapping: Fabric's ingestion works
		// with `read_api`, so a token that reads pipelines fine cannot create one,
		// and GitLab's own body does not explain that.
		fetchMock.mockResolvedValue(reply(403, { message: "403 Forbidden" }));

		const result = await triggerGitlabPipeline(base);

		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}
		expect(result.failure).toBe("INSUFFICIENT_SCOPE");
		expect(result.message).toContain("`api` scope");
		expect(result.message).toContain("read_api");
	});

	it("does not blame the ref for a 400 that is not about the ref", async () => {
		// GitLab 400s for unrelated validation failures too — a malformed variable
		// key, say. Calling that NOT_FOUND told the user their branch was missing
		// when their branch was fine.
		fetchMock.mockResolvedValue(
			reply(400, { message: { base: ["Variable key is invalid"] } }),
		);

		const result = await triggerGitlabPipeline({
			...base,
			variables: { "bad key": "x" },
		});

		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}
		expect(result.failure).toBe("PROVIDER_ERROR");
		expect(result.message).toContain("Variable key is invalid");
	});

	it("is not fooled by a variable key that merely contains 'branch'", async () => {
		// The body echoes the caller's own variable KEY back, so a keyword test
		// against the whole body is decided by what the user named their
		// variable: `BRANCH_OVERRIDE` would make an invalid-key error report
		// itself as a missing ref, sending them to check a branch that is fine.
		fetchMock.mockResolvedValue(
			reply(400, {
				message: {
					"variables[0][key]": ["BRANCH_OVERRIDE is invalid"],
				},
			}),
		);

		const result = await triggerGitlabPipeline({
			...base,
			variables: { BRANCH_OVERRIDE: "x" },
		});

		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}
		expect(result.failure).toBe("PROVIDER_ERROR");
	});

	it("still recognises GitLab's own missing-.gitlab-ci.yml wording", async () => {
		fetchMock.mockResolvedValue(
			reply(400, {
				message: { base: ["Missing .gitlab-ci.yml file"] },
			}),
		);

		const result = await triggerGitlabPipeline(base);

		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}
		expect(result.failure).toBe("NOT_FOUND");
	});

	it("quotes GitLab's own reason for a rejected ref", async () => {
		fetchMock.mockResolvedValue(
			reply(400, { message: { base: ["Reference not found"] } }),
		);

		const result = await triggerGitlabPipeline({ ...base, ref: "nope" });

		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}
		expect(result.failure).toBe("NOT_FOUND");
		expect(result.message).toContain("nope");
		expect(result.message).toContain("Reference not found");
	});

	// A self-managed GitLab is a customer-controlled host, and a verbose error
	// page or a fronting proxy will echo the request's own PRIVATE-TOKEN back.
	// The body is quoted into `message`, which reaches the browser — and
	// triggering a run only needs editor permission while reading the credential
	// needs an admin, so an unscrubbed body hands the token to someone it was
	// deliberately kept from.
	it("never quotes the connected token back, whatever the host echoes", async () => {
		fetchMock.mockResolvedValue(
			reply(
				500,
				`upstream error: PRIVATE-TOKEN: ${base.token} rejected by proxy`,
			),
		);

		const result = await triggerGitlabPipeline(base);

		expect(result.ok).toBe(false);
		const message = "message" in result ? result.message : "";
		expect(message).not.toContain(base.token);
		expect(message).toContain("[REDACTED]");
	});

	it("scrubs a reflected token out of the 400 ref-rejection message too", async () => {
		// The 400 branch quotes the body to explain WHICH ref failed, so it is a
		// second, independent path the body reaches the user through.
		fetchMock.mockResolvedValue(
			reply(
				400,
				`reference not found; sent Authorization: Bearer ${base.token}`,
			),
		);

		const result = await triggerGitlabPipeline(base);

		expect(result.ok).toBe(false);
		const message = "message" in result ? result.message : "";
		expect(message).not.toContain(base.token);
		// The useful part still survives — scrubbing must not blank the diagnosis.
		expect(message).toContain("reference not found");
	});
});

describe("gitlabPipelineApiBase", () => {
	it("derives the v4 base for gitlab.com and self-managed hosts", () => {
		expect(gitlabPipelineApiBase("https://gitlab.com/acme/store")).toBe(
			"https://gitlab.com/api/v4",
		);
		expect(
			gitlabPipelineApiBase("https://git.internal.acme.dev/team/app.git"),
		).toBe("https://git.internal.acme.dev/api/v4");
	});

	it("refuses cloud metadata hosts — the SSRF target a server can reach", () => {
		expect(
			gitlabPipelineApiBase("http://169.254.169.254/acme/store"),
		).toBeNull();
		expect(
			gitlabPipelineApiBase("http://metadata.google.internal/x/y"),
		).toBeNull();
		expect(gitlabPipelineApiBase("http://[fd00:ec2::254]/x/y")).toBeNull();
		expect(
			gitlabPipelineApiBase("http://[::ffff:169.254.169.254]/x/y"),
		).toBeNull();
		expect(
			gitlabPipelineApiBase("http://metadata.google.internal./x/y"),
		).toBeNull();
	});

	it("refuses non-http(s) schemes and unparseable URLs", () => {
		expect(gitlabPipelineApiBase("file:///etc/passwd")).toBeNull();
		expect(gitlabPipelineApiBase("ftp://gitlab.com/x")).toBeNull();
		expect(gitlabPipelineApiBase("not a url")).toBeNull();
	});
});
