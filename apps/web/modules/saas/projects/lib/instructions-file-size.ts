const KIB = 1024;
const MIB = KIB * KIB;

/**
 * A file's size as the file header reads it: whole bytes under a kilobyte
 * ("212 B", never "0 KB"), then one decimal of KB or MB ("6.2 KB", "1.5 MB").
 * A size that rounds up to the next unit is written in that unit, so a file
 * a byte short of a megabyte reads "1.0 MB" and not "1024.0 KB".
 */
export function formatFileSize(bytes: number): string {
	if (bytes < KIB) {
		return `${bytes} B`;
	}
	const kilobytes = Math.round((bytes / KIB) * 10) / 10;
	if (kilobytes < KIB) {
		return `${kilobytes.toFixed(1)} KB`;
	}
	return `${(bytes / MIB).toFixed(1)} MB`;
}
