/**
 * What `doctor` says for a project that reads its repository directly: no
 * snapshot is published, because Fabric copies nothing, so "nothing is
 * published, publish a version" is wrong and the checkout still has a commit to
 * be compared with (the one the server read). `runDoctor` is called directly
 * with a client that answers the direct read and a checkout report the test
 * injects.
 */
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
	PublishedInstructionRepository,
	PublishedInstructions,
	WhoamiResult,
} from "@fabricorg/sdk";
import { describe, expect, it } from "vitest";
import type { CheckoutReport } from "../src/lib/instructions/checkout.js";
import type { InstructionCheck } from "../src/lib/instructions/checks.js";
import { type DoctorInput, runDoctor } from "../src/lib/instructions/doctor.js";

const PROJECT = "project-example-one";
const COMMIT = "a".repeat(40);
const HEAD = "b".repeat(40);

const REPOSITORY: PublishedInstructionRepository = {
	provider: "GITHUB",
	host: "git.example.com",
	path: "example-org/rules",
	ref: "main",
	rootPath: "",
	generation: 1,
	sync: { automatic: true, pausedReason: null, lastRun: null },
};

const WHOAMI = {
	user: {
		id: "user-1",
		name: "Dev",
		email: "dev@example.com",
		role: "user",
		createdAt: "2026-01-02T03:04:05.000Z",
	},
	keyType: "oauth",
	keyPrefix: "fat_",
	scopes: ["instructions:read"],
	orgs: [],
} as WhoamiResult;

const DIRECT = {
	published: false,
	sourceOfTruth: "REPOSITORY",
	repository: REPOSITORY,
	direct: {
		availability: "READY",
		readState: "DIRECT",
		generation: 1,
		currentCommitSha: COMMIT,
		ref: "main",
		rootPath: "",
		provider: "GITHUB",
		repository: {
			...REPOSITORY,
			cloneUrl: "https://git.example.com/x.git",
		},
	},
} as unknown as PublishedInstructions;

function matching(contains: boolean | null): CheckoutReport {
	return {
		classification: {
			class: "matching",
			remote: "origin",
			toplevel: "/work/rules",
			traits: { shallow: false, sparse: false, superproject: false },
		},
		state: {
			branch: "main",
			head: HEAD,
			clean: true,
			operation: null,
			traits: { shallow: false, sparse: false, superproject: false },
		},
		contains,
		line: null,
		json: {
			class: "matching",
			remote: "origin",
			branch: "main",
			head: HEAD,
			clean: true,
			operation: null,
			traits: [],
			line: null,
		},
	};
}

async function checks(
	contains: boolean | null,
): Promise<Map<string, InstructionCheck>> {
	const root = await realpath(
		await mkdtemp(path.join(tmpdir(), "fabric-doctor-direct-")),
	);
	const unreachable = () => {
		throw new Error("not used by this test");
	};
	const input: DoctorInput = {
		projectId: PROJECT,
		destination: root,
		root,
		probeNetwork: false,
		env: {},
		platform: "linux",
		apiKeyPresent: true,
		client: () => ({
			auth: { whoami: async () => WHOAMI },
			instructions: { getPublished: async () => DIRECT },
		}),
		createDownloadUrl: async () => unreachable(),
		fetchArchive: async () => unreachable(),
		inspectCheckout: async () => matching(contains),
	};
	const report = await runDoctor(input);
	return new Map(report.checks.map((check) => [check.id, check]));
}

describe("doctor for a project that reads its repository directly", () => {
	it("does not say nothing is published, and names the commit that is read", async () => {
		const byId = await checks(true);

		const published = byId.get("published");
		expect(published?.status).toBe("pass");
		expect(published?.detail).toContain("read directly from");
		expect(published?.detail).toContain("aaaaaaaaaaaa");
		expect(JSON.stringify(byId.get("published"))).not.toContain(
			"publish a version",
		);
	});

	it("compares the checkout with the commit the server read", async () => {
		const behind = (await checks(false)).get("checkout");
		const current = (await checks(true)).get("checkout");

		expect(behind?.status).not.toBe("skip");
		expect(behind?.detail).not.toContain("nothing published");
		expect(behind?.detail).toContain("aaaaaaa");
		expect(current?.status).toBe("pass");
	});

	it("keeps no lock for it, and says why", async () => {
		const byId = await checks(true);

		expect(byId.get("lock")?.status).toBe("skip");
	});
});
