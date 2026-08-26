export type ModalTransition = () => void;

export async function completeModalAction(
  prepare: () => Promise<ModalTransition | void>,
  closeCurrent: () => void,
): Promise<void> {
  const openNext = await prepare();
  closeCurrent();
  openNext?.();
}
