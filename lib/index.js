import { homedir } from 'node:os';
import { join } from 'node:path';
import { watch } from 'node:fs';
import { PersonaStore, API_PATH, SECTION_NAME, validSessionId, validPersonaId } from './personas.js';
import { StickerLibrary, StickerBridge, registerStickerApi } from './stickers.js';
import { SocialStore, SocialController, SOCIAL_API, socialPrompt } from './social.js';

export const name = 'task-personas';
export const inject = ['systemPrompt', 'webServer', 'connection', 'agents'];

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': String(Buffer.byteLength(body)),
  });
  res.end(body);
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 4096) throw Object.assign(new Error('请求过大'), { status: 413 });
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('JSON 格式不正确'), { status: 400 }); }
}

/** Kept separate from the plugin entry so real HTTP and prompt assembly can be tested. */
export function registerPersonas(ctx, store, media) {
  ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: 10300,
    interpolate: false,
    text: ({ agent }) => store.promptFor(agent?.id),
  });
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: API_PATH,
    async handler(req, res) {
      try {
        let rejection;
        try { rejection = ctx.connection.requestRejection(req); }
        catch { rejection = 403; }
        if (rejection !== undefined) {
          send(res, rejection === 401 ? 401 : 403, { ok: false, error: '请通过已登录的 DSH 界面操作。' });
          return;
        }
        if (req.method !== 'GET' && req.method !== 'PUT') {
          res.setHeader('Allow', 'GET, PUT');
          send(res, 405, { ok: false, error: '不支持的请求方式' });
          return;
        }
        if (req.method === 'GET') {
          const url = new URL(req.url, 'http://localhost');
          const sessionId = url.searchParams.get('sessionId');
          if (!validSessionId(sessionId)) { send(res, 400, { ok: false, error: '会话 ID 无效' }); return; }
          send(res, store.error ? 503 : 200, { ...store.snapshot(sessionId), feishu: !!media?.library.binding(sessionId), social: media?.social?.snapshot(sessionId) });
          return;
        }
        if (req.headers['x-dsh-task-personas-client'] !== '1' || !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
          send(res, 403, { ok: false, error: '请从 DSH 人格选择器保存。' });
          return;
        }
        const body = await readBody(req);
        if (!body || typeof body !== 'object' || Array.isArray(body) ||
            Object.keys(body).some(key => key !== 'sessionId' && key !== 'personaId') ||
            !validSessionId(body.sessionId) || !validPersonaId(body.personaId)) {
          send(res, 400, { ok: false, error: '会话或人格选择无效' });
          return;
        }
        try {
          const previous = store.selection(body.sessionId);
          const saved = store.set(body.sessionId, body.personaId);
          if (previous !== body.personaId) media?.social?.selectionChanged(body.sessionId);
          if (media) {
            try { await media.refreshAgent(ctx.agents.get(body.sessionId)); }
            catch (error) { ctx.logger?.(name)?.warn?.(`表情工具绑定失败：${error.message}`); }
          }
          // Providers are dynamic; notify diagnostics and subsequent assemblies of the change.
          ctx.emit('system-prompt/change');
          send(res, 200, { ...saved, feishu: !!media?.library.binding(body.sessionId), social: media?.social?.snapshot(body.sessionId) });
        } catch (error) {
          ctx.logger?.(name)?.warn?.(`人格选择保存失败：${error.message}`);
          send(res, 503, { ok: false, error: '人格选择保存失败，原选择已保留。请检查本地状态目录后重试。' });
        }
      } catch (error) {
        send(res, error.status ?? 500, { ok: false, error: error.status ? error.message : '人格服务暂时不可用，请重试。' });
      }
    },
  }));
}

export function registerSocial(ctx, social) {
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: SOCIAL_API, async handler(req, res) {
    let rejection; try { rejection = ctx.connection.requestRejection(req); } catch { rejection = 403; }
    if (rejection !== undefined) { send(res, rejection === 401 ? 401 : 403, { ok: false, error: '请通过已登录的 DSH 界面操作。' }); return; }
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (![SOCIAL_API, `${SOCIAL_API}/read-group`, `${SOCIAL_API}/bots`].includes(path)) { send(res, 404, { ok: false }); return; }
      if (path === `${SOCIAL_API}/read-group` || path === `${SOCIAL_API}/bots`) {
        if (req.method !== 'POST' || req.headers['x-dsh-task-personas-client'] !== '1' || !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) { send(res, 403, { ok: false, error: '请从人格菜单补读当前群消息。' }); return; }
        const body = await readBody(req);
        if (!body || Array.isArray(body) || Object.keys(body).some(k => k !== 'sessionId') || !validSessionId(body.sessionId)) { send(res, 400, { ok: false, error: '群会话无效' }); return; }
        try { const read = await social.groups.readHistory(body.sessionId, path.endsWith('/bots')); send(res, 200, { ...social.snapshot(body.sessionId), read }); }
        catch (e) { send(res, e.status || 503, { ok: false, error: e.status ? e.message : '群历史暂时读取失败，请稍后重试。' }); }
        return;
      }
      if (req.method === 'GET') {
        const id = new URL(req.url, 'http://localhost').searchParams.get('sessionId');
        if (!validSessionId(id)) { send(res, 400, { ok: false, error: '会话 ID 无效' }); return; }
        send(res, social.store.error ? 503 : 200, social.snapshot(id)); return;
      }
      if (req.method !== 'PUT') { res.setHeader('Allow', 'GET, PUT'); send(res, 405, { ok: false, error: '不支持的请求方式' }); return; }
      if (req.headers['x-dsh-task-personas-client'] !== '1' || !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) { send(res, 403, { ok: false, error: '请从人格菜单设置聊天习惯。' }); return; }
      const body = await readBody(req);
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !['sessionId','proactiveEnabled','groupParticipationEnabled','allowedBotIds'].includes(k)) || !validSessionId(body.sessionId) ||
        (body.proactiveEnabled === undefined && body.groupParticipationEnabled === undefined && body.allowedBotIds === undefined) ||
        (body.proactiveEnabled !== undefined && typeof body.proactiveEnabled !== 'boolean') || (body.groupParticipationEnabled !== undefined && typeof body.groupParticipationEnabled !== 'boolean') ||
        ((body.groupParticipationEnabled !== undefined || body.allowedBotIds !== undefined) && !social.groups.available(body.sessionId))) { send(res, 400, { ok: false, error: '聊天习惯设置无效' }); return; }
      if (!social.enabled(body.sessionId)) { send(res, 400, { ok: false, error: '请先在当前飞书会话选择人格' }); return; }
      send(res, 200, social.configure(body.sessionId, body.proactiveEnabled, body.groupParticipationEnabled, body.allowedBotIds));
    } catch (e) { send(res, e.status || 503, { ok: false, error: e.status === 400 ? e.message : '聊天习惯保存失败，原设置已保留；请稍后重试。' }); }
  } }));
}

export function apply(ctx) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  const store = new PersonaStore(join(home, 'task-personas', 'sessions.json'));
  if (store.error) ctx.logger?.(name)?.warn?.(store.error.message);
  const media = new StickerBridge(ctx, store, new StickerLibrary(home));
  const social = new SocialController(ctx, store, media, new SocialStore(join(home, 'task-personas', 'social.json')));
  media.social = social;
  ctx.provide('taskPersonaMedia', media);
  ctx.effect(() => () => { social.dispose(); return media.dispose(); });
  ctx.effect(() => social.start());
  ctx.on('agent/created', async ({ agent }) => { await media.refreshAgent(agent); });
  ctx.on('agent/disposed', ({ agent }) => {
    const scope = media.agentScopes.get(agent.id);
    media.agentScopes.delete(agent.id);
    void scope?.dispose();
  });
  ctx.systemPrompt.section({ name: 'task-personas:sticker-guidance', order: 10301, interpolate: false,
    text: ({ agent }) => store.selection(agent?.id) && media.library.binding(agent.id)
      ? media.stickerPrompt(agent.id) : '',
  });
  ctx.systemPrompt.section({ name: 'task-personas:social-protocol', order: 10302, interpolate: false,
    text: ({ agent }) => social.enabled(agent?.id) ? socialPrompt() : '',
  });
  registerSocial(ctx, social);
  for (const agent of ctx.agents.list()) void media.refreshAgent(agent).catch(error => ctx.logger(name).warn(`表情工具绑定失败：${error.message}`));
  // Attach/detach and reset can change the bridge mapping without recreating an existing Agent.
  ctx.effect(() => {
    let timer;
    let watcher;
    try {
      watcher = watch(join(home, 'dsh-im-connect'), { persistent: false }, (_event, file) => {
        if (file && String(file) !== 'sessions.json') return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          for (const agent of ctx.agents.list()) void media.refreshAgent(agent).catch(error => ctx.logger(name).warn(`表情工具绑定失败：${error.message}`));
        }, 30);
      });
      watcher.on('error', () => {});
    } catch {}
    return () => { clearTimeout(timer); watcher?.close(); };
  });
  registerPersonas(ctx, store, media);
  registerStickerApi(ctx, media);
}

export default { name, inject, apply };
