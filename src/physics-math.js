// Largest singular value: unlike the largest column, this also encloses shear.
export function maximumStretch(matrix) {
  const a = matrix.elements;
  // Same symmetric eigenvalue calculation, without allocating nested arrays
  // for every collider and spring on every fixed simulation step.
  const g00 = a[0] ** 2 + a[1] ** 2 + a[2] ** 2;
  const g11 = a[4] ** 2 + a[5] ** 2 + a[6] ** 2;
  const g22 = a[8] ** 2 + a[9] ** 2 + a[10] ** 2;
  const g01 = a[0] * a[4] + a[1] * a[5] + a[2] * a[6];
  const g02 = a[0] * a[8] + a[1] * a[9] + a[2] * a[10];
  const g12 = a[4] * a[8] + a[5] * a[9] + a[6] * a[10];
  const off = g01 ** 2 + g02 ** 2 + g12 ** 2;
  if (off === 0) return Math.sqrt(Math.max(g00, g11, g22));
  const mean = (g00 + g11 + g22) / 3;
  const spread = Math.sqrt(((g00 - mean) ** 2 + (g11 - mean) ** 2 + (g22 - mean) ** 2 + 2 * off) / 6);
  const b00 = (g00 - mean) / spread, b11 = (g11 - mean) / spread, b22 = (g22 - mean) / spread;
  const b01 = g01 / spread, b02 = g02 / spread, b12 = g12 / spread;
  const det = b00 * (b11 * b22 - b12 * b12)
    - b01 * (b01 * b22 - b12 * b02) + b02 * (b01 * b12 - b11 * b02);
  const angle = Math.acos(Math.max(-1, Math.min(1, det / 2))) / 3;
  return Math.sqrt(Math.max(0, mean + 2 * spread * Math.cos(angle)));
}
