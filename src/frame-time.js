export function normalizeFrameDelta(value) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value;
}
