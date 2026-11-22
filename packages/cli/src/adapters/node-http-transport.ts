import { HttpRequestOptions, HttpResponse, HttpTransport } from '@obsidian-notion-sync/core';

/**
 * HttpTransport backed by Node.js native `fetch`.
 */
export class NodeHttpTransport implements HttpTransport {
  async request(options: HttpRequestOptions): Promise<HttpResponse> {
    let body: BodyInit | undefined;
    if (typeof options.body === 'string') {
      body = options.body;
    } else if (options.body instanceof Uint8Array) {
      const buf = new ArrayBuffer(options.body.byteLength);
      new Uint8Array(buf).set(options.body);
      body = buf;
    }

    const res = await fetch(options.url, {
      method: options.method,
      headers: options.headers,
      body,
    });

    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    return {
      status: res.status,
      headers,
      text: () => res.text(),
      json: <T = unknown>() => res.json() as Promise<T>,
      arrayBuffer: () => res.arrayBuffer(),
    };
  }
}
