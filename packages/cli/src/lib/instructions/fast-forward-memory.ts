/**
 * What the hook has already said, so it says it once (Fizzy #2878).
 *
 * A checkout left alone because it is dirty, or a branch that has diverged,
 * stays that way until the developer deals with it. Saying so at every session
 * start would be noise an agent learns to ignore, so the line is printed once
 * per published version and reason, and remembered in one small file beside the
 * checkout's git data (`<common dir>/fabric/ff-notice.json`, readable by its
 * owner only). A fast-forward, or a failure the developer can fix right now
 * (missing credentials), is never remembered: it always prints.
 *
 * Best effort in both directions: a file that cannot be read or written means
 * the line is printed, which is the safe side.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface NoticeKey {
	projectId: string;
	publishedVersion: number;
	reason: string;
}

interface NoticeRecord extends NoticeKey {
	v: 1;
}

export function noticeFile(commonDir: string): string {
	return path.join(commonDir, "fabric", "ff-notice.json");
}

function isRecord(value: unknown): value is NoticeRecord {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const record = value as Record<string, unknown>;
	return (
		record.v === 1 &&
		typeof record.projectId === "string" &&
		typeof record.publishedVersion === "number" &&
		typeof record.reason === "string"
	);
}

/** Whether this notice has not been printed yet for this version and reason. */
export async function isNewNotice(
	file: string,
	key: NoticeKey,
): Promise<boolean> {
	try {
		const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
		return !(
			isRecord(parsed) &&
			parsed.projectId === key.projectId &&
			parsed.publishedVersion === key.publishedVersion &&
			parsed.reason === key.reason
		);
	} catch {
		return true;
	}
}

/** Remember that this notice was printed. */
export async function rememberNotice(
	file: string,
	key: NoticeKey,
): Promise<void> {
	try {
		await mkdir(path.dirname(file), { recursive: true });
		const temporary = `${file}.${process.pid}.tmp`;
		const record: NoticeRecord = { v: 1, ...key };
		await writeFile(temporary, `${JSON.stringify(record)}\n`, {
			mode: 0o600,
		});
		await rename(temporary, file);
	} catch {
		// Unwritable: the line prints again next time, which is the safe side.
	}
}

/** Forget what was printed: the situation it described is over. */
export async function forgetNotice(file: string): Promise<void> {
	await rm(file, { force: true }).catch(() => undefined);
}
