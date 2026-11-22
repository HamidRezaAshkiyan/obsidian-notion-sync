export interface MultipartFileField {
  name: string;
  filename: string;
  contentType: string;
  data: Uint8Array;
}

export interface MultipartTextField {
  name: string;
  value: string;
}

export interface MultipartPayload {
  contentType: string;
  body: Uint8Array;
}

/**
 * Pure Uint8Array multipart/form-data builder so binary uploads work identically
 * over Obsidian's `requestUrl` (ArrayBuffer) and Node's `fetch`.
 */
export function buildMultipartFormData(
  fields: Array<MultipartFileField | MultipartTextField>
): MultipartPayload {
  const boundary = `----ObsidianNotionBoundary${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];

  for (const field of fields) {
    if ('data' in field) {
      const safeFilename = field.filename.replace(/"/g, '\\"');
      const header =
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${field.name}"; filename="${safeFilename}"\r\n` +
        `Content-Type: ${field.contentType}\r\n\r\n`;
      chunks.push(encoder.encode(header));
      chunks.push(field.data);
      chunks.push(encoder.encode('\r\n'));
    } else {
      const part =
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${field.name}"\r\n\r\n` +
        `${field.value}\r\n`;
      chunks.push(encoder.encode(part));
    }
  }

  chunks.push(encoder.encode(`--${boundary}--\r\n`));

  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const body = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body,
  };
}
