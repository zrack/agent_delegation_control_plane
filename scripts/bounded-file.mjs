import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';

// Bound the actual read even if a selected file grows after opening.
export function readBytes(path, limit, { noFollow = false } = {}) {
  const file = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (noFollow ? constants.O_NOFOLLOW : 0));
  try {
    const info = fstatSync(file);
    if (!info.isFile() || info.size > limit) throw new Error('Expected a bounded regular file.');
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length <= limit) {
      const count = readSync(file, buffer, length, buffer.length - length);
      if (!count) return buffer.subarray(0, length);
      length += count;
    }
    throw new Error('File exceeds its size limit.');
  } finally {
    closeSync(file);
  }
}

export function readText(path, limit) {
  return new TextDecoder('utf-8', { fatal: true }).decode(readBytes(path, limit));
}
