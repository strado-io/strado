// VS Code 1.136+ serves its web workbench with SAMEORIGIN/frame-ancestors
// headers. Strado intentionally embeds that localhost workbench from its own
// localhost port, so Electron must relax only the framing directives for the
// exact VS Code origins the renderer registered.

function vscodeOrigin(value) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'http:' ||
      url.hostname !== '127.0.0.1' ||
      !url.port ||
      url.username ||
      url.password
    ) return null;
    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function withoutFrameAncestors(value) {
  return String(value)
    .split(';')
    .map((directive) => directive.trim())
    .filter((directive) => directive && !/^frame-ancestors(?:\s|$)/i.test(directive))
    .join('; ');
}

function stripVsCodeFrameHeaders(headers = {}) {
  const next = {};
  for (const [name, values] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower === 'x-frame-options') continue;
    if (lower === 'content-security-policy') {
      const policies = (values ?? []).map(withoutFrameAncestors).filter(Boolean);
      if (policies.length) next[name] = policies;
      continue;
    }
    next[name] = values;
  }
  return next;
}

function headersForRequest(details, allowedByWebContents) {
  if (details?.resourceType !== 'subFrame') return details?.responseHeaders;
  const origin = vscodeOrigin(details.url);
  const allowed = allowedByWebContents.get(details.webContentsId);
  if (!origin || !allowed?.has(origin)) return details.responseHeaders;
  return stripVsCodeFrameHeaders(details.responseHeaders);
}

module.exports = {
  vscodeOrigin,
  stripVsCodeFrameHeaders,
  headersForRequest,
};
