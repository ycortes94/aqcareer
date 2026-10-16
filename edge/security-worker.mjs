// Route this Worker in front of the existing GitHub Pages origin.
// The document's hash-based meta CSP is authoritative for script hashes;
// this independent HTTP policy adds framing protection without stale hashes.
export function secureResponse(response) {
  const headers = new Headers(response.headers);
  headers.set('Content-Security-Policy', "frame-ancestors 'none'; object-src 'none'; base-uri 'none'");
  headers.set('X-Frame-Options', 'DENY');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  // Deliberately omit includeSubDomains/preload until all subdomains are verified.
  headers.set('Strict-Transport-Security', 'max-age=31536000');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.protocol !== 'https:') {
      url.protocol = 'https:';
      return secureResponse(Response.redirect(url.href, 301));
    }
    return secureResponse(await fetch(request));
  }
};
