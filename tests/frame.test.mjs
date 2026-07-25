// Framing, and the distinction the whole recovery policy rests on:
// "the writer died mid-write" (safe to truncate) versus "the bytes are wrong"
// (never safe to truncate). greenfield/slices/01-log-kernel.md §1.1 and §4.
import assert from "node:assert/strict";
import test from "node:test";
import { OVERHEAD_BYTES, TRAILING, encodeFrame, scanFrames } from "../src/frame.mjs";

const payloads = ["{}", '{"a":1}', "x".repeat(1000), "🙂 combining é", ""];
const logOf = (items) => Buffer.concat(items.map((item) => encodeFrame(item)));
const texts = (frames) => frames.map((frame) => frame.payload.toString("utf8"));

test("frames round-trip and report their own byte extents", () => {
  const { frames, trailing } = scanFrames(logOf(payloads));
  assert.deepEqual(texts(frames), payloads);
  assert.equal(trailing.kind, TRAILING.NONE);
  for (const [index, frame] of frames.entries()) {
    assert.equal(frame.end - frame.start, OVERHEAD_BYTES + Buffer.byteLength(payloads[index], "utf8"));
    if (index > 0) assert.equal(frame.start, frames[index - 1].end);
  }
});

test("an empty log is valid and yields nothing", () => {
  const { frames, trailing } = scanFrames(Buffer.alloc(0));
  assert.deepEqual(frames, []);
  assert.equal(trailing.kind, TRAILING.NONE);
});

test("truncation at every byte offset reads as incomplete, never as corrupt", () => {
  const complete = logOf(["{}", '{"a":1}']);
  const lastFrameStart = scanFrames(complete).frames.at(-1).start;
  // Every cut inside the final frame: one byte in, mid length prefix, exactly
  // after the length prefix, mid payload, and one byte short of the checksum.
  for (let cut = lastFrameStart + 1; cut < complete.length; cut += 1) {
    const { frames, trailing } = scanFrames(complete.subarray(0, cut));
    assert.equal(trailing.kind, TRAILING.INCOMPLETE, `cut at ${cut}`);
    assert.equal(texts(frames).length, 1, `cut at ${cut} must keep the intact frame`);
    assert.equal(trailing.offset, lastFrameStart, `cut at ${cut} must point at the unfinished frame`);
  }
});

test("one byte short of the checksum is still incomplete, not corrupt", () => {
  // The sharpest case: the payload is fully present and parses as JSON, so a
  // scanner that judged by "does the tail look like a record" would accept it.
  // The verdict must come from the declared length alone.
  const complete = encodeFrame('{"a":1}');
  const { frames, trailing } = scanFrames(complete.subarray(0, complete.length - 1));
  assert.deepEqual(frames, []);
  assert.equal(trailing.kind, TRAILING.INCOMPLETE);
});

test("a complete frame with a wrong checksum is corrupt and is never truncated away", () => {
  const damaged = logOf(["{}", '{"a":1}']);
  const target = scanFrames(damaged).frames.at(-1);
  damaged[target.start + 5] ^= 0xff;
  const { frames, trailing } = scanFrames(damaged);
  assert.equal(trailing.kind, TRAILING.CORRUPT);
  assert.equal(frames.length, 1, "scanning stops at the damaged frame, keeping what precedes it");
  assert.equal(trailing.offset, target.start);
});

test("a corrupted length prefix is corrupt or incomplete, but never silently skipped", () => {
  const damaged = logOf(["{}", '{"a":1}']);
  const target = scanFrames(damaged).frames.at(-1);
  damaged.writeUInt32LE(0xffff, target.start);
  const { frames, trailing } = scanFrames(damaged);
  assert.equal(frames.length, 1);
  assert.notEqual(trailing.kind, TRAILING.NONE);
});

test("damage in the middle stops the scan there rather than resynchronising", () => {
  // Resynchronising would let a scanner invent a history that was never written.
  const damaged = logOf(["{}", '{"a":1}', '{"b":2}']);
  const middle = scanFrames(damaged).frames[1];
  damaged[middle.start + OVERHEAD_BYTES] ^= 0xff;
  const { frames, trailing } = scanFrames(damaged);
  assert.equal(frames.length, 1);
  assert.equal(trailing.kind, TRAILING.CORRUPT);
  assert.equal(trailing.offset, middle.start);
});
