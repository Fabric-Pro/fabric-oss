export function formatRelativeTime(value: string | Date): string {
	const date = value instanceof Date ? value : new Date(value);
	const deltaMs = Date.now() - date.getTime();
	const minutes = Math.max(1, Math.round(deltaMs / 60_000));
	if (minutes < 60) {
		return `${minutes}m ago`;
	}
	const hours = Math.round(minutes / 60);
	if (hours < 24) {
		return `${hours}h ago`;
	}
	const days = Math.round(hours / 24);
	return `${days}d ago`;
}
