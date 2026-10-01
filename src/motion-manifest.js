import { componentsOfType, isManifestObject } from "./resource-manifest.js";

function fail(source, message) {
  throw new Error(`${source}: ${message}`);
}

function isPackageRelativeMotion(path) {
  if (typeof path !== "string" || !path.trim()) return false;
  const normalized = path.replaceAll("\\", "/");
  return !normalized.startsWith("/")
    && !/^[A-Za-z]:\//.test(normalized)
    && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(normalized)
    && !normalized.split("/").includes("..")
    && (normalized.endsWith(".json") || normalized.endsWith(".motionbin"));
}

export function validateMotionManifest(config, source = "config.json") {
  componentsOfType(config, "motion", source);
  const identities = new Set();
  for (const [index, component] of config.components.entries()) {
    if (component.type !== "motion") continue;
    const componentSource = `${source} components[${index}]`;
    if (typeof component.name !== "string" || !component.name.trim()) {
      fail(componentSource, "name 必须是非空字符串");
    }
    if (component.description !== undefined && typeof component.description !== "string") {
      fail(componentSource, "description 必须是字符串");
    }
    if (component.motionGroup !== undefined
        && (typeof component.motionGroup !== "string" || !component.motionGroup.trim())) {
      fail(componentSource, "motionGroup 存在时必须是非空字符串");
    }
    if (!isPackageRelativeMotion(component.src)) {
      fail(componentSource, "src 必须是包内相对 JSON 或二进制动作路径");
    }
    const identity = `${component.motionGroup || ""}\0${component.name}`;
    if (identities.has(identity)) {
      fail(source, `重复动作 ${component.motionGroup || "<common>"}/${component.name}`);
    }
    identities.add(identity);
  }
  return config;
}

export function expandMotionManifest(config, configPath) {
  validateMotionManifest(config, configPath);
  const slash = configPath.lastIndexOf("/");
  const basePath = slash < 0 ? "" : configPath.slice(0, slash);
  return config.components.filter((component) => component.type === "motion").map((component) => ({
    key: `${configPath}#motion:${component.motionGroup || ""}:${component.name}`,
    name: component.name,
    description: component.description || "",
    motionGroup: component.motionGroup,
    src: component.src.replaceAll("\\", "/"),
    basePath,
    component,
  }));
}

export function validateMotionPayload(payload, source = "motion.json") {
  if (!isManifestObject(payload)) fail(source, "动作正文必须是对象");
  for (const metadata of ["type", "name", "description", "motionGroup"]) {
    if (metadata in payload) fail(source, `动作正文不得包含 ${metadata}`);
  }
  for (const collection of ["clips", "auxiliaryClips", "leftHandPoses", "rightHandPoses"]) {
    if (!Array.isArray(payload[collection])) fail(source, `${collection} 必须是数组`);
  }
  if (!isManifestObject(payload.program) || !Array.isArray(payload.program.layers)) {
    fail(source, "program 必须包含 layers 数组");
  }
  return payload;
}
