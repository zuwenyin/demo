/**
 * 仅供 demo 使用的最小 mock 服务（零依赖，Node 18+）：
 * 1. 静态托管 index.html / dist 下的编译产物，保证 ES Module Worker 能正常加载（file:// 协议不行）；
 * 2. 提供 GET /api/task/status —— 模拟一个异步任务，进度随机推进，偶尔返回 503，用于演示重试；
 * 3. 提供 GET /api/task/reset —— 把任务进度清零，方便反复演示。
 *
 * 启动：node server/mock-server.mjs
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const PORT = Number(process.env.PORT ?? 3000);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

/** 内存中的任务状态 */
let task = createTask();

function createTask() {
  return {
    taskId: `task-${Date.now().toString(36)}`,
    progress: 0,
    status: 'running',
    message: '任务执行中',
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': MIME['.json'],
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(body);
}

/** 静态文件：把 URL 映射到项目根目录，并做路径穿越防护 */
async function serveStatic(pathname, res) {
  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const filePath = normalize(join(ROOT, relative));

  if (!filePath.startsWith(ROOT + sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const content = await readFile(filePath);
    res.writeHead(200, {
      'content-type': MIME[extname(filePath)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(content);
  } catch {
    res.writeHead(404, { 'content-type': MIME['.html'] }).end(
      `<h1>404 Not Found</h1><p>${pathname}</p><p>如果是 <code>dist/main.js</code> 缺失，请先执行 <code>npm run build</code>。</p>`,
    );
  }
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  // ---- 模拟异步任务状态接口 ----
  if (pathname === '/api/task/status') {
    await sleep(80 + Math.random() * 220); // 模拟网络/服务端延迟

    if (task.status === 'running' && Math.random() < 0.15) {
      console.log(`[mock] 503 -> progress=${task.progress}`);
      return sendJson(res, 503, { error: '服务暂时不可用，请稍后重试' });
    }

    if (task.status === 'running') {
      task.progress = Math.min(100, task.progress + 8 + Math.round(Math.random() * 14));
      if (task.progress >= 100) {
        task.status = 'done';
        task.message = '任务已完成';
      }
    }

    console.log(`[mock] 200 -> ${task.status} ${task.progress}%`);
    return sendJson(res, 200, {
      taskId: task.taskId,
      progress: task.progress,
      status: task.status,
      message: task.message,
      serverTime: new Date().toISOString(),
    });
  }

  if (pathname === '/api/task/reset') {
    task = createTask();
    console.log('[mock] 任务已重置');
    return sendJson(res, 200, { ok: true, task });
  }

  // ---- 静态资源 ----
  await serveStatic(pathname, res);
});

server.listen(PORT, () => {
  console.log(`mock server: http://localhost:${PORT}`);
  console.log(`静态目录：${ROOT}`);
});
