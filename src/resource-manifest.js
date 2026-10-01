function fail(source, message) {
  throw new Error(`${source}: ${message}`);
}

export function isManifestObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function validateResourceManifest(config, source = "config.json") {
  if (!isManifestObject(config)) fail(source, "顶层必须是对象");
  const keys = Object.keys(config);
  if (keys.length !== 1 || keys[0] !== "components") {
    fail(source, "顶层只能包含 components");
  }
  if (!Array.isArray(config.components) || config.components.length === 0) {
    fail(source, "components 必须是非空数组");
  }
  for (const [index, component] of config.components.entries()) {
    const componentSource = `${source} components[${index}]`;
    if (!isManifestObject(component)) fail(componentSource, "必须是对象");
    if (typeof component.type !== "string" || !component.type.trim()) {
      fail(componentSource, "type 必须是非空字符串");
    }
  }
  return config;
}

export function componentsOfType(config, type, source = "config.json") {
  validateResourceManifest(config, source);
  return config.components.filter((component) => component.type === type);
}

