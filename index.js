/**
 * Cloudflare Worker: WebAssembly Game Edge Proxy
 * Features: Chunked Streaming, Accept-Ranges, COOP/COEP Isolation, Cache API
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const originHost = 'gta.deloskiyt.pl';
    const isGet = request.method === 'GET';
    
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), request);

    // 1. Edge Cache Check
    if (isGet) {
      const cachedResponse = await cache.match(cacheKey);
      if (cachedResponse) {
        return cachedResponse;
      }
    }

    // 2. Fetch from Upstream Origin
    const targetUrl = new URL(request.url);
    targetUrl.hostname = originHost;
    targetUrl.protocol = 'https:';

    const proxyRequest = new Request(targetUrl.toString(), {
      method: request.method,
      headers: request.headers,
      redirect: 'follow'
    });

    let response;
    try {
      response = await fetch(proxyRequest);
    } catch (e) {
      return new Response("Origin Server Offline", { status: 502 });
    }

    const contentType = response.headers.get('Content-Type') || '';
    const isHtml = contentType.includes('text/html');
    let modifiedResponse = response;

    // 3. HTML Injection & Rewriting (Only on HTML files)
    if (isHtml) {
      const rewriter = new HTMLRewriter()
        .on('[src]', {
          element(e) {
            const src = e.getAttribute('src');
            if (src && src.includes(originHost)) {
              e.setAttribute('src', src.replace(new RegExp(`https?://${originHost}`, 'g'), ''));
            }
          }
        })
        .on('[href]', {
          element(e) {
            const href = e.getAttribute('href');
            if (href && href.includes(originHost)) {
              e.setAttribute('href', href.replace(new RegExp(`https?://${originHost}`, 'g'), ''));
            }
          }
        });
        
      modifiedResponse = rewriter.transform(modifiedResponse);
    }

    // 4. Attach Critical Security & Streaming Headers
    const responseHeaders = new Headers(modifiedResponse.headers);
    
    // Strict Multithreading Isolation
    responseHeaders.set('Access-Control-Allow-Origin', '*');
    responseHeaders.set('Cross-Origin-Opener-Policy', 'same-origin');
    responseHeaders.set('Cross-Origin-Embedder-Policy', 'require-corp');
    
    // Ensure chunked streaming support is strictly forwarded
    responseHeaders.set('Accept-Ranges', 'bytes');

    // Force strict WASM MIME type to trigger browser native instantiateStreaming
    if (url.pathname.endsWith('.wasm')) {
      responseHeaders.set('Content-Type', 'application/wasm');
    }

    if (isGet && response.status === 200) {
      if (isHtml) {
        responseHeaders.set('Cache-Control', 'public, max-age=3600');
      } else {
        responseHeaders.set('Cache-Control', 'public, max-age=31536000, immutable');
      }
    }

    // 5. Stream Body directly to client without buffering in Worker memory
    const finalResponse = new Response(modifiedResponse.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders
    });

    // 6. Cache the clone asynchronously 
    if (isGet && (response.status === 200 || response.status === 206)) {
      ctx.waitUntil(cache.put(cacheKey, finalResponse.clone()));
    }

    return finalResponse;
  }
};
