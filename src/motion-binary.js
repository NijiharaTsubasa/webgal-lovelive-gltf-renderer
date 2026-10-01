const MAGIC = [77, 79, 84, 73, 79, 78, 0, 0]; // MOTION\0\0
const COLLECTIONS = ["clips", "auxiliaryClips", "leftHandPoses", "rightHandPoses"];
const SAMPLE_FIELDS = ["rotation", "translation", "scale", "values"];
const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

function fail(message) {
  throw new Error(`Invalid binary motion: ${message}`);
}

export function decodeMotionBinary(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 12) fail("truncated prefix");
  const bytes = new Uint8Array(buffer);
  if (MAGIC.some((value, index) => bytes[index] !== value)) fail("signature mismatch");
  const view = new DataView(buffer);
  const headerLength = view.getUint32(8, true);
  const headerEnd = 12 + headerLength;
  const dataStart = Math.ceil(headerEnd / 8) * 8;
  if (dataStart > buffer.byteLength) fail("truncated header");
  let motion;
  try {
    motion = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(buffer, 12, headerLength)));
  } catch (error) {
    fail(`invalid JSON header: ${error.message}`);
  }
  for (const collection of COLLECTIONS) {
    for (const clip of motion[collection] || []) {
      for (const track of [...(clip.tracks || []), ...(clip.groupTracks || [])]) {
        for (const field of SAMPLE_FIELDS) {
          const descriptor = track[field];
          if (descriptor === undefined || Array.isArray(descriptor)) continue;
          const itemSize = descriptor?.type === "f32" ? 4 : descriptor?.type === "f64" ? 8 : 0;
          const { offset, length } = descriptor || {};
          if (!itemSize || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length)
              || offset < 0 || length < 0 || offset % itemSize
              || length > Math.floor((buffer.byteLength - dataStart - offset) / itemSize)) {
            fail(`${collection} ${clip.id || clip.name}: invalid ${field} range`);
          }
          const absolute = dataStart + offset;
          if (littleEndian) {
            track[field] = itemSize === 4
              ? new Float32Array(buffer, absolute, length)
              : new Float64Array(buffer, absolute, length);
          } else {
            const samples = itemSize === 4 ? new Float32Array(length) : new Float64Array(length);
            for (let index = 0; index < length; index++) {
              samples[index] = itemSize === 4
                ? view.getFloat32(absolute + index * itemSize, true)
                : view.getFloat64(absolute + index * itemSize, true);
            }
            track[field] = samples;
          }
        }
      }
    }
  }
  return motion;
}

export async function fetchMotionPayload(url, fetchResource = fetch) {
  const response = await fetchResource(url);
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return new URL(url, import.meta.url).pathname.endsWith(".motionbin")
    ? decodeMotionBinary(await response.arrayBuffer())
    : response.json();
}
