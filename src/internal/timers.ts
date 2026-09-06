/**
 * `setInterval` resolves to a Node `Timeout` or a DOM `number` depending on
 * which lib is loaded. Only the Node one can be unref'd, so probe for it
 * rather than assuming either.
 */
export function unrefTimer(timer: unknown): void {
  const candidate = timer as { unref?: () => void } | null;
  candidate?.unref?.();
}
