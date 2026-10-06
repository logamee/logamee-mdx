/* eslint-disable react-hooks/exhaustive-deps -- 纯搬移：依赖数组逐项保持提取前原样，由 useDocumentSession.test.tsx 回归约束 */




import type { ExternalChangesDeps } from './externalChangesTypes';


import { useWatchEnqueueers } from './externalChangesWatchEnqueueers';
import { useExternalChangesWatchEffects } from './externalChangesWatchLifecycle';
import type { useExternalChangesWatchHandlers } from './externalChangesWatchHandlers';

type WatchHandlers = ReturnType<typeof useExternalChangesWatchHandlers>;

// 监视运行时：信封/健康事件入队 + 事件分派 + 两个生命周期效果。各依赖数组逐字保持。
export function useExternalChangesWatchRuntime(
  deps: ExternalChangesDeps,
  handlers: WatchHandlers,
) {
  const enqueueers = useWatchEnqueueers(deps, handlers);
  useExternalChangesWatchEffects(deps, enqueueers);
  return enqueueers;
}
