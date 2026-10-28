// Opt-in cross-repository protocol fixture. The router is production code;
// native session callbacks and worktree preparation are synthetic, never an LLM.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [sourceRoot, root] = process.argv.slice(2);
if (!sourceRoot || !root) {
	throw new Error("Expected source root and owned fixture directory");
}
const { createCodingSessionsRouter } = await import(
	pathToFileURL(
		resolve(
			sourceRoot,
			"packages/server-core/src/webui/coding-sessions.fabric.ts",
		),
	).href
);
const file = join(root, "native.json");
let state: { sessions: Record<string, any>; sends: number };
try {
	state = JSON.parse(readFileSync(file, "utf8"));
} catch {
	state = { sessions: {}, sends: 0 };
}
const save = () => writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
let complete: (event: object) => void = () => {};
const manager = {
	getWorkspaces: () => [
		{
			id: "example-workspace",
			slug: "example-workspace",
			rootPath: root,
			name: "Fixture",
		},
	],
	createSession: async (workspaceId: string, options: object) => {
		const id = `example-session-${Object.keys(state.sessions).length + 1}`;
		const session = {
			id,
			workspaceId,
			...options,
			isProcessing: false,
			messages: [],
		};
		state.sessions[id] = session;
		save();
		return session;
	},
	getSession: async (id: string) => state.sessions[id] ?? null,
	getPendingPermissionRequests: () => [],
	getPendingElicitations: () => [],
	onSessionComplete: (listener: (event: object) => void) => {
		complete = listener;
		return () => {};
	},
	sendMessage: async (
		id: string,
		content: string,
		_a: unknown,
		_b: unknown,
		_c: unknown,
		_d: unknown,
		_e: unknown,
		ack?: (id: string) => void,
	) => {
		state.sends++;
		const session = state.sessions[id];
		const messageId = `example-message-${state.sends}`;
		session.messages.push({ id: messageId, role: "user", content });
		if (content === "checkpoint") {
			session.messages.push({
				id: "checkpoint",
				role: "auth-request",
				authStatus: "pending",
			});
		}
		save();
		if (content !== "lose-ack") {
			ack?.(messageId);
		}
		if (content === "complete") {
			complete({
				sessionId: id,
				reason: "complete",
				backgroundWorkRunning: 0,
			});
		}
	},
	cancelProcessing: async () => {},
};
const router = createCodingSessionsRouter({
	internalSecret: "synthetic-service-secret-for-contract-tests",
	stateFilePath: join(root, "registry.json"),
	getSessionManager: () => manager,
	getConfiguredConnections: () => [],
	desktopWorkspaceId: "example-desktop-workspace",
	prepareWorktree: async () => ({
		repoRoot: root,
		worktreePath: join(root, "worktree"),
		branch: "feat/example",
		baseBranch: "main",
	}),
	resolveBranchName: async (_path: string, fallback: string) => fallback,
});
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: async (req: Request) =>
		(await router(req, new URL(req.url).pathname)) ??
		new Response("Not found", { status: 404 }),
});
console.log(JSON.stringify({ url: `http://127.0.0.1:${server.port}` }));
