import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { registerSocial } from '../lib/index.js';
import { SocialStore, SocialController, CHAT_PROTOCOL, socialPrompt } from '../lib/social.js';
import { PersonaStore } from '../lib/personas.js';
import { StickerLibrary, StickerBridge } from '../lib/stickers.js';
import { ImEngine } from '../im-connect/lib/engine/gateway.js';
import { recoverTurn } from '../im-connect/lib/engine/deferred-delivery.js';
import { personaProtocolFromSession } from '../im-connect/lib/engine/persona-chat.js';
import { SessionRouter } from '../im-connect/lib/engine/router.js';

const MINUTE = 60_000;
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
function fixture(t, { random = () => 0.2, wake } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-social-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  let time = new Date(2026, 9, 21, 12).getTime();
  let bindings = { first: { sessionId: 'first', channel: 'feishu_test', chatId: 'chat-a', kind: 'dm' }, second: { sessionId: 'second', channel: 'feishu_test', chatId: 'chat-b', kind: 'group' } };
  const ctx = { agents: { get() {} }, logger() { return { warn() {} }; } };
  const personas = new PersonaStore(join(dir, 'personas.json')); personas.set('first', 'whale'); personas.set('second', 'tsundere');
  const library = new StickerLibrary(dir, { readBindings: () => bindings });
  const media = new StickerBridge(ctx, personas, library);
  const store = new SocialStore(join(dir, 'social.json'));
  const queued = [];
  const social = new SocialController(ctx, personas, media, store, { now: () => time, random,
    wake: wake || (async (id, message, current) => { if (!current()) return false; queued.push({ id, message }); return true; }) });
  media.social = social;
  t.after(() => { social.dispose(); });
  return { dir, ctx, personas, library, media, store, social, queued, now: () => time, advance(ms) { time += ms; }, setTime(v) { time = v; }, setBindings(v) { bindings = v; } };
}
function start(f, id = 'first', automatic = false, text = '你好') {
  f.media.observeSessionEvent({ id }, { type: 'turn/start', data: { turn: 1 } });
  f.media.observeSessionEvent({ id }, { type: 'user/message', data: { source: { kind: automatic ? 'task-persona-wake' : 'user' }, content: [{ type: 'text', text }] } });
}
function due(f, patch = {}, id = 'first') {
  f.store.put(id, { ...f.social.ensure(id), lastIncomingAt: f.now() - 16 * MINUTE, nextCheckAt: f.now() - 1, ...patch });
}

test('scheduler wakes only the enabled bound session, persists timing, and does not inherit across reset', async t => {
  const f = fixture(t); due(f); f.personas.set('second', null);
  await f.social.tick(); assert.equal(f.queued.length, 1); assert.equal(f.queued[0].id, 'first');
  assert.equal(f.queued[0].message.source.kind, 'task-persona-wake'); assert.notEqual(f.queued[0].message.source.kind, 'user');
  const restored = new SocialStore(f.store.file); assert.equal(restored.get('first').wakes.length, 1); assert.ok(restored.get('first').nextCheckAt > f.now());
  f.social.pending.clear(); await f.social.tick(); assert.equal(f.queued.length, 1, 'no overdue catch-up spam');
  f.setBindings({ first: { sessionId: 'reset', channel: 'feishu_test', chatId: 'chat-a', kind: 'dm' } });
  due(f); await f.social.tick(); assert.equal(f.queued.length, 1); assert.equal(f.social.enabled('reset'), false);
});

test('recent incoming, recent reply, night hours, farewell and the per-session off switch reduce or stop wakes', async t => {
  const f = fixture(t); f.personas.set('second', null);
  due(f, { lastIncomingAt: f.now() }); await f.social.tick(); assert.equal(f.queued.length, 0);
  due(f, { lastAiReplyAt: f.now() - MINUTE }); await f.social.tick(); assert.equal(f.queued.length, 0, '0.2 is above recent-reply probability 0.15');
  f.setTime(new Date(2026, 9, 21, 23).getTime()); due(f, { lastAiReplyAt: 0 }); await f.social.tick(); assert.equal(f.queued.length, 0, 'night probability is 0.09');
  f.setTime(new Date(2026, 9, 22, 12).getTime()); start(f, 'first', false, '晚安'); due(f); await f.social.tick(); assert.equal(f.queued.length, 0);
  start(f); f.social.configure('first', false); due(f); await f.social.tick(); assert.equal(f.queued.length, 0);
  f.social.configure('first', true); due(f); await f.social.tick(); assert.equal(f.queued.length, 1);
});

test('one follow-up observation does not create a self-sustaining conversation loop', async t => {
  const f = fixture(t); f.personas.set('second', null); start(f); f.social.sent('first');
  assert.equal(f.store.get('first').followupAt, f.now() + 30_000);
  f.advance(31_000); await f.social.tick(); assert.equal(f.queued.length, 1);
  start(f, 'first', true); f.social.sent('first'); assert.equal(f.store.get('first').followupAt, 0);
  assert.deepEqual(f.social.skip('first'), { skipped: true });
  start(f); assert.throws(() => f.social.skip('first'), /用户发起/);
});

test('no wake is delivered after unbind/disable during async resume, or when host is busy', async t => {
  let release; const f = fixture(t, { wake: async (_id, _m, current) => { await new Promise(r => { release = r; }); return current(); } });
  const pending = f.social.wake('first', 'proactive'); await Promise.resolve();
  f.personas.set('first', null); release(); assert.equal(await pending, false);
  assert.equal(f.social.pending.size, 0);
  f.personas.set('first', 'whale'); f.advance(MINUTE + 1);
  f.social.registerRuntime({ wake: async () => false }); assert.equal(await f.social.wake('first', 'proactive'), false);
});

test('topic memory stays local, expires, and failed atomic saves keep the old selection', t => {
  const f = fixture(t); f.social.remember('first', '下次接着聊午饭', 5);
  assert.equal(f.store.get('second'), undefined); assert.equal(f.store.get('first').thoughtExpiresAt, f.now() + 5 * MINUTE);
  const before = readFileSync(f.store.file, 'utf8'); f.store.writer = () => { throw Error('disk full'); };
  assert.throws(() => f.social.configure('first', false), /disk full/);
  assert.equal(f.store.get('first').proactiveEnabled, true); assert.equal(readFileSync(f.store.file, 'utf8'), before);
  assert.doesNotThrow(() => f.social.sent('first'), 'confirmed platform delivery is never reclassified due to local metadata failure');
});

test('corrupt social state pauses scheduling and never replaces the damaged file', async t => {
  const f = fixture(t); writeFileSync(f.store.file, 'broken original');
  const broken = new SocialStore(f.store.file); assert.ok(broken.error);
  const social = new SocialController(f.ctx, f.personas, f.media, broken, { wake: async () => { throw Error('must not wake'); } });
  await social.tick(); assert.equal(readFileSync(f.store.file, 'utf8'), 'broken original'); social.dispose();
});

test('sticker summaries include usable IDs, are capped at eight, and cannot expose another session’s material', t => {
  const f = fixture(t);
  for (let i = 0; i < 10; i++) f.library.addImage(Buffer.concat([GIF, Buffer.from([i])]), { name: '素材' + i, description: '接梗' });
  f.library.addImage(Buffer.concat([GIF, Buffer.from('private')]), { name: '别的会话专用', description: 'private', source: { accountId: 'feishu_test', chatId: 'chat-b' } });
  const prompt = f.media.stickerPrompt('first'); assert.match(prompt, /不要等用户明确要图/); assert.match(prompt, /无需每轮先列库/);
  assert.equal((prompt.match(/"id":/g) || []).length, 8); assert.ok(!prompt.includes('别的会话专用'));
  assert.match(socialPrompt(), new RegExp(CHAT_PROTOCOL)); assert.match(socialPrompt(), /普通文字输出仅供内部叙述/);
});

test('native text tool targets only the bound chat, rechecks switches, and preserves uncertain-send limits', async t => {
  const f = fixture(t); start(f); const sent = [];
  f.media.registerTransport('feishu_test', { async sendText(chat, text, signal, check) { check(); sent.push({ chat, text }); return { messageId: 'm1' }; } });
  const result = await f.media.sendText('first', ['自然的一句话'], new AbortController().signal);
  assert.equal(result.sent, true); assert.deepEqual(sent, [{ chat: 'chat-a', text: '自然的一句话' }]);
  assert.equal(f.social.disposition('first', 1).sent, 1);
  f.personas.set('first', null); await assert.rejects(f.media.sendText('first', ['不能发'], new AbortController().signal), /尚未连接/);
  f.personas.set('first', 'whale'); f.media.registerTransport('feishu_test', { async sendText() { throw Error('network timeout with private headers'); } });
  await assert.rejects(f.media.sendText('first', ['失败'], new AbortController().signal), /不要重发/);
  assert.equal(f.social.disposition('first', 1).failed, true); assert.equal(sent.length, 1);
});

test('proactive text/sticker bounds apply across separate model tool calls', async t => {
  const f = fixture(t); start(f, 'first', true);
  f.media.registerTransport('feishu_test', { async sendText() { return { messageId: 'm' }; }, async sendImage(_chat, _file, _signal, check) { check(); return { messageId: 'image' }; } });
  await f.media.sendText('first', ['第一句'], new AbortController().signal);
  await f.media.sendText('first', ['第二句'], new AbortController().signal);
  await assert.rejects(f.media.sendText('first', ['第三句'], new AbortController().signal), /最多两条/);
  const item = f.library.addImage(GIF, { name: '收到' }); await f.media.send('first', item.id, new AbortController().signal);
  await assert.rejects(f.media.send('first', item.id, new AbortController().signal), /已选过表情/);
});
test('removing a sticker during an in-flight send never recreates a corrupt library record', async t => {
  const f = fixture(t); const item = f.library.addImage(GIF); start(f);
  f.media.registerTransport('feishu_test', { async sendImage() { f.library.remove('first', item.id); return { messageId: 'already-accepted' }; } });
  assert.equal((await f.media.send('first', item.id, new AbortController().signal)).sent, true);
  assert.equal(f.library.items[item.id], undefined); assert.equal(new StickerLibrary(f.dir).error, null);
});

test('bridge suppresses persona drafts, prevents duplicate tool-sent text, and preserves ordinary task replies', async t => {
  const f = fixture(t); const sent = [];
  const record = { sessionId: 'first', channel: 'feishu_test', kind: 'dm', chatId: 'chat-a', title: 'test' };
  const map = { list: () => [record], findSession: id => id === 'first' ? record : undefined, get: () => record };
  const ctx = { on: () => () => {}, get: name => name === 'taskPersonaMedia' ? f.media : undefined, agents: { get: () => undefined } };
  const engine = new ImEngine(ctx, map, { has: () => false, add() {} }, { mergeTimeoutSecs: 1 }, () => {});
  t.after(() => engine.dispose());
  engine.channels.set('feishu_test', { id: 'feishu_test', maxMessageLength: 4000, skipInterimText: true, send: async (_id, text) => { sent.push(text); } });
  const session = { id: 'first', events: [] };
  await engine.onSessionEvent(session, { type: 'turn/start', data: { turn: 1 } });
  await engine.onSessionEvent(session, { type: 'system/message', data: { message: { content: [{ type: 'text', text: CHAT_PROTOCOL }] } } });
  await engine.onSessionEvent(session, { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'Persona: draft which must stay private' }, { type: 'tool-call' }] } } });
  assert.equal(sent.length, 0);
  f.social.sent('first');
  await engine.onSessionEvent(session, { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'duplicate or internal narration' }] } } });
  assert.equal(sent.length, 0);
  await engine.onSessionEvent(session, { type: 'system/message', data: { message: { content: [{ type: 'text', text: 'ordinary host prompt' }] } } });
  await engine.onSessionEvent(session, { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '正常任务回复' }] } } });
  assert.deepEqual(sent, ['正常任务回复']);
});

test('delivery recovery never republishes historical internal drafts from tool-only persona turns', () => {
  const events = [
    { type: 'turn/start', data: { turn: 4 } },
    { type: 'system/message', data: { message: { content: [{ type: 'text', text: CHAT_PROTOCOL }] } } },
    { type: 'user/message', data: { id: 'user-request' } },
    { type: 'assistant/message', data: { turn: 4, message: { content: [{ type: 'text', text: 'internal draft' }] } } },
    { type: 'turn/end', data: { turn: 4, reason: { kind: 'completed' } } },
  ];
  assert.deepEqual(recoverTurn(events, 'user-request'), { turn: 4, text: '', kind: 'persona-tools' });
  events[1].data.message.content[0].text = 'ordinary'; assert.equal(recoverTurn(events, 'user-request').text, 'internal draft');
});
test('restarted host reads the surviving prompt surface and ignores emptied historical tail nodes', () => {
  const events = [
    { type: 'system/message', data: { message: { content: [{ type: 'text', text: CHAT_PROTOCOL }] } } },
    { type: 'system/message', data: { message: { content: [] } } },
  ];
  const session = { surface: { nodes: [0, 1] }, eventAt: i => events[i] };
  assert.equal(personaProtocolFromSession(session), true);
  events[0].data.message.content[0].text = 'ordinary'; assert.equal(personaProtocolFromSession(session), false);
});
test('cold startup restores native session ownership without queuing model work', async t => {
  const f = fixture(t); f.personas.set('second', null); let prepared = 0; let woke = 0;
  f.social.registerRuntime({ prepare: async (_id, current) => { assert.equal(current(), true); prepared++; }, wake: async () => { woke++; return true; } });
  await f.social.tick(); assert.equal(prepared, 1); assert.equal(woke, 0);
  await f.social.tick(); assert.equal(prepared, 1, 'failed or pending warmup backs off');
});
test('background restore never falls through to new-session creation or changes an old mapping', async () => {
  const record = { sessionId: 'existing', channel: 'feishu_test', chatId: 'chat', kind: 'dm', title: 'existing' }; let created = 0;
  const store = { findSession: () => record, get: () => record, list: () => [record] };
  const ctx = { get() {}, agents: { get() {}, async resume() { throw Error('history unavailable'); }, async create() { created++; } } };
  const router = new SessionRouter(ctx, store, {}, () => {});
  assert.equal(await router.resumeExisting('existing'), undefined); assert.equal(created, 0); assert.equal(record.sessionId, 'existing');
});
test('background warmup preserves an explicit WorkBuddy selection instead of the account default', async () => {
  const record = { sessionId: 'existing', channel: 'feishu_test', chatId: 'chat', kind: 'dm', title: 'existing', titleSource: 'user' }; let resumed;
  const events = [{ type: 'model/selection', data: { provider: 'magpie', model: 'workbuddy/deepseek-v4.1-flash' } }];
  const store = { findSession: () => record, get: () => record, list: () => [record] };
  const ctx = { get: name => name === 'sessionController' ? { inspect: async () => ({ events }) } : undefined,
    agents: { get() {}, async resume(options) { resumed = options; return { agent: { session: { id: 'existing', events } }, async dispose() {} }; } } };
  const router = new SessionRouter(ctx, store, { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' }, () => {});
  assert.ok(await router.resumeExisting('existing'));
  assert.equal(resumed.agentOptions.provider, 'magpie'); assert.equal(resumed.agentOptions.model, 'workbuddy/deepseek-v4.1-flash');
  assert.equal(resumed.agentOptions.reasoningEffort, undefined, 'default effort must not inherit High from another route');
});

test('actual native tool registry admits social tools, scopes them per session and returns durable image refs', async t => {
  const f = fixture(t); const require = createRequire(import.meta.url);
  const load = name => import(pathToFileURL(require.resolve(name, { paths: process.env.DSH_SDK_ROOT ? [process.env.DSH_SDK_ROOT] : [new URL('../', import.meta.url).pathname] })).href);
  const { Context } = await load('@deepseek-ai/cordis'); const { default: Tools } = await load('@deepseek-ai/dsh-tools');
  const { createScope } = await load('@deepseek-ai/dsh-scope'); const { default: SystemPrompt } = await load('@deepseek-ai/dsh-system-prompt');
  const ctx = new Context(); await ctx.plugin(SystemPrompt); await ctx.plugin(Tools); t.after(async () => { await f.media.dispose(); await ctx.fiber.dispose(); });
  const first = { id: 'first' }, normal = { id: 'normal' }; for (const agent of [first, normal]) agent.ctx = createScope(ctx, agent).ctx;
  await f.media.refreshAgent(first); await f.media.refreshAgent(normal);
  assert.equal(ctx.tools.schemas(first).length, 7); assert.equal(ctx.tools.schemas(normal).length, 0);
  f.media.registerTransport('feishu_test', { async sendText(chat) { assert.equal(chat, 'chat-a'); return { messageId: 'wire-message' }; } });
  start(f);
  const send = await ctx.tools.execute({ callId: 'send', name: 'feishu_send_message', arguments: { messages: ['好耶'] }, agent: first, signal: new AbortController().signal });
  assert.equal(send.isError, false, JSON.stringify(send)); assert.equal(f.social.disposition('first', 1).sent, 1);
  const denied = await ctx.tools.execute({ callId: 'wrong', name: 'feishu_send_message', arguments: { messages: ['no'] }, agent: normal, signal: new AbortController().signal }); assert.equal(denied.isError, true);
  const item = f.library.addImage(GIF); const attachment = { id: 'image-id', mediaType: 'image/gif', width: 1, height: 1 };
  f.ctx.get = name => name === 'attachments' ? { saveImage: async input => { assert.deepEqual(input.data, GIF); return attachment; } } : undefined;
  const view = await ctx.tools.execute({ callId: 'view', name: 'feishu_get_sticker_image', arguments: { id: item.id }, agent: first, signal: new AbortController().signal });
  assert.equal(view.isError, false, JSON.stringify(view)); assert.deepEqual(view.content[0], { type: 'image', attachment });
  let workRan = false;
  ctx.tools.register({ name: 'danger_probe', description: 'isolated no-op work tool', parameters: { type: 'object', properties: {} }, output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: 'ok' }] }, async execute() { workRan = true; return {}; } });
  start(f, 'first', true);
  const blocked = await ctx.tools.execute({ callId: 'auto-work', name: 'danger_probe', arguments: {}, agent: first, signal: new AbortController().signal });
  assert.equal(blocked.isError, true); assert.equal(workRan, false);
  f.media.observeSessionEvent({ id: 'first' }, { type: 'user/message', data: { source: { kind: 'task-persona-group', revision: 0 }, content: [{ type: 'text', text: '群聊观察资料' }] } });
  const blockedGroup = await ctx.tools.execute({ callId: 'group-work', name: 'danger_probe', arguments: {}, agent: first, signal: new AbortController().signal });
  assert.equal(blockedGroup.isError, true); assert.equal(workRan, false, 'ambient group context cannot execute work tools');
  start(f);
  const allowed = await ctx.tools.execute({ callId: 'real-work', name: 'danger_probe', arguments: {}, agent: first, signal: new AbortController().signal });
  assert.equal(allowed.isError, false); assert.equal(workRan, true);
});

test('social HTTP route rejects anonymous/CSRF/extra fields and preserves settings after disk failure', async t => {
  const f = fixture(t); let route;
  registerSocial({ effect: fn => fn(), webServer: { register(r) { route = r; } }, connection: { requestRejection: req => req.headers.cookie === 'signed-in' ? undefined : 401 } }, f.social);
  const server = createServer((req, res) => route.handler(req, res)); server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/dsh-task-personas/social`;
  const headers = { cookie: 'signed-in', 'content-type': 'application/json', 'x-dsh-task-personas-client': '1' };
  const put = (body, h = headers) => fetch(url, { method: 'PUT', headers: h, body: JSON.stringify(body) });
  assert.equal((await put({ sessionId: 'first', proactiveEnabled: false }, { 'content-type': 'application/json' })).status, 401);
  assert.equal((await put({ sessionId: 'first', proactiveEnabled: false }, { cookie: 'signed-in', 'content-type': 'application/json' })).status, 403);
  assert.equal((await put({ sessionId: 'first', proactiveEnabled: false, recipient: 'someone-else' })).status, 400);
  assert.equal((await put({ sessionId: 'normal', proactiveEnabled: true })).status, 400);
  assert.equal((await put({ sessionId: 'first', proactiveEnabled: false })).status, 200);
  f.store.writer = () => { throw Error('disk full'); };
  assert.equal((await put({ sessionId: 'first', proactiveEnabled: true })).status, 503); assert.equal(f.store.get('first').proactiveEnabled, false);
});
