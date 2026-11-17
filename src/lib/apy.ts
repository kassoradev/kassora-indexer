export const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;

/**
 * Annualized (compounded) yield implied by a share-price move.
 * Returns null when the inputs cannot produce a meaningful number.
 */
export function annualize(
  from: { sharePrice: bigint; timestamp: bigint },
  to: { sharePrice: bigint; timestamp: bigint },
): number | null {
  const dt = Number(to.timestamp - from.timestamp);
  if (dt <= 0 || from.sharePrice <= 0n) return null;
  const ratio = Number((to.sharePrice * 10n ** 18n) / from.sharePrice) / 1e18;
  const apy = ratio ** (SECONDS_PER_YEAR / dt) - 1;
  return Number.isFinite(apy) ? apy : null;
}
