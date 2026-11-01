import { createOfficialRegistry } from "./xstocks";

// Complete issuer metadata snapshots only; chain state is always verified separately.
export const officialXstocks = createOfficialRegistry();
