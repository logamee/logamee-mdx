import type { OpenIntentCoordinator } from '../../lib/openIntentCoordinator';
import type { MutableBooleanRef } from './packagedOpenSteps';

export function syncOpenIntentCoordinatorModalState(
  coordinator: Pick<OpenIntentCoordinator, 'setModalActive'>,
  renderedModalActive: boolean,
  barrierRef: Readonly<MutableBooleanRef>,
): void {
  coordinator.setModalActive(renderedModalActive || barrierRef.current);
}
