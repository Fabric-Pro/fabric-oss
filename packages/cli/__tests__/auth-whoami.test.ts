/**
 * `fabric auth whoami` can ask another deployment (`--base-url`) and, with
 * `--project`, ask with one project's own sign-in. What is pinned is what the
 * command hands to `getClient`, which is where a credential is chosen, and what
 * it prints for a sign-in that is limited to a project.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildWhoamiCommand } from "../src/commands/auth/whoami.js";

class ExitSignal extends Error {
	constructor(readonly code: number) {
		super(`exit ${code}`);
	}
}

const { mocks } = vi.hoisted(() => ({
	mocks: {
		whoami: vi.fn(),
		getClient: vi.fn(),
		printError: vi.fn((_: string, code?: number) => {
			throw new ExitSignal(code ?? 1);
		}),
		printOutput: vi.fn(),
		printRecord: vi.fn(),
	},
}));

vi.mock("../src/lib/client.js", () => ({
	getClient: (options: unknown) => {
		mocks.getClient(options);
		return { auth: { whoami: mocks.whoami } };
	},
}));

vi.mock("../src/lib/output.js", () => ({
	printError: mocks.printError,
	printOutput: mocks.printOutput,
	printRecord: mocks.printRecord,
}));

const ME = {
	user: {
		name: "Dev",
		email: "dev@example.com",
		role: "user",
		createdAt: "2026-01-02T03:04:05.000Z",
	},
	keyType: "oauth",
	keyPrefix: "fat_",
	scopes: ["instructions:read"],
	orgs: [],
};

async function whoami(args: string[] = []): Promise<void> {
	await buildWhoamiCommand().parseAsync(args, { from: "user" });
}

beforeEach(() => {
	mocks.whoami.mockReset();
	mocks.whoami.mockResolvedValue(ME);
	mocks.getClient.mockReset();
	mocks.printError.mockClear();
	mocks.printOutput.mockReset();
	mocks.printRecord.mockReset();
});

describe("fabric auth whoami", () => {
	it("asks the deployment this run talks to when told nothing else", async () => {
		await whoami();

		expect(mocks.getClient).toHaveBeenCalledWith({});
	});

	it("asks the deployment --base-url names, as its origin", async () => {
		await whoami(["--base-url", "https://Deploy.Example.com/app/?x=1"]);

		expect(mocks.getClient).toHaveBeenCalledWith({
			baseUrl: "https://deploy.example.com",
		});
	});

	it("refuses an address that is not a URL, before asking anyone", async () => {
		await expect(whoami(["--base-url", "not a url"])).rejects.toMatchObject(
			{ code: 2 },
		);

		expect(mocks.getClient).not.toHaveBeenCalled();
	});

	it("asks with a project's own sign-in under --project", async () => {
		await whoami([
			"--base-url",
			"https://deploy.example.com",
			"--project",
			"project-example-one",
		]);

		expect(mocks.getClient).toHaveBeenCalledWith({
			baseUrl: "https://deploy.example.com",
			project: "project-example-one",
		});
	});

	it.each([
		["a space", "my project"],
		["a path", "../other"],
		["more than 64 characters", "a".repeat(65)],
	])("refuses a project id with %s in it", async (_label, id) => {
		await expect(whoami(["--project", id])).rejects.toMatchObject({
			code: 2,
		});

		expect(mocks.getClient).not.toHaveBeenCalled();
	});

	it("shows the project a sign-in is limited to", async () => {
		mocks.whoami.mockResolvedValue({
			...ME,
			projectContext: "project-example-one",
		});

		await whoami(["--project", "project-example-one"]);

		expect(mocks.printRecord).toHaveBeenCalledWith(
			expect.objectContaining({ Project: "project-example-one" }),
		);
	});

	it("shows no project row for a sign-in that is not limited to one", async () => {
		await whoami();

		const [record] = mocks.printRecord.mock.calls[0] ?? [];
		expect(record).not.toHaveProperty("Project");
		expect(record).toMatchObject({ User: "Dev", "Key type": "oauth" });
	});

	it("passes the whole answer through for --format json, project included", async () => {
		const answer = { ...ME, projectContext: "project-example-one" };
		mocks.whoami.mockResolvedValue(answer);

		await whoami(["--format", "json"]);

		expect(mocks.printOutput).toHaveBeenCalledWith(answer, {
			format: "json",
		});
	});

	it("exits 3 with the server's message when the request fails", async () => {
		mocks.whoami.mockRejectedValue(new Error("This sign-in has expired."));

		await expect(whoami()).rejects.toMatchObject({ code: 3 });

		expect(mocks.printError).toHaveBeenCalledWith(
			"This sign-in has expired.",
			3,
		);
	});
});
