export function applyRenderQueue(object, renderStates) {
  const queues = [];
  for (const state of renderStates || []) {
    const queue = state?.renderQueue;
    if (queue === undefined) continue;
    if (typeof queue !== "number" || !Number.isFinite(queue)) {
      throw new Error(`Object ${object.name || "<unnamed>"}: renderQueue must be a finite number`);
    }
    if (!queues.includes(queue)) queues.push(queue);
  }

  if (queues.length > 1) {
    throw new Error(
      `Object ${object.name || "<unnamed>"}: conflicting renderQueue values ${queues.join(", ")}`,
    );
  }
  if (queues.length === 1) object.renderOrder = queues[0];
}
