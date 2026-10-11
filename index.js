/**
 * Cloudflare Worker: WebAssembly Game Edge Proxy & Cache API
 * FREE TIER - No R2 Storage Required
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const originHost = 'gta.deloskiyt.pl';
    const isGet = request.method === 'GET';
    
    // The Cache API requires a Request object as the key
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), request);

    // 1. CACHE FIRST: Check Cloudflare's free Edge Cache
    if (isGet) {
      const cachedResponse = await cache.match(cacheKey);
      if (cachedResponse) {
        // Return immediately if found (already contains COOP/COEP headers)
        return cachedResponse;
      }
    }

    // 2. CACHE MISS: Fetch from Upstream Origin Server
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

    // 3. HTML INJECTION & REWRITING
    const isHtml = response.headers.get('Content-Type')?.includes('text/html');
    let modifiedResponse = response;

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

    // 4. ATTACH SECURITY & CACHE HEADERS
    const responseHeaders = new Headers(modifiedResponse.headers);
    
    // Mandatory SharedArrayBuffer isolation & CORS headers for WebAssembly
    responseHeaders.set('Access-Control-Allow-Origin', '*');
    responseHeaders.set('Cross-Origin-Opener-Policy', 'same-origin');
    responseHeaders.set('Cross-Origin-Embedder-Policy', 'require-corp');

    // Set Cache-Control so the Cloudflare Cache API knows how long to store it
    if (isGet && response.status === 200) {
      if (isHtml) {
        // HTML gets a shorter cache (1 hour) to allow for frontend updates
        responseHeaders.set('Cache-Control', 'public, max-age=3600');
      } else {
        // Game assets (.wasm, .js, .data, textures) cached for 1 year
        responseHeaders.set('Cache-Control', 'public, max-age=31536000, immutable');
      }
    }

    // Construct the final response to send to the user and the cache
    const finalResponse = new Response(modifiedResponse.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders
    });

    // 5. ASYNC CACHING: Store the successful response in the Edge Cache
    if (isGet && response.status === 200) {
      // ctx.waitUntil ensures caching finishes in the background without delaying the user
      ctx.waitUntil(cache.put(cacheKey, finalResponse.clone()));
    }

    return finalResponse;
  }
};
