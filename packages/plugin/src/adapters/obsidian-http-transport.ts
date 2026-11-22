import { HttpRequestOptions, HttpResponse, HttpTransport } from '@obsidian-notion-sync/core';
import { requestUrl } from 'obsidian';

/**
 * HttpTransport backed by Obsidian's `requestUrl`, which bypasses browser CORS
 * restrictions and works on both Obsidian Desktop and Mobile.
 */
export class ObsidianHttpTransport implements HttpTransport {
  async request(options: HttpRequestOptions): Promise<HttpResponse> {
    let body: string | ArrayBuffer | undefined;
    if (typeof options.body === 'string') {
      body = options.body;
    } else if (options.body instanceof Uint8Array) {
      const buf = new ArrayBuffer(options.body.byteLength);
      new Uint8Array(buf).set(options.body);
      body = buf;
    }

    const res = await requestUrl({
      url: options.url,
      method: options.method,
      headers: options.headers,
      body,
      throw: false,
    });

    const normalizedHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(res.headers ?? {})) {
      normalizedHeaders[k.toLowerCase()] = v;
    }

    return {
      status: res.status,
      headers: normalizedHeaders,
      text: async () => res.text,
      json: async <T = unknown>() => res.json as T,
      arrayBuffer: async () => res.arrayBuffer,
    };
  }
}
