// Native MediaRecorder WebM streams often omit Duration. Patch only the small
// streaming header; encoded frames remain Blob slices and are never re-encoded.
// Element IDs/units: https://www.matroska.org/technical/elements.html
interface Element {
  id: number;
  start: number;
  sizeStart: number;
  data: number;
  end: number;
  unknown: boolean;
}

function element(bytes: Uint8Array, start: number): Element {
  function vint(at: number, id: boolean) {
    const first = bytes[at];
    if (!first) throw new Error("Invalid WebM header.");
    let length = 1,
      mask = 128;
    while (!(first & mask)) {
      length++;
      mask >>= 1;
    }
    if (length > (id ? 4 : 8) || at + length > bytes.length)
      throw new Error("Incomplete WebM header.");
    let value = id ? first : first & (mask - 1);
    let unknown = !id && value === mask - 1;
    for (let i = 1; i < length; i++) {
      value = value * 256 + bytes[at + i]!;
      unknown &&= bytes[at + i] === 255;
    }
    if (!unknown && !Number.isSafeInteger(value))
      throw new Error("Unsupported WebM header size.");
    return { value, length, unknown };
  }
  const id = vint(start, true),
    sizeStart = start + id.length;
  const size = vint(sizeStart, false),
    data = sizeStart + size.length;
  return {
    id: id.value,
    start,
    sizeStart,
    data,
    end: size.unknown ? Infinity : data + size.value,
    unknown: size.unknown,
  };
}

export async function finalizeWebmDuration(
  blob: Blob,
  seconds: number,
): Promise<Blob> {
  if (!Number.isFinite(seconds) || seconds <= 0)
    throw new Error("Invalid video duration.");
  const bytes = new Uint8Array(await blob.slice(0, 1024 * 1024).arrayBuffer());
  let root = element(bytes, 0);
  if (root.id !== 0x1a45dfa3)
    throw new Error("The encoder did not produce a WebM header.");
  root = element(bytes, root.end);
  if (root.id !== 0x18538067)
    throw new Error("The encoder did not produce a WebM segment.");
  let info: Element | undefined,
    indexed = false;
  for (let at = root.data; at < bytes.length;) {
    const child = element(bytes, at);
    if (child.id === 0x1f43b675) break; // Encoded clusters are not parsed or copied.
    if (child.id === 0x114d9b74 || child.id === 0x1c53bb6b) indexed = true;
    if (child.id === 0x1549a966) info = child;
    if (!Number.isFinite(child.end)) break;
    at = child.end;
  }
  if (!info || info.unknown || info.end > bytes.length)
    throw new Error(
      "Unsupported WebM information header. Try another browser.",
    );
  let scale = 1_000_000,
    duration: Element | undefined;
  for (let at = info.data; at < info.end;) {
    const child = element(bytes, at);
    if (child.end > info.end || child.unknown)
      throw new Error("Invalid WebM information header.");
    if (child.id === 0xbf)
      throw new Error(
        "Unsupported checksummed WebM header. Try another browser.",
      );
    if (child.id === 0x4489) duration = child;
    if (child.id === 0x2ad7b1) {
      scale = 0;
      for (let i = child.data; i < child.end; i++)
        scale = scale * 256 + bytes[i]!;
    }
    at = child.end;
  }
  if (!Number.isFinite(scale) || scale <= 0)
    throw new Error("Invalid WebM timestamp scale.");
  const value = (seconds * 1e9) / scale;
  if (duration) {
    const size = duration.end - duration.data,
      buffer = new ArrayBuffer(size),
      view = new DataView(buffer);
    if (size === 4) view.setFloat32(0, value);
    else if (size === 8) view.setFloat64(0, value);
    else throw new Error("Unsupported WebM duration field.");
    return new Blob(
      [blob.slice(0, duration.data), buffer, blob.slice(duration.end)],
      { type: blob.type },
    );
  }
  // Adding bytes to indexed/finite segments could invalidate offsets. Native
  // streaming captures use an unknown-sized segment without a seek index.
  if (!root.unknown || indexed)
    throw new Error(
      "This browser's WebM format cannot be finalized safely. Try another browser.",
    );
  const addition = new Uint8Array(11);
  addition.set([0x44, 0x89, 0x88]);
  new DataView(addition.buffer).setFloat64(3, value);
  const sizeLength = info.data - info.sizeStart,
    sizeBytes = new Uint8Array(sizeLength);
  let size = info.end - info.data + addition.length;
  if (size >= 2 ** (7 * sizeLength) - 1)
    throw new Error(
      "WebM header has no space for duration. Try another browser.",
    );
  for (let i = sizeLength - 1; i >= 0; i--) {
    sizeBytes[i] = size % 256;
    size = Math.floor(size / 256);
  }
  sizeBytes[0]! |= 1 << (8 - sizeLength);
  return new Blob(
    [
      blob.slice(0, info.sizeStart),
      sizeBytes,
      blob.slice(info.data, info.end),
      addition,
      blob.slice(info.end),
    ],
    { type: blob.type },
  );
}
