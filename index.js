/**
 * Cloudflare Worker: WebAssembly Game Edge Proxy & Permanent Archiver
 * Bindings Required: 
 * - R2 Bucket bound to `GAME_STORAGE`
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const originHost = 'gta.deloskiyt.pl';
    const originUrl = `https://${originHost}`;
    
    // Normalize root path to index.html for R2 storage key consistency
    let key = url.pathname;
    if (key === '/') key = '/index.html';

    // Mandatory SharedArrayBuffer isolation & CORS headers
    const securityHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    };

    // Infinite cache headers for R2 mirrored assets
    const immutableCacheHeaders = {
      ...securityHeaders,
      'Cache-Control': 'public, max-age=31536000, immutable'
    };

    // 1. LAZY MIRRORING - Check R2 Storage First
    if (request.method === 'GET') {
      try {
        const cachedObject = await env.GAME_STORAGE.get(key);
        if (cachedObject) {
          const headers = new Headers(immutableCacheHeaders);
          cachedObject.writeHttpMetadata(headers);
          return new Response(cachedObject.body, { headers });
        }
      } catch (error) {
        // If R2 errors (e.g., bucket down), fail silently and fallback to origin
        console.error("R2 Read Error:", error);
      }
    }

    // 2. CACHE MISS - Fetch from Upstream Origin Server
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

    // 3. ASYNC ARCHIVING - Store permanently in R2
    if (request.method === 'GET' && response.status === 200) {
      // Clone response immediately because body can only be read once
      const responseClone = response.clone();
      const contentType = response.headers.get('Content-Type') || 'application/octet-stream';

      // Non-blocking async archival to prevent delaying the user's response
      ctx.waitUntil(
        env.GAME_STORAGE.put(key, responseClone.body, {
          httpMetadata: { contentType }
        }).catch(err => console.error("R2 Write Error:", err))
      );
    }

    // 4. HTML INJECTION & REWRITING
    const isHtml = response.headers.get('Content-Type')?.includes('text/html');
    if (isHtml) {
      const rewriter = new HTMLRewriter()
        // Rewrite asset paths pointing directly to the origin
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
        
      response = rewriter.transform(response);
    }

    // 5. ATTACH SECURITY HEADERS TO ORIGIN RESPONSE
    const responseHeaders = new Headers(response.headers);
    Object.entries(securityHeaders).forEach(([k, v]) => responseHeaders.set(k, v));

    // Ensure downstream caches know this might be modified
    responseHeaders.set('Cache-Control', 'public, max-age=0, must-revalidate');

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders
    });
  }
};
