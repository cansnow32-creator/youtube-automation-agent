'use strict';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function parseHostHeader(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = new URL(`http://${value.trim()}`);
    if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
    let hostname = parsed.hostname.toLowerCase();
    if (hostname.startsWith('[') && hostname.endsWith(']')) hostname = hostname.slice(1, -1);
    return { hostname, authority: parsed.host.toLowerCase() };
  } catch (_error) {
    return null;
  }
}

function isLoopbackRequestHostname(hostname) {
  if (hostname === 'localhost' || hostname === '::1') return true;
  const octets = hostname.split('.');
  return octets.length === 4 &&
    octets[0] === '127' &&
    octets.every(part => /^\\d{1,3}$/.test(part) && Number(part) <= 255);
}

function createSameOriginMutationGuard() {
  return (req, res, next) => {
    if (SAFE_METHODS.has(String(req.method || 'GET').toUpperCase())) return next();

    const requestHost = parseHostHeader(req.get('host'));
    if (!requestHost || !isLoopbackRequestHostname(requestHost.hostname)) {
      return res.status(403).json({ success: false, error: 'Mutating requests must use a loopback Host header' });
    }

    const fetchSite = String(req.get('sec-fetch-site') || '').toLowerCase();
    if (fetchSite === 'cross-site') {
      return res.status(403).json({ success: false, error: 'Cross-site state-changing requests are not allowed' });
    }

    const origin = req.get('origin');
    if (origin !== undefined && origin !== null && origin !== '') {
      let parsedOrigin;
      try {
        parsedOrigin = new URL(origin);
      } catch (_error) {
        return res.status(403).json({ success: false, error: 'Invalid request Origin' });
      }

      if (
        parsedOrigin.origin === 'null' ||
        parsedOrigin.protocol !== 'http:' ||
        !isLoopbackRequestHostname(parsedOrigin.hostname.replace(/^\\[|\\]$/g, '').toLowerCase()) ||
        parsedOrigin.host.toLowerCase() !== requestHost.authority
      ) {
        return res.status(403).json({ success: false, error: 'Cross-origin state-changing requests are not allowed' });
      }
    }

    return next();
  };
}

module.exports = { createSameOriginMutationGuard, isLoopbackRequestHostname, parseHostHeader };
