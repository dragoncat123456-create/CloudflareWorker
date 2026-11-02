// ============================================================
// Cloudflare Worker：慢线网关
// 按模型名路由到 Groq / NVIDIA / Cohere / Gemini，剥掉 IP 头，不设人为超时
// ============================================================

const UPSTREAMS = {
  groq:   { base: 'https://api.groq.com/openai/v1',              keyEnv: 'GROQ_API_KEY' },
  nvidia: { base: 'https://integrate.api.nvidia.com/v1',         keyEnv: 'NVIDIA_API_KEY' },
  cohere: { base: 'https://api.cohere.ai/compatibility/v1',      keyEnv: 'COHERE_API_KEY' },
  gemini: { base: 'https://generativelanguage.googleapis.com/v1beta/openai', keyEnv: 'GEMINI_API_KEY' },
};

const MODELS = {
  'openai/gpt-oss-20b': 'groq',
  'openai/gpt-oss-120b': 'groq',
  'qwen/qwen3.8-27b': 'groq',
  'canopylabs/*': 'groq',
  'nvidia/*': 'nvidia',
  'meta/*': 'nvidia',
  'mistralai/*': 'nvidia',
  'command-*': 'cohere',
  'c4ai-*': 'cohere',
  'gemini-*': 'gemini',
  'gemma-*': 'gemini',
};

const DROP = new Set([
  'host', 'connection', 'content-length',
  'x-forwarded-for', 'x-real-ip', 'cf-connecting-ip',
  'cf-ipcountry', 'cf-ray', 'cdn-loop',
  'x-forwarded-proto', 'x-forwarded-host',
]);

function resolveModel(model) {
  if (!model) return null;
  if (MODELS[model]) return MODELS[model];
  let best = null;
  for (const [pat, up] of Object.entries(MODELS)) {
    if (!pat.endsWith('*')) continue;
    const prefix = pat.slice(0, -1);
    if (model.startsWith(prefix) && (!best || prefix.length > best.len)) {
      best = { up, len: prefix.length };
    }
  }
  return best ? best.up : null;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1) 网关认证
    if (env.GATEWAY_TOKEN) {
      const auth = request.headers.get('authorization') || '';
      if (auth !== `Bearer ${env.GATEWAY_TOKEN}`) {
        return json({ error: 'unauthorized' }, 401);
      }
    }

    // 2) 路径：/v1/chat/completions → chat/completions
    let p = url.pathname.replace(/^\/+/, '');
    if (p.startsWith('v1/')) p = p.slice(3);

    // 3) 读 body 拿 model
    let bodyText = null;
    let model = null;
    const ct = (request.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('application/json') && request.method !== 'GET' && request.method !== 'HEAD') {
      bodyText = await request.text();
      try { model = JSON.parse(bodyText).model || null; } catch { model = null; }
    }

    // 4) 路由：?up= 强制 > 按模型名 > 默认 groq
    const params = new URLSearchParams(url.search);
    const forceUp = params.get('up');
    params.delete('up');
    const qs = params.toString();

    const up = forceUp || resolveModel(model) || 'groq';
    const cfg = UPSTREAMS[up];
    if (!cfg) return json({ error: `unknown upstream: ${up}` }, 400);

    // 5) 目标
    const target = `${cfg.base}/${p}${qs ? '?' + qs : ''}`;

    // 6) 头：剥 IP 头 + 注入该厂商 key
    const headers = new Headers();
    for (const [k, v] of request.headers) {
      if (!DROP.has(k.toLowerCase())) headers.set(k, v);
    }
    const key = env[cfg.keyEnv];
    if (key) headers.set('authorization', `Bearer ${key}`);

    // 7) 转发（不设人为超时，等上游自己返回）
    const init = { method: request.method, headers };
    if (bodyText !== null) init.body = bodyText;
    else if (request.method !== 'GET' && request.method !== 'HEAD') init.body = request.body;

    const upstream = await fetch(target, init);

    // 8) 回传（流式原样透传）
    const respHeaders = new Headers(upstream.headers);
    return new Response(upstream.body, {
      status: upstream.status,
      headers: respHeaders,
    });
  },
};
