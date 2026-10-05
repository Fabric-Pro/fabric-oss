/**
 * The pure half of `init` taking over a folder (Fizzy #2878): where to clone
 * from, what the clone is called, and what each kind of folder is told.
 */
import type { PublishedInstructionRepository } from "@fabricorg/sdk";
import { describe, expect, it } from "vitest";
import {
	adoptionFor,
	cloneUrlFor,
	defaultCloneDirectory,
	providerLoginCommand,
} from "../src/lib/instructions/adoption.js";
import type { CheckoutClassification } from "../src/lib/instructions/checkout.js";

const GITHUB: PublishedInstructionRepository = {
	provider: "GITHUB",
	host: "github.com",
	path: "example-org/rules",
	ref: "main",
	rootPath: "",
	generation: 1,
};

const AZURE: PublishedInstructionRepository = {
	provider: "AZURE_DEVOPS",
	host: "dev.azure.com",
	path: "Example-Org/Example Project/_git/rules",
	ref: "main",
	rootPath: "",
	generation: 1,
};

describe("cloneUrlFor", () => {
	it("takes the deployment's own clone URL", () => {
		expect(
			cloneUrlFor({
				...AZURE,
				cloneUrl:
					"https://dev.azure.com/Example-Org/Example%20Project/_git/rules",
			}),
		).toBe(
			"https://dev.azure.com/Example-Org/Example%20Project/_git/rules",
		);
	});

	it("builds the URL itself for GitHub and GitLab when the deployment does not say", () => {
		expect(cloneUrlFor(GITHUB)).toBe(
			"https://github.com/example-org/rules",
		);
		expect(
			cloneUrlFor({
				...GITHUB,
				provider: "GITLAB",
				host: "gitlab.com",
				path: "group/sub/rules",
			}),
		).toBe("https://gitlab.com/group/sub/rules");
	});

	it("treats a legacy null clone URL as one the deployment did not give", () => {
		expect(cloneUrlFor({ ...GITHUB, cloneUrl: null })).toBe(
			"https://github.com/example-org/rules",
		);
		expect(cloneUrlFor({ ...AZURE, cloneUrl: null })).toBeNull();
	});

	it("does not guess for Azure DevOps", () => {
		expect(cloneUrlFor(AZURE)).toBeNull();
	});

	it.each([
		["another host on a port", "https://attacker.example:8443/x/y"],
		[
			"another host with the same path",
			"https://attacker.example/example-org/rules",
		],
		["this host and another repository", "https://github.com/other/rules"],
		["this host on a port", "https://github.com:8443/example-org/rules"],
		["this host on port 0", "https://github.com:0/example-org/rules"],
		[
			"a subdomain of this host",
			"https://evil.github.com/example-org/rules",
		],
	])("refuses a clone URL that names %s", (_label, cloneUrl) => {
		expect(cloneUrlFor({ ...GITHUB, cloneUrl })).toBeNull();
	});

	it("takes a clone URL that names the same repository however it is spelled", () => {
		expect(
			cloneUrlFor({
				...GITHUB,
				cloneUrl: "https://GitHub.com/Example-Org/Rules.git",
			}),
		).toBe("https://github.com/Example-Org/Rules.git");
		expect(
			cloneUrlFor({
				...GITHUB,
				cloneUrl: "https://github.com:443/example-org/rules",
			}),
		).toBe("https://github.com/example-org/rules");
	});

	it("refuses an Azure DevOps clone URL for another project", () => {
		expect(
			cloneUrlFor({
				...AZURE,
				cloneUrl:
					"https://dev.azure.com/Example-Org/Other%20Project/_git/rules",
			}),
		).toBeNull();
	});

	it("refuses a clone URL that is not credential-free HTTPS", () => {
		expect(
			cloneUrlFor({
				...GITHUB,
				cloneUrl: "https://user:secret@github.com/example-org/rules",
			}),
		).toBeNull();
		expect(
			cloneUrlFor({
				...GITHUB,
				cloneUrl: "git@github.com:example-org/rules.git",
			}),
		).toBeNull();
	});
});

describe("defaultCloneDirectory", () => {
	it.each([
		["example-org/rules", "rules"],
		["example-org/rules.git", "rules"],
		["group/sub/rules", "rules"],
		["Example-Org/Example Project/_git/rules", "rules"],
	])("names the clone of %s %s", (repositoryPath, expected) => {
		expect(defaultCloneDirectory({ path: repositoryPath })).toBe(expected);
	});
});

describe("providerLoginCommand", () => {
	const gitCommand =
		"git ls-remote https://dev.azure.com/example-org/example/_git/example";

	it.each([
		["GITHUB", "gh auth login"],
		["GITLAB", "glab auth login"],
	] as const)(
		"gives git credentials for %s with `%s`",
		(provider, command) => {
			expect(providerLoginCommand(provider, gitCommand)).toBe(command);
		},
	);

	// `az devops login` stores a token for the `az devops` commands only; git
	// never reads it. Git Credential Manager signs git in on the first git
	// command run from a terminal, so that command is the advice.
	it("sends Azure DevOps to the git command itself, never `az devops login`", () => {
		expect(providerLoginCommand("AZURE_DEVOPS", gitCommand)).toBe(
			gitCommand,
		);
	});
});

describe("adoptionFor", () => {
	const base = {
		repository: GITHUB,
		destination: "/work/rules",
		rerun: { project: "project-1" },
	};
	const classes: Record<string, CheckoutClassification> = {
		matching: {
			class: "matching",
			remote: "origin",
			toplevel: "/work/rules",
			traits: { shallow: false, sparse: false, superproject: false },
		},
		notGit: { class: "not-git" },
		foreign: { class: "foreign" },
		ambiguous: { class: "ambiguous", remotes: ["origin", "upstream"] },
		unmapped: {
			class: "unmapped",
			rootPath: "docs/ai",
			toplevel: "/work/rules",
		},
		unknown: { class: "unknown", reason: "git timed out" },
		unknownIdentity: { class: "unknown-identity" },
		unsupported: { class: "unsupported-provider", provider: "BITBUCKET" },
	};

	function adopt(
		name: keyof typeof classes,
		overrides: Partial<Parameters<typeof adoptionFor>[0]> = {},
	) {
		return adoptionFor({
			...base,
			classification: classes[name] as CheckoutClassification,
			folderEmpty: false,
			...overrides,
		});
	}

	it("sets up a matching checkout, whatever is in it", () => {
		expect(adopt("matching")).toEqual({ kind: "set-up" });
	});

	it("offers to clone into an empty folder that is not a checkout", () => {
		expect(adopt("notGit", { folderEmpty: true })).toEqual({
			kind: "empty-folder",
		});
	});

	it("tells a folder that is not a clone, but has files, the one line that clones and sets up", () => {
		const adoption = adopt("notGit");

		expect(adoption.kind).toBe("refused");
		if (adoption.kind === "refused") {
			expect(adoption.failure.exitCode).toBe(7);
			expect(adoption.failure.message).toBe(
				"This folder is not a clone of github.com/example-org/rules. Run: fabric instructions init --project project-1 --clone rules",
			);
		}
	});

	it("carries the one tool the person named into that line", () => {
		const adoption = adopt("notGit", {
			rerun: { project: "project-1", tool: "codex" },
		});

		expect(adoption.kind === "refused" && adoption.failure.message).toBe(
			"This folder is not a clone of github.com/example-org/rules. Run: fabric instructions init --project project-1 --tool codex --clone rules",
		);
	});

	it("needs no second step for a project in a subfolder: --clone finishes there", () => {
		const adoption = adopt("foreign", {
			repository: { ...GITHUB, rootPath: "docs/ai" },
		});

		const message = adoption.kind === "refused" && adoption.failure.message;
		expect(message).toContain("--clone rules");
		expect(message).not.toContain("&&");
		expect(message).not.toContain(" cd ");
	});

	it("quotes a folder name a shell would split", () => {
		const adoption = adopt("foreign", {
			repository: { ...GITHUB, path: "example-org/my rules" },
		});

		expect(
			adoption.kind === "refused" && adoption.failure.message,
		).toContain("--clone 'my rules'");
	});

	it("quotes the folder, so a path a shell would expand is one word", () => {
		const adoption = adopt("foreign", {
			repository: {
				...GITHUB,
				provider: "GITLAB",
				host: "x.example",
				path: "group/$(id)",
			},
		});

		expect(
			adoption.kind === "refused" && adoption.failure.message,
		).toContain("--clone '$(id)'");
	});

	it("says where to go for the right repository in the wrong folder, relative to here, with no cd", () => {
		const adoption = adopt("unmapped");

		expect(adoption.kind === "refused" && adoption.failure.message).toBe(
			"This checkout is github.com/example-org/rules, but its instructions are in docs/ai. Run: fabric instructions init --dest docs/ai",
		);
	});

	it("spells that folder behind the --dest the person typed, so the line runs from where they are", () => {
		const adoption = adopt("unmapped", {
			rerun: { project: "project-1", dest: "work\\rules/" },
		});

		expect(
			adoption.kind === "refused" && adoption.failure.message,
		).toContain("--dest work/rules/docs/ai");
	});

	it("names the --dest itself when the instructions are in the folder it already points at", () => {
		const adoption = adopt("unmapped", {
			classification: {
				class: "unmapped",
				rootPath: "",
				toplevel: "/work/rules",
			},
			rerun: { project: "project-1", dest: "work/rules" },
		});

		expect(
			adoption.kind === "refused" && adoption.failure.message,
		).toContain("Run: fabric instructions init --dest work/rules");
	});

	it("names the remote to pass when two fetch from the repository", () => {
		const adoption = adopt("ambiguous");

		expect(adoption.kind === "refused" && adoption.failure.message).toBe(
			"Remotes origin, upstream all fetch from github.com/example-org/rules. Run: fabric instructions init --remote origin",
		);
	});

	it("will not offer a clone line for a repository it cannot name a URL for", () => {
		const adoption = adopt("notGit", { repository: AZURE });

		expect(adoption.kind === "refused" && adoption.failure.message).toBe(
			"This deployment did not say where to clone dev.azure.com/Example-Org/Example Project/_git/rules from. Clone it yourself, then run: fabric instructions init",
		);
	});

	it.each(["unknown", "unknownIdentity", "unsupported"])(
		"refuses a %s checkout with exit 7 and the class line",
		(name) => {
			const adoption = adopt(name);

			expect(adoption.kind).toBe("refused");
			expect(
				adoption.kind === "refused" && adoption.failure.exitCode,
			).toBe(7);
			expect(
				adoption.kind === "refused" && adoption.failure.message,
			).toMatch(/^fabric: coding instructions: /);
		},
	);
});
