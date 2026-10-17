import type { Variant } from "./types";

/** Explicit order of conditions for the tool-removal vs content ablation. */
export const THREE_WAY_ABLATION: readonly Variant[] = ["kb-on", "kb-content-off", "kb-off"];
