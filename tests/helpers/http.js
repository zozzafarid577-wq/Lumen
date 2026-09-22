// Stand-ins for Vercel's req/res, just enough for the api/ handlers.

export function makeReq({ method = 'POST', body = {}, token = 'test-token', headers = {} } = {}) {
  return {
    method,
    body,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
  };
}

export function makeRes() {
  return {
    statusCode: null,
    body: undefined,
    headers: {},
    ended: false,
    setHeader(k, v) { this.headers[k] = v; return this; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; this.ended = true; return this; },
    end() { this.ended = true; return this; },
  };
}
