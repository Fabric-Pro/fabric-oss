export type NativeInstructionBase = { generation: number; commitSha: string };

export type InstructionChangeBase =
	| { baseSnapshotId: string; nativeBase?: never }
	| { nativeBase: NativeInstructionBase; baseSnapshotId?: never };

export async function instructionBlobBase64(blob: Blob): Promise<string> {
	const bytes = new Uint8Array(await blob.arrayBuffer());
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += 8192) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
	}
	return btoa(binary);
}
