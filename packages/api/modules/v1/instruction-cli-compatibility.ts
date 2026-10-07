const LEGACY_SNAPSHOT_BYTES = 50 * 1024 * 1024;
const INSTRUCTIONS_STREAMING_CAPABILITY = "instructions-stream-v1";
const INSTRUCTIONS_REPOSITORY_DIRECT_CAPABILITY =
	"instructions-repository-direct-v1";
const STREAMING_CAPABILITY_TOKEN = new RegExp(
	`(?:^|[;(]\\s*)${INSTRUCTIONS_STREAMING_CAPABILITY}(?=\\s*[;)])`,
);
const REPOSITORY_DIRECT_CAPABILITY_TOKEN = new RegExp(
	`(?:^|[;(]\\s*)${INSTRUCTIONS_REPOSITORY_DIRECT_CAPABILITY}(?=\\s*[;)])`,
);

export function instructionCliUpgradeNotice(
	userAgent: string | undefined,
	files: readonly { size: number }[],
): string | null {
	const version = /^fabric-cli\/(\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(
		userAgent ?? "",
	);
	if (
		!version ||
		files.reduce((total, file) => total + file.size, 0) <=
			LEGACY_SNAPSHOT_BYTES
	) {
		return null;
	}
	const major = Number(version[1]);
	const minor = Number(version[2]);
	const patch = Number(version[3]);
	if (STREAMING_CAPABILITY_TOKEN.test(userAgent ?? "")) {
		return null;
	}
	if (major > 0 || minor > 5 || (minor === 5 && patch > 0)) {
		return null;
	}
	return "This snapshot exceeds the old CLI's 50 MiB limit. Use CLI 0.5.1 or newer from this project's Connect your agent dialog.";
}

/**
 * A direct repository has no snapshot fallback. Older CLI builds must be
 * upgraded before they classify a checkout or attempt a legacy download.
 */
export function instructionRepositoryDirectUpgradeNotice(
	userAgent: string | undefined,
): string | null {
	if (
		!/^fabric-cli\/\d+\.\d+\.\d+(?:\s|$)/.test(userAgent ?? "") ||
		REPOSITORY_DIRECT_CAPABILITY_TOKEN.test(userAgent ?? "")
	) {
		return null;
	}
	return "This project reads its coding instructions directly from its repository. Use a newer CLI from this project's Connect your agent dialog.";
}
