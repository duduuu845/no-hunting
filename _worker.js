/**
 * 禁猎区 · Cloudflare Workers MCP 服务器
 * 标准 Streamable HTTP 协议，零依赖单文件，网页控制台粘贴即用。
 * 工具：get_current_time（AI 分辨现实时间）、echo（连通性测试）
 * CORS 全开 + 暴露 Mcp-Session-Id，兼容小手机 McpClient。
 */

const PROTOCOL_VERSION = '2025-03-26';
const sessionStore = new Map(); // 宽松会话存储（单 Worker 实例内有效）

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Mcp-Session-Id, Accept, Authorization',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id',
  'Cache-Control': 'no-store',
};

function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/* ---------- 工具定义 ---------- */
const TOOLS = [
  {
    name: 'get_current_time',
    description: '获取当前真实日期和时间（默认北京时间 UTC+8，可传 timezone 如 "America/New_York"、"Asia/Tokyo"）。AI 需要判断"现在几点/今天星期几/几号"时调用此工具。',
    inputSchema: {
      type: 'object',
      properties: {
        timezone: { type: 'string', description: 'IANA 时区名，默认 Asia/Shanghai（北京时间）' },
      },
    },
  },
  {
    name: 'echo',
    description: '回显测试工具：把传入的 text 原样返回，用于验证 MCP 连接是否正常。',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: '要回显的文本' } },
    },
  },
];

function callTool(name, args) {
  if (name === 'echo') {
    return { content: [{ type: 'text', text: `echo: ${args && args.text !== undefined ? args.text : ''}` }] };
  }
  if (name === 'get_current_time') {
    const tz = (args && args.timezone) || 'Asia/Shanghai';
    try {
      const now = new Date();
      const fmt = new Intl.DateTimeFormat('zh-CN', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
        weekday: 'long', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      });
      const parts = fmt.formatToParts(now);
      const p = {};
      parts.forEach(x => { if (x.type !== 'literal') p[x.type] = x.value; });
      const out =
        `${p.year}年${p.month}月${p.day}日 ${p.weekday} ${p.hour}:${p.minute}:${p.second}（时区 ${tz}）`;
      return { content: [{ type: 'text', text: out }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `时区无效：${tz}` }], isError: true };
    }
  }
  return { content: [{ type: 'text', text: `未知工具：${name}` }], isError: true };
}

/* ---------- 请求分发 ---------- */
function handleMessage(body, sessionId) {
  if (!body || typeof body !== 'object' || body.jsonrpc !== '2.0') {
    return { status: 400, json: jsonRpcError(body && body.id, -32600, '无效的 JSON-RPC 请求') };
  }

  // 通知（无 id）→ 202 空响应
  if (body.method === 'notifications/initialized' || body.method === 'notifications/cancelled') {
    return { status: 202, json: null };
  }

  const id = body.id;

  if (body.method === 'initialize') {
    const clientInfo = (body.params && body.params.clientInfo) || {};
    const protocolVersion = (body.params && body.params.protocolVersion) || PROTOCOL_VERSION;
    // 给会话发一个新 session id（宽松：不强制后续携带）
    const newSession = crypto.randomUUID();
    sessionStore.set(newSession, { clientInfo, createdAt: Date.now() });
    return {
      status: 200,
      sessionId: newSession,
      json: {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'jinhailie-mcp', version: '1.0.0' },
        },
      },
    };
  }

  if (body.method === 'tools/list') {
    return { status: 200, json: { jsonrpc: '2.0', id, result: { tools: TOOLS } } };
  }

  if (body.method === 'tools/call') {
    const { name, arguments: args } = (body.params || {});
    try {
      const result = callTool(name, args || {});
      return { status: 200, json: { jsonrpc: '2.0', id, result } };
    } catch (e) {
      return { status: 500, json: jsonRpcError(id, -32603, `工具调用失败：${e.message}`) };
    }
  }

  return { status: 404, json: jsonRpcError(id, -32601, `未知方法：${body.method}`) };
}

function sseEnvelope(json) {
  return `event: message\ndata: ${JSON.stringify(json)}\n\n`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS 预检
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const accept = (request.headers.get('accept') || '').toLowerCase();

    // 判定是否为 MCP 请求：
    //  - 任意 POST（JSON-RPC）
    //  - GET 且路径含 /mcp
    //  - GET 且 Accept 为 text/event-stream
    const isMcp = request.method === 'POST'
      || url.pathname.endsWith('/mcp')
      || (request.method === 'GET' && accept.includes('text/event-stream'));

    if (!isMcp) {
      // 非 MCP 请求：Cloudflare Pages 一体化模式放行到静态资源（小手机页面正常打开）
      if (env && env.ASSETS) return env.ASSETS.fetch(request);
      // 纯 Worker 模式：返回服务信息（不影响 MCP 端点）
      return new Response(JSON.stringify({ server: 'jinhailie-mcp', protocol: 'streamable-http', tools: TOOLS.map(t => t.name), hint: 'MCP 端点: /mcp' }),
        { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
    }

    // GET + text/event-stream：建立 SSE 流（无状态 Worker 下保持连接并立即回一个空消息帧）
    if (request.method === 'GET' && accept.includes('text/event-stream')) {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('event: endpoint\ndata: {"jsonrpc":"2.0"}\n\n'));
          // 保持连接 60 秒后关闭（客户端主要走 POST）
          setTimeout(() => controller.close(), 60000);
        },
      });
      return new Response(stream, { headers: { ...CORS_HEADERS, 'Content-Type': 'text/event-stream' } });
    }

    // GET 非 SSE（路径含 /mcp）：返回服务信息
    if (request.method === 'GET') {
      return new Response(JSON.stringify({ server: 'jinhailie-mcp', protocol: 'streamable-http', tools: TOOLS.map(t => t.name) }),
        { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405, headers: CORS_HEADERS });
    }

    const sessionId = request.headers.get('mcp-session-id') || '';
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return new Response(JSON.stringify(jsonRpcError(null, -32700, '无法解析 JSON 请求体')),
        { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
    }

    const result = handleMessage(body, sessionId);
    const useSse = accept.includes('text/event-stream') && result.json;

    const headers = { ...CORS_HEADERS };
    if (result.sessionId) headers['Mcp-Session-Id'] = result.sessionId;
    if (result.status === 202) {
      return new Response(null, { status: 202, headers });
    }
    headers['Content-Type'] = useSse ? 'text/event-stream' : 'application/json';
    return new Response(useSse ? sseEnvelope(result.json) : JSON.stringify(result.json), { status: result.status, headers });
  },
};
