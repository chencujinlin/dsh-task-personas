import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { PersonaStore, PERSONAS, SECTION_NAME, API_PATH } from '../lib/personas.js';
import { registerPersonas } from '../lib/index.js';

function fixture(t, options) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-personas-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'sessions.json');
  return { file, store: new PersonaStore(file, options) };
}

test('archived role cards retain the exact upstream bytes', () => {
  const source = JSON.parse(readFileSync(new URL('../roles/source.json', import.meta.url)));
  assert.equal(source.commit, 'a56164e70a0521a7829138a42eee76066fde2b8b');
  for (const role of PERSONAS) {
    const bytes = readFileSync(new URL(`../roles/upstream/${role.file}`, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), source.sha256[role.file]);
  }
});

test('independent sessions, restart, new/reset session, and explicit disable', t => {
  const { file, store } = fixture(t);
  assert.equal(store.promptFor('normal-task'), '');
  assert.equal(store.promptFor(undefined), '');
  store.set('im:feishu:first', 'whale');
  store.set('im:feishu:second', 'tsundere');
  const restored = new PersonaStore(file);
  assert.equal(restored.selection('im:feishu:first'), 'whale');
  assert.equal(restored.selection('im:feishu:second'), 'tsundere');
  assert.equal(restored.promptFor('im:feishu:first:reset'), '');
  assert.equal(restored.promptFor('child-agent'), '');
  for (const [id, role] of [['im:feishu:first', PERSONAS[0]], ['im:feishu:second', PERSONAS[1]]]) {
    const original = readFileSync(new URL(`../roles/${role.file}`, import.meta.url), 'utf8');
    assert.ok(restored.promptFor(id).includes(original), 'the complete role card is present, not truncated');
  }
  restored.set('im:feishu:first', null);
  assert.match(restored.promptFor('im:feishu:first'), /人格选择：已关闭/);
  assert.ok(!restored.promptFor('im:feishu:first').includes('飞书人格卡开始'));
  assert.equal(restored.selection('im:feishu:second'), 'tsundere');
  assert.equal(restored.promptFor('normal-task'), '');
});

test('a failed atomic write leaves both disk and active choice unchanged', t => {
  const { file, store } = fixture(t);
  store.set('task', 'whale');
  const before = readFileSync(file, 'utf8');
  const broken = new PersonaStore(file, { writer() { throw new Error('disk is full'); } });
  assert.throws(() => broken.set('task', 'tsundere'), /disk is full/);
  assert.equal(broken.selection('task'), 'whale');
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('corrupt state is preserved and cannot be silently replaced', t => {
  const { file } = fixture(t);
  writeFileSync(file, 'broken original state');
  const store = new PersonaStore(file);
  assert.ok(store.error);
  assert.equal(store.promptFor('task'), '');
  assert.throws(() => store.set('task', 'whale'), /已保留原文件/);
  assert.equal(readFileSync(file, 'utf8'), 'broken original state');
});

test('actual DSH 0.2.1 prompt registry preserves host instructions and tools across selections', async t => {
  const require = createRequire(import.meta.url);
  const paths = process.env.DSH_SDK_ROOT ? [process.env.DSH_SDK_ROOT] : [new URL('../', import.meta.url).pathname];
  const load = name => import(pathToFileURL(require.resolve(name, { paths })).href);
  const { Context } = await load('@deepseek-ai/cordis');
  const { default: SystemPrompt, renderPrompt } = await load('@deepseek-ai/dsh-system-prompt');
  const { store } = fixture(t);
  const ctx = new Context();
  await ctx.plugin(SystemPrompt, { personaPrefix: 'HOST DEFAULT PERSONA', personaSuffix: 'HOST SUFFIX' });
  ctx.systemPrompt.section({ name: 'test:policy', order: 600, text: 'HOST PERMISSIONS AND TASK POLICY' });
  ctx.systemPrompt.tools(() => ({ schemas: [{ name: 'original_tool', description: 'unchanged', parameters: { type: 'object' } }] }));
  ctx.webServer = { register() { return () => {}; } };
  ctx.connection = { requestRejection() {} };
  const plugin = await ctx.plugin({ name: 'test-personas', inject: ['systemPrompt'], apply(c) { registerPersonas(c, store); } });
  t.after(async () => { await plugin.dispose(); await ctx.fiber.dispose(); });
  async function assembly(id) { return ctx.systemPrompt.assemble({ agent: { id } }); }
  const initial = await assembly('normal-task');
  const initialText = renderPrompt(initial);
  assert.ok(initialText.includes('HOST DEFAULT PERSONA'));
  assert.ok(!initialText.includes('角色卡'));
  store.set('feishu-task', 'whale');
  const whale = await assembly('feishu-task');
  const whaleText = renderPrompt(whale);
  assert.ok(whaleText.includes(store.cards.get('whale').text));
  assert.ok(whaleText.includes('HOST PERMISSIONS AND TASK POLICY'));
  assert.ok(whaleText.includes('HOST SUFFIX'));
  assert.deepEqual(whale.tools, initial.tools);
  assert.equal(renderPrompt(await assembly('normal-task')), initialText);
  assert.equal(renderPrompt(await assembly('child-agent')), initialText);
  store.set('feishu-task', 'tsundere');
  assert.ok(renderPrompt(await assembly('feishu-task')).includes(store.cards.get('tsundere').text));
  assert.ok(!renderPrompt(await assembly('feishu-task')).includes(store.cards.get('whale').text));
  store.set('feishu-task', null);
  assert.match(renderPrompt(await assembly('feishu-task')), /恢复宿主默认身份/);
  await plugin.dispose();
  assert.equal(renderPrompt(await assembly('feishu-task')), initialText);
});

test('real HTTP route rejects unauthenticated/CSRF/invalid writes and reports save failures', async t => {
  const { store } = fixture(t);
  let route;
  const sections = [];
  const ctx = {
    systemPrompt: { section(value) { sections.push(value); } },
    webServer: { register(value) { route = value; return () => {}; } },
    connection: { requestRejection(req) { return req.headers.cookie === 'test-session' ? undefined : 401; } },
    effect(fn) { fn(); }, emit() {}, logger() { return { warn() {} }; },
  };
  registerPersonas(ctx, store);
  assert.equal(sections[0].name, SECTION_NAME);
  const server = createServer((req, res) => route.handler(req, res));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}${API_PATH}`;
  const headers = { cookie: 'test-session', 'content-type': 'application/json', 'x-dsh-task-personas-client': '1' };
  assert.equal((await fetch(`${url}?sessionId=task`)).status, 401);
  assert.equal((await fetch(url, { method: 'PUT', headers: { cookie: 'test-session' }, body: '{}' })).status, 403);
  for (const body of [null, [], {}, { sessionId: 'task', personaId: '../../bad' }, { sessionId: 'task', personaId: 'whale', text: 'custom' }]) {
    assert.equal((await fetch(url, { method: 'PUT', headers, body: JSON.stringify(body) })).status, 400);
  }
  const saved = await fetch(url, { method: 'PUT', headers, body: JSON.stringify({ sessionId: 'task', personaId: 'whale' }) });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).personaId, 'whale');
  const read = await fetch(`${url}?sessionId=task`, { headers });
  assert.equal((await read.json()).personaId, 'whale');
  store.writer = () => { throw new Error('test write failure'); };
  const failed = await fetch(url, { method: 'PUT', headers, body: JSON.stringify({ sessionId: 'task', personaId: 'tsundere' }) });
  assert.equal(failed.status, 503);
  assert.equal(store.selection('task'), 'whale');
});

// User-requested adaptation must be active; the original cards remain archived above.
test('active cards use Feishu context and do not instruct QQ protocols or background waiting', t => {
  const { store } = fixture(t);
  for (const role of PERSONAS) {
    const card = store.cards.get(role.id).text;
    assert.match(card, /飞书/);
    assert.match(card, /私聊/);
    assert.match(card, /说完.*结束本轮/);
    assert.ok(!card.includes('mcp__web-search-safe__web_search'));
    assert.ok(!card.includes('qq-chat-v2'));
    store.set(role.id, role.id);
    assert.ok(store.promptFor(role.id).includes(card));
  }
});
