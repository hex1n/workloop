// On-disk framing: LEN(u32 LE) + PAYLOAD + CRC(u32 LE).
//
// The length prefix and the checksum answer different questions, and the
// recovery policy depends on being able to tell them apart. The length prefix
// makes "the writer died mid-write" a mechanical fact (fewer bytes remain than
// the frame declared). The checksum catches "the bytes are all here but wrong".
// The first is safe to truncate automatically, because a record that was never
// finished was never acknowledged to anyone. The second is not, because it
// cannot be distinguished from bit rot or tampering against a record that may
// well have been acknowledged.
import { crc32 } from "node:zlib";

export const HEADER_BYTES = 4;
export const CHECKSUM_BYTES = 4;
export const OVERHEAD_BYTES = HEADER_BYTES + CHECKSUM_BYTES;

export const TRAILING = Object.freeze({
  NONE: "none",
  INCOMPLETE: "incomplete",
  CORRUPT: "corrupt",
});

export function encodeFrame(payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
  const frame = Buffer.allocUnsafe(OVERHEAD_BYTES + body.length);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, HEADER_BYTES);
  frame.writeUInt32LE(crc32(body) >>> 0, HEADER_BYTES + body.length);
  return frame;
}

// Scans until the first frame that is not intact, and reports why it stopped.
// It never throws on damaged input: classification is the caller's decision
// input, not an error condition here.
export function scanFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const remaining = buffer.length - offset;
    if (remaining < HEADER_BYTES) {
      return { frames, trailing: { kind: TRAILING.INCOMPLETE, offset, bytes: remaining, reason: "length prefix is truncated" } };
    }
    const length = buffer.readUInt32LE(offset);
    const total = OVERHEAD_BYTES + length;
    if (remaining < total) {
      return { frames, trailing: { kind: TRAILING.INCOMPLETE, offset, bytes: remaining, reason: `frame declares ${length} payload bytes but only ${remaining - OVERHEAD_BYTES < 0 ? 0 : remaining - OVERHEAD_BYTES} are present` } };
    }
    const payload = buffer.subarray(offset + HEADER_BYTES, offset + HEADER_BYTES + length);
    const expected = buffer.readUInt32LE(offset + HEADER_BYTES + length);
    if ((crc32(payload) >>> 0) !== expected) {
      return { frames, trailing: { kind: TRAILING.CORRUPT, offset, bytes: total, reason: "frame checksum does not match its payload" } };
    }
    frames.push({ payload, start: offset, end: offset + total });
    offset += total;
  }
  return { frames, trailing: { kind: TRAILING.NONE, offset, bytes: 0, reason: null } };
}
