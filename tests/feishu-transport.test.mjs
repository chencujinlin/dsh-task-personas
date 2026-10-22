import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createFeishuChannel, resolveFeishuContent } from '../im-connect/lib/channels/feishu.js';
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
function fakeSdk() {
  const state = { sends: [], uploads: [], events: {}, closed: false };
  class Client {
    im = {
      image: { create: async args => { state.uploads.push(args); return { image_key: 'uploaded-image' }; } },
      message: { create: async args => { state.sends.push(args); return { code: 0, data: { message_id: 'created-message' } }; }, patch: async () => ({ code: 0 }) },
      messageResource: { get: async () => ({ getReadableStream: () => Readable.from([GIF]), headers: { 'content-type': 'image/gif' } }) },
    };
    async request() { return { bot: { open_id: 'bot-id' } }; }
  }
  class EventDispatcher { register(events) { state.events = events; return this; } }
  class WSClient { async start() {} close() { state.closed = true; } }
  return { state, sdk: { Client, EventDispatcher, WSClient, defaultHttpInstance: { request() {} }, LoggerLevel: { error: 1 } } };
}
function create(id = 'feishu') {
  const { state, sdk } = fakeSdk();
  let transport, removed = false;
  const captures = [];
  const bridge = { registerTransport(accountId, value) { assert.equal(accountId, 'feishu_account'); transport = value; return () => { removed = true; }; }, captureIncoming(value) { captures.push(value); } };
  const host = { get() { return bridge; }, inject(deps, cb) { assert.deepEqual(deps, ['taskPersonaMedia']); let cleanup; cb({ get() { return bridge; }, effect(fn) { cleanup = fn(); } }); return { async dispose() { cleanup?.(); } }; } };
  const channel = createFeishuChannel(id, { appId: 'fake', appSecret: 'fake', accountId: 'feishu_account', host }, () => {}, async () => sdk);
  return { channel, state, get transport() { return transport; }, get removed() { return removed; }, captures };
}
test('all Feishu ordinary replies use native text while choices remain interactive cards; Lark remains unchanged', async () => {
  const f = create(); await f.channel.start();
  try {
    await f.channel.send('chat-a', '你好呀 😄');
    assert.equal(f.state.sends[0].data.msg_type, 'text');
    assert.deepEqual(JSON.parse(f.state.sends[0].data.content), { text: '你好呀 😄' });
    await f.channel.sendChoices({ chatId: 'chat-a', kind: 'dm' }, '允许执行？', [{ label: '允许', token: 'local-choice' }]);
    assert.equal(f.state.sends[1].data.msg_type, 'interactive');
    assert.match(f.state.sends[1].data.content, /local-choice/);
  } finally { await f.channel.stop(); }
  const lark = create('lark'); await lark.channel.start();
  try { await lark.channel.send('chat-b', 'Lark'); assert.equal(lark.state.sends[0].data.msg_type, 'interactive'); assert.equal(lark.transport, undefined); }
  finally { await lark.channel.stop(); }
});
test('the connected transport uploads exact GIF bytes then sends a native image; received native stickers resend using their key', async () => {
  const f = create(); await f.channel.start();
  try {
    let checks = 0;
    await f.transport.sendImage('chat-a', { data: GIF }, new AbortController().signal, () => { checks++; });
    assert.deepEqual(f.state.uploads[0].data.image, GIF);
    assert.equal(f.state.uploads[0].data.image_type, 'message'); assert.equal(checks, 2);
    assert.equal(f.state.sends[0].data.msg_type, 'image');
    assert.deepEqual(JSON.parse(f.state.sends[0].data.content), { image_key: 'uploaded-image' });
    await f.transport.sendSticker('chat-a', 'received-key', new AbortController().signal, () => {});
    assert.equal(f.state.sends[1].data.msg_type, 'sticker');
    assert.deepEqual(JSON.parse(f.state.sends[1].data.content), { file_key: 'received-key' });
    await assert.rejects(f.transport.sendImage('chat-a', { data: GIF }, AbortSignal.abort(), () => {}), /abort/i);
    assert.equal(f.state.uploads.length, 1);
  } finally { await f.channel.stop(); }
  assert.equal(f.removed, true);
});
test('persona text tool uses the connected native transport and rechecks cancellation/recipient state', async () => {
  const f = create(); await f.channel.start();
  try {
    let checks = 0; await f.transport.sendText('chat-a', '自然聊天', new AbortController().signal, () => { checks++; });
    assert.equal(checks, 1); assert.equal(f.state.sends[0].data.msg_type, 'text'); assert.equal(f.state.sends[0].data.receive_id, 'chat-a');
    assert.deepEqual(JSON.parse(f.state.sends[0].data.content), { text: '自然聊天' });
    await assert.rejects(f.transport.sendText('chat-a', '不要发', AbortSignal.abort(), () => {}), /abort/i); assert.equal(f.state.sends.length, 1);
  } finally { await f.channel.stop(); }
});
test('incoming images and native stickers reach the collection service, with group @ filtering preserved', async () => {
  const f = create(); const received = []; f.channel.setMessageHandler(message => { received.push(message); }); await f.channel.start();
  try {
    await f.state.events['im.message.receive_v1']({ sender: { sender_id: { open_id: 'user' } }, message: {
      chat_id: 'chat-a', chat_type: 'p2p', message_id: 'incoming-image', message_type: 'image', content: JSON.stringify({ image_key: 'received-image' }),
    } });
    assert.deepEqual(received[0].media[0].data, GIF);
    assert.deepEqual(f.captures[0].media[0].data, GIF);
    await f.state.events['im.message.receive_v1']({ message: { chat_id: 'chat-a', chat_type: 'p2p', message_id: 'incoming-sticker', message_type: 'sticker', content: JSON.stringify({ file_key: 'native-incoming' }) } });
    assert.equal(f.captures[1].stickerKey, 'native-incoming');
    await f.state.events['im.message.receive_v1']({ message: { chat_id: 'group', chat_type: 'group', message_type: 'sticker', content: JSON.stringify({ file_key: 'ignored' }) } });
    assert.equal(f.captures.length, 2);
    assert.equal(f.state.sends.length, 0, 'no real or mock automatic reply is emitted by the collection hook');
  } finally { await f.channel.stop(); }
});
test('native sticker receipt does not try to download a key through the image endpoint', async () => {
  const resolved = await resolveFeishuContent({ im: { messageResource: { get() { throw Error('must not download'); } } } }, { message_type: 'sticker', content: JSON.stringify({ file_key: 'native' }) });
  assert.deepEqual(resolved, { text: '[飞书表情包]', media: [] });
});
