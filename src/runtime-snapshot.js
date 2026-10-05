// Query results own their data. Never freeze a caller's controller/manifest.
export function readonlySnapshot(value) {
  const copy = structuredClone(value);
  const freeze = (item) => {
    if (item && typeof item === "object") {
      for (const child of Object.values(item)) freeze(child);
      Object.freeze(item);
    }
    return item;
  };
  return freeze(copy);
}

export function expressionDefinition(component) {
  if (!component.morphPoses) return null;
  const fields = ["morphPoses", "expressionGroups", "defaultExpression", "parameters"];
  return readonlySnapshot(Object.fromEntries(fields
    .filter((key) => component[key] !== undefined)
    .map((key) => [key, component[key]])));
}
