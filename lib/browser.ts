import { Buffer } from "buffer";
// SDK 2.0.0 PDA helpers expect a browser Buffer global. Load before the SDK chunk.
if (!globalThis.Buffer) globalThis.Buffer = Buffer;
