/** MCP preview defaults (plan: default ≤50, hard ≤5000). */
export const PREVIEW_DEFAULT_ROWS = 50;
export const PREVIEW_HARD_CAP = 5000;

/**
 * Clamp requested preview rows. Returns the effective row count.
 * Invalid / non-positive values fall back to the default.
 */
export function clampPreviewRows(requested: number | undefined | null): number {
  if (requested == null || !Number.isFinite(requested) || requested <= 0) {
    return PREVIEW_DEFAULT_ROWS;
  }
  return Math.min(Math.floor(requested), PREVIEW_HARD_CAP);
}
