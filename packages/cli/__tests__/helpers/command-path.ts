/**
 * A folder as a pasteable command spells it. A POSIX temp folder is plain
 * shell text. On Windows the spelling is the one bash, PowerShell and cmd.exe
 * all read the same: forward slashes, double-quoted only when the path holds
 * something a shell would split, such as a space in the user's name.
 *
 * No imports, so a test that mocks CLI modules can take it without loading them.
 */
export function commandPath(folder: string): string {
	if (process.platform !== "win32") {
		return folder;
	}
	const forward = folder.replace(/\\/g, "/");
	return /^[A-Za-z0-9_@%+=:,./-]+$/.test(forward) ? forward : `"${forward}"`;
}
