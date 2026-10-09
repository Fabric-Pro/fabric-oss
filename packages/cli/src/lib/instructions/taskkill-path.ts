import path from "node:path";

/**
 * Where Windows keeps `taskkill`, from the environment's own `SystemRoot`. It
 * is started by this path and never looked up on `PATH`: a `PATH` the tool's
 * environment or a shell profile has changed may not have `System32` on it, and
 * then nothing would end the tree and the tool would be left running.
 */
export function taskkillPath(
	env: Readonly<Record<string, string | undefined>> = process.env,
): string {
	const root =
		env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? "C:\\Windows";
	return path.win32.join(root, "System32", "taskkill.exe");
}
