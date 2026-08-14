export const EXCALIDRAW_FONT_FAMILY = 5;

export interface ExcalidrawScene {
  appState: Record<string, unknown>;
  elements: Record<string, unknown>[];
  files: Record<string, unknown>;
  source?: string;
  type: 'excalidraw';
  version: 2;
  [key: string]: unknown;
}

interface SceneElement {
  id: string;
  record: Record<string, unknown>;
}

interface BoundElement {
  id: string;
  type: string;
}

function invalidScene(reason: string): never {
  throw new Error(`Invalid Excalidraw scene: ${reason}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredId(value: unknown, context: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    invalidScene(`${context} must be a non-empty string`);
  }
  return value;
}

function isDeleted(element: Record<string, unknown>): boolean {
  return element.isDeleted === true;
}

function boundElements(element: SceneElement): BoundElement[] {
  const value = element.record.boundElements;
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) invalidScene(`boundElements for ${element.id} must be an array`);
  return value.map((binding) => {
    if (!isRecord(binding)) invalidScene(`boundElements for ${element.id} contains an invalid entry`);
    return {
      id: requiredId(binding.id, `bound element on ${element.id}`),
      type: requiredId(binding.type, `bound element on ${element.id}`),
    };
  });
}

function hasBoundElement(element: SceneElement, id: string, type: string): boolean {
  return boundElements(element).some((binding) => binding.id === id && binding.type === type);
}

function bindingTargetId(
  element: SceneElement,
  property: 'startBinding' | 'endBinding',
): string | null {
  const value = element.record[property];
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) invalidScene(`${property} for ${element.id} must be an object or null`);
  return requiredId(value.elementId, `${property} for ${element.id}`);
}

function validateLinearPoints(element: SceneElement): void {
  const points = element.record.points;
  if (!Array.isArray(points) || points.length < 2) {
    invalidScene(`linear element ${element.id} must contain at least two points`);
  }

  let prior: [number, number] | null = null;
  for (const point of points) {
    if (
      !Array.isArray(point)
      || point.length !== 2
      || typeof point[0] !== 'number'
      || typeof point[1] !== 'number'
      || !Number.isFinite(point[0])
      || !Number.isFinite(point[1])
    ) {
      invalidScene(`linear element ${element.id} contains an invalid point`);
    }
    const current: [number, number] = [point[0], point[1]];
    if (prior && prior[0] === current[0] && prior[1] === current[1]) {
      invalidScene(`linear element ${element.id} contains overlapping points`);
    }
    prior = current;
  }
}

function validateSceneElements(elements: Record<string, unknown>[]): void {
  const allElements = new Map<string, SceneElement>();
  for (const record of elements) {
    if (!isRecord(record)) invalidScene('elements must contain objects');
    if (Object.prototype.hasOwnProperty.call(record, 'label')) {
      invalidScene('elements must not use a private label field');
    }
    const id = requiredId(record.id, 'element id');
    if (allElements.has(id)) invalidScene(`duplicate element id ${id}`);
    allElements.set(id, { id, record });
  }

  const activeElements = new Map(
    [...allElements].filter(([, element]) => !isDeleted(element.record)),
  );

  for (const element of activeElements.values()) {
    const type = requiredId(element.record.type, `type for ${element.id}`);
    const bindings = boundElements(element);
    const seenBindings = new Set<string>();
    for (const binding of bindings) {
      const key = `${binding.type}:${binding.id}`;
      if (seenBindings.has(key)) invalidScene(`duplicate binding ${key} on ${element.id}`);
      seenBindings.add(key);
    }

    if (type === 'text') {
      const containerId = element.record.containerId;
      if (containerId !== undefined && containerId !== null) {
        const resolvedContainerId = requiredId(containerId, `containerId for ${element.id}`);
        const container = activeElements.get(resolvedContainerId);
        if (!container || !hasBoundElement(container, element.id, 'text')) {
          invalidScene(`text ${element.id} is not bound bidirectionally to its container`);
        }
      }
    }

    if (type === 'line' || type === 'arrow') validateLinearPoints(element);
    if (type !== 'arrow') continue;

    for (const property of ['startBinding', 'endBinding'] as const) {
      const targetId = bindingTargetId(element, property);
      if (!targetId) continue;
      const target = activeElements.get(targetId);
      if (!target || !hasBoundElement(target, element.id, 'arrow')) {
        invalidScene(`arrow ${element.id} is not registered on its ${property} element`);
      }
    }
  }

  for (const element of activeElements.values()) {
    for (const binding of boundElements(element)) {
      const target = activeElements.get(binding.id);
      if (!target) invalidScene(`binding ${binding.id} on ${element.id} points to a missing element`);
      const targetType = requiredId(target.record.type, `type for ${target.id}`);
      if (binding.type === 'text') {
        if (targetType !== 'text' || target.record.containerId !== element.id) {
          invalidScene(`bound text ${binding.id} does not point back to ${element.id}`);
        }
      }
      if (binding.type === 'arrow') {
        if (targetType !== 'arrow') invalidScene(`bound arrow ${binding.id} is not an arrow`);
        const start = bindingTargetId(target, 'startBinding');
        const end = bindingTargetId(target, 'endBinding');
        if (start !== element.id && end !== element.id) {
          invalidScene(`bound arrow ${binding.id} does not point back to ${element.id}`);
        }
      }
    }
  }
}

export function createEmptyExcalidrawScene(): ExcalidrawScene {
  return {
    appState: {
      currentItemFontFamily: EXCALIDRAW_FONT_FAMILY,
      currentItemRoughness: 1,
      viewBackgroundColor: 'transparent',
    },
    elements: [],
    files: {},
    source: 'mmd',
    type: 'excalidraw',
    version: 2,
  };
}

export function parseExcalidrawScene(content: string): ExcalidrawScene {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return invalidScene('JSON could not be parsed');
  }
  if (!isRecord(parsed)) return invalidScene('root must be an object');
  if (parsed.type !== 'excalidraw') return invalidScene('type must be excalidraw');
  if (parsed.version !== 2) return invalidScene('version must be 2');
  if (!Array.isArray(parsed.elements)) return invalidScene('elements must be an array');
  if (!isRecord(parsed.appState)) return invalidScene('appState must be an object');
  if (!isRecord(parsed.files)) return invalidScene('files must be an object');
  if (parsed.source !== undefined && typeof parsed.source !== 'string') {
    return invalidScene('source must be a string');
  }

  const scene: ExcalidrawScene = {
    ...parsed,
    appState: parsed.appState,
    elements: parsed.elements,
    files: parsed.files,
    type: 'excalidraw',
    version: 2,
  };
  validateSceneElements(scene.elements);
  return scene;
}
