/** Read a response incrementally so a hostile/invalid upstream cannot make a
 * persistent process retain a multi-megabyte body before the size check. */
export async function readResponseText(response: Response, limitBytes = 5_000_000) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limitBytes) throw new Error('网页内容超过 5 MB，已停止解析。');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limitBytes) {
        await reader.cancel('response body exceeds limit').catch(() => undefined);
        throw new Error('网页内容超过 5 MB，已停止解析。');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(concat(chunks, total));
}

function concat(chunks: Uint8Array[], total: number) {
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}
