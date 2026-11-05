/** One user-intended occurrence survives ambiguous HTTP/Temporal responses. */
export function createReportExecutionRequests(
	newKey: () => string = () => crypto.randomUUID(),
) {
	const keys = new Map<string, string>();
	const pending = new Set<string>();
	const terminal = (status?: string) =>
		!!status && ["COMPLETED", "FAILED", "CANCELLED"].includes(status);
	return {
		begin(instanceId: string): string | null {
			if (pending.has(instanceId)) {
				return null;
			}
			const key = keys.get(instanceId) ?? newKey();
			keys.set(instanceId, key);
			pending.add(instanceId);
			return key;
		},
		settle(instanceId: string, status: string) {
			if (terminal(status)) {
				keys.delete(instanceId);
				pending.delete(instanceId);
			}
		},
		failed(instanceId: string) {
			pending.delete(instanceId);
		}, // retain the occurrence key on an uncertain request failure
		observe(instanceId: string, status?: string) {
			if (terminal(status)) {
				keys.delete(instanceId);
				pending.delete(instanceId);
			}
		},
		isPending(instanceId: string) {
			return pending.has(instanceId);
		},
	};
}
