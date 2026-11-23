/**
 * The meeting is over and Fabric has everything the bridge held: the
 * transcript segments, the requests and the pause and resume reports. Nothing
 * of the meeting stays in Durable Object storage, and no alarm wakes the
 * object again. `deleteAll` keeps the alarm, so it is deleted first.
 */
export async function purgeParlumeBridge(storage: {
	deleteAlarm(): Promise<void>;
	deleteAll(): Promise<void>;
}): Promise<void> {
	await storage.deleteAlarm();
	await storage.deleteAll();
}
