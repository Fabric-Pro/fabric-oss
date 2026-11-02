import { beforeEach, expect, it, vi } from "vitest";
import {
	createRemoteAgentServer,
	getRemoteAgentServerForActor,
	getRemoteAgentServerSecret,
	listRemoteAgentServers,
} from "../prisma/queries/projects/remote-agent-servers";

const f = vi.hoisted(() => ({
	findFirst: vi.fn(),
	findMany: vi.fn(),
	create: vi.fn(),
	decrypt: vi.fn(() => "example-decrypted-secret"),
	encrypt: vi.fn(() => "example-ciphertext"),
}));
vi.mock("../prisma/client", () => ({ db: { projectRemoteAgentServer: f } }));
vi.mock("@repo/utils", () => ({
	encryptApiKey: f.encrypt,
	decryptApiKey: f.decrypt,
}));
beforeEach(() => vi.clearAllMocks());
const target = {
	connectionId: "example-connection",
	projectId: "example-project",
	organizationId: "example-org",
	userId: "example-owner",
	url: "https://agents.example.com",
	profileId: "example-profile",
};

it("scopes selectable connections to this project and this owner or its team", async () => {
	await listRemoteAgentServers("example-project", "example-owner");
	expect(f.findMany).toHaveBeenCalledWith(
		expect.objectContaining({
			where: {
				projectId: "example-project",
				isActive: true,
				OR: [{ userId: "example-owner" }, { scope: "TEAM" }],
			},
		}),
	);
	await getRemoteAgentServerForActor(
		"other-connection",
		"example-project",
		"example-owner",
	);
	expect(f.findFirst).toHaveBeenCalledWith(
		expect.objectContaining({
			where: expect.objectContaining({
				id: "other-connection",
				projectId: "example-project",
				isActive: true,
			}),
		}),
	);
});
it("encrypts service credentials and excludes ciphertext from the returned projection", async () => {
	await createRemoteAgentServer({
		projectId: "example-project",
		userId: "example-owner",
		name: "Example",
		scope: "PRIVATE",
		url: target.url,
		profileId: target.profileId,
		secret: "synthetic-service-secret",
	});
	const args = f.create.mock.calls[0][0];
	expect(args.data.secret).toBeUndefined();
	expect(args.data.encryptedSecret).toBe("example-ciphertext");
	expect(args.select.encryptedSecret).toBeUndefined();
});
it.each([
	{ url: "https://changed.example.com" },
	{ profileId: "changed-profile" },
	{ scope: "PRIVATE", userId: "another-owner" },
])(
	"refuses changed endpoint, profile, or private owner before decrypting %j",
	async (change) => {
		f.findFirst.mockResolvedValue({
			...target,
			scope: "PRIVATE",
			isActive: true,
			encryptedSecret: "ciphertext",
			...change,
		});
		await expect(getRemoteAgentServerSecret(target)).rejects.toThrow(
			"binding changed",
		);
		expect(f.decrypt).not.toHaveBeenCalled();
	},
);
it("lets cleanup observe a disconnected connection but rejects new admission", async () => {
	f.findFirst.mockResolvedValue({
		...target,
		scope: "PRIVATE",
		isActive: false,
		encryptedSecret: "ciphertext",
	});
	await expect(getRemoteAgentServerSecret(target)).resolves.toBe(
		"example-decrypted-secret",
	);
	await expect(getRemoteAgentServerSecret(target, true)).rejects.toThrow();
	expect(f.findFirst.mock.calls[0][0].where.project.organizationId).toBe(
		"example-org",
	);
});
