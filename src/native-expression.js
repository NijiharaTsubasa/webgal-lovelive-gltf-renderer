export function isNativeExpression(value) {
  return typeof value === "string" && value.startsWith("3d:");
}

export function parseNativeExpression(value) {
  if (!isNativeExpression(value)) throw new Error("原生表情必须以 3d: 开头");
  const parts = value.slice(3).split("/");
  if (parts.length === 2 && parts[0] === "face") {
    return parts[1] ? {face: decodeURIComponent(parts[1])} : {};
  }
  if (parts.length !== 3) throw new Error("原生表情必须包含眼型、闭口、张口三个槽位");
  const selection = {};
  for (const [index, key] of ["eye", "closed", "open"].entries()) {
    if (parts[index]) selection[key] = decodeURIComponent(parts[index]);
  }
  return selection;
}

export function formatNativeExpression(selection) {
  if (selection.face !== undefined) {
    if (["eye", "closed", "open"].some(key => selection[key] !== undefined)) throw new Error("face 不能与独立眼口组合");
    return `3d:face/${encodeURIComponent(selection.face)}`;
  }
  return `3d:${["eye", "closed", "open"].map(key => encodeURIComponent(selection[key] ?? "")).join("/")}`;
}
