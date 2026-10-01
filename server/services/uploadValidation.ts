import fs from 'node:fs/promises';

export class DocumentError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'DocumentError'; }
}

export function validFileSignature(header: Uint8Array, mime: string): boolean {
  const buf = Buffer.from(header);
  const matches = (bytes: number[], offset = 0) => buf.subarray(offset, offset + bytes.length).equals(Buffer.from(bytes));
  switch (mime) {
    case 'application/pdf': return matches([0x25, 0x50, 0x44, 0x46, 0x2d]);
    case 'image/png': return matches([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'image/jpeg': return matches([0xff, 0xd8, 0xff]);
    case 'image/gif': return matches([71, 73, 70, 56, 55, 97]) || matches([71, 73, 70, 56, 57, 97]);
    case 'image/webp': return matches([82, 73, 70, 70]) && matches([87, 69, 66, 80], 8);
    case 'text/plain': case 'text/markdown': case 'text/csv':
      // UTF-8 text only; HTML-like text remains inert under text/* and nosniff.
      try { new TextDecoder('utf-8', { fatal: true }).decode(buf, { stream: true }); return !buf.includes(0); }
      catch { return false; }
    default: return false;
  }
}

export async function validateStoredContent(filePath: string, mime: string, expectedSize: number): Promise<void> {
  const file = await fs.open(filePath, 'r');
  try {
    const stat = await file.stat();
    if (stat.size !== expectedSize) throw new DocumentError('size_mismatch', 'Stored file size does not match the upload.');
    const header = Buffer.alloc(4096);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    if (!validFileSignature(header.subarray(0, bytesRead), mime)) {
      throw new DocumentError('invalid_file', 'File content does not match its declared type.');
    }
  } finally { await file.close(); }
}
