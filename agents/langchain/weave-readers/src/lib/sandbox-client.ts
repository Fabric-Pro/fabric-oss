/**
 * Sandbox client for weave reader agents.
 */

interface SandboxContext {
	sessionId: string;
	workDir: string;
	branch?: string;
	userId: string;
	organizationId: string | null;
}

interface SandboxReadResponse {
	content?: string;
	error?: string;
}

interface SandboxListResponse {
	files?: string[];
	error?: string;
}

interface SandboxExecResponse {
	stdout?: string;
	stderr?: string;
	exitCode?: number;
	error?: string;
}

export interface SandboxClient {
	readFile(path: string): Promise<string>;
	listFiles(path: string, recursive?: boolean): Promise<string[]>;
	searchCode(
		pattern: string,
		path?: string,
	): Promise<Array<{ file: string; line: number; content: string }>>;
	execCommand(
		command: string,
		args?: string[],
	): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export function createSandboxClient(context: SandboxContext): SandboxClient {
	const baseUrl = process.env.SANDBOX_API_URL || "http://localhost:3000";

	return {
		async readFile(path: string): Promise<string> {
			const response = await fetch(
				`${baseUrl}/sandbox/${context.sessionId}/read`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						userId: context.userId,
						org: context.organizationId,
						path: `${context.workDir}/${path}`.replace(/\/+/g, "/"),
					}),
				},
			);

			if (!response.ok) {
				throw new Error(`Failed to read file: ${response.statusText}`);
			}

			const data = (await response.json()) as SandboxReadResponse;
			if (typeof data.error === "string") {
				throw new Error(data.error);
			}
			return data.content ?? "";
		},

		async listFiles(path: string, recursive = false): Promise<string[]> {
			const response = await fetch(
				`${baseUrl}/sandbox/${context.sessionId}/list`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						userId: context.userId,
						org: context.organizationId,
						path: `${context.workDir}/${path}`.replace(/\/+/g, "/"),
						recursive,
					}),
				},
			);

			if (!response.ok) {
				throw new Error(`Failed to list files: ${response.statusText}`);
			}

			const data = (await response.json()) as SandboxListResponse;
			if (typeof data.error === "string") {
				throw new Error(data.error);
			}
			return Array.isArray(data.files) ? data.files : [];
		},

		async searchCode(
			pattern: string,
			path = ".",
		): Promise<Array<{ file: string; line: number; content: string }>> {
			const result = await this.execCommand("grep", [
				"-rn",
				"--include=*.ts",
				"--include=*.tsx",
				"--include=*.js",
				"--include=*.jsx",
				pattern,
				path,
			]);

			return result.stdout
				.split("\n")
				.filter((line) => line.trim())
				.flatMap((line) => {
					const match = line.match(/^(.+):(\d+):(.+)$/);
					if (!match) {
						return [];
					}
					return [
						{
							file: match[1],
							line: Number.parseInt(match[2], 10),
							content: match[3].trim(),
						},
					];
				});
		},

		async execCommand(command: string, args: string[] = []) {
			const allowedCommands = [
				"grep",
				"find",
				"cat",
				"ls",
				"head",
				"tail",
				"wc",
				"pwd",
			];
			if (!allowedCommands.includes(command)) {
				throw new Error(`Command '${command}' is not allowed`);
			}

			if (args.some((arg) => /&&|\|\||;|\|/.test(arg))) {
				throw new Error("Invalid characters in command arguments");
			}

			const response = await fetch(
				`${baseUrl}/sandbox/${context.sessionId}/exec`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						userId: context.userId,
						org: context.organizationId,
						command:
							`${command} ${args.map((arg) => `"${arg.replace(/"/g, '\\"')}"`).join(" ")}`.trim(),
						workDir: context.workDir,
					}),
				},
			);

			if (!response.ok) {
				throw new Error(
					`Failed to execute command: ${response.statusText}`,
				);
			}

			const data = (await response.json()) as SandboxExecResponse;
			if (typeof data.error === "string") {
				throw new Error(data.error);
			}
			return {
				stdout: data.stdout ?? "",
				stderr: data.stderr ?? "",
				exitCode: typeof data.exitCode === "number" ? data.exitCode : 0,
			};
		},
	};
}
