import { channelNotice } from '../engine/command-locale.js';
import { choiceSendError, ChoiceSendError } from '../engine/choice-delivery.js';
import { afterPartialDelivery, DeliveryRejected } from '../engine/deferred-delivery.js';
import { diagnosticJson, platformResult, probe, requireDiagnostic } from './diagnostics.js';
import { fileOperation } from './file-send.js';
import { quietSdkLogger } from '../engine/quiet-logger.js';
import { KeyedSerialQueue } from '../engine/keyed-queue.js';
import { timeoutSignal } from '../engine/abort.js';
import { fileMedia, MAX_CHANNEL_IMAGES } from './channel-image-download.js';
import { markdownTableOffsets } from '../engine/split.js';
/** 飞书一张卡片最多 5 个 table 元素，超了整个写入会被拒（230099 / ErrCode 11310），旧卡片内容会卡住。 */
export const FEISHU_CARD_MAX_TABLES = 5;
/** 按表格数量拆正文，保证每张卡不超上限，且不会把表格切一半。 */
export function splitByTableLimit(text, maxTables = FEISHU_CARD_MAX_TABLES) {
    const value = text ?? '';
    const starts = markdownTableOffsets(value);
    if (starts.length <= maxTables)
        return value ? [value] : [];
    const parts = [];
    let from = 0;
    for (let index = maxTables; index < starts.length; index += maxTables) {
        parts.push(value.slice(from, starts[index]));
        from = starts[index];
    }
    parts.push(value.slice(from));
    return parts.filter((part) => part.trim() !== '');
}
/** 飞书限流：消息接口 230020 / 11232，通用频控 99991400（HTTP 429，旧接口为 400）。 */
const FEISHU_THROTTLE_CODES = new Set([230020, 11232, 99991400]);
function isThrottleCode(code) {
    return FEISHU_THROTTLE_CODES.has(Number(code));
}
/** SDK 在 HTTP 非 2xx 时抛 AxiosError：429，或响应体带限流码，说明请求被限流、未被受理。 */
function throttledResponse(error) {
    const response = error?.response;
    return response?.status === 429 || isThrottleCode(response?.data?.code);
}
// 沿用 SDK 允许缺省业务码的响应，同时兼容数字和字符串零码。
function isRejectedCode(code) {
    return code !== undefined && code !== 0 && code !== '0';
}
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
// Shared across all images in one message, not renewed for each resource.
const MAX_MESSAGE_IMAGE_BYTES = MAX_IMAGE_BYTES;
/** SDK messageResource.get is the receive-side API, not im.image.get. */
export async function resolveFeishuContent(client, message, signal = AbortSignal.timeout(30_000)) {
    const content = JSON.parse(message.content ?? '{}');
    const keys = [];
    const texts = [];
    if (message.message_type === 'text')
        texts.push(content.text ?? '');
    else if (message.message_type === 'image') {
        if (!content.image_key)
            throw new Error('图片资源缺失');
        keys.push(content.image_key);
    }
    else if (message.message_type === 'file') {
        if (!content.file_key)
            throw new Error('文件资源缺失');
        keys.push(content.file_key);
    }
    else if (message.message_type === 'post') {
        const post = content.content ? content : content.zh_cn ?? content.en_us ?? Object.values(content)[0];
        if (!post || !Array.isArray(post.content))
            throw new Error('富文本内容无效');
        if (post.title)
            texts.push(post.title);
        for (const row of post.content) {
            for (const item of row) {
                if (item.tag === 'img') {
                    if (!item.image_key)
                        throw new Error('图片资源缺失');
                    keys.push(item.image_key);
                }
                else if (typeof item.text === 'string')
                    texts.push(item.text);
            }
        }
    }
    else if (message.message_type === 'sticker') {
        if (typeof content.file_key !== 'string' || !content.file_key)
            throw new Error('表情包资源缺失');
        texts.push('[飞书表情包]');
    }
    else
        throw new Error('暂不支持该消息类型，请发送文字或图片。');
    if (keys.length > MAX_CHANNEL_IMAGES)
        throw new Error('图片数量超过上限');
    const media = [];
    let totalBytes = 0;
    for (const key of keys) {
        if (totalBytes >= MAX_MESSAGE_IMAGE_BYTES)
            throw new Error('图片累计大小超过上限');
        if (!message.message_id)
            throw new Error('图片消息 ID 缺失');
        signal.throwIfAborted();
        let stream;
        let abort = () => { };
        const aborted = new Promise((_, reject) => {
            abort = () => { stream?.destroy(new Error('图片下载已取消或超时')); reject(new Error('图片下载已取消或超时')); };
            signal.addEventListener('abort', abort, { once: true });
        });
        try {
            const resource = await Promise.race([
                client.im.messageResource.get({ path: { message_id: message.message_id, file_key: key }, params: { type: message.message_type === 'file' ? 'file' : 'image' } }).then(resource => {
                    stream = resource.getReadableStream();
                    if (signal.aborted) {
                        stream.destroy();
                        throw new Error('图片下载已取消或超时');
                    }
                    return resource;
                }), aborted,
            ]);
            const consume = async () => {
                const chunks = [];
                let size = 0;
                if (Number(resource.headers?.['content-length']) > MAX_IMAGE_BYTES)
                    throw new Error('图片超过 20 MB 上限');
                if (Number(resource.headers?.['content-length']) > MAX_MESSAGE_IMAGE_BYTES - totalBytes)
                    throw new Error('图片累计大小超过上限');
                for await (const chunk of stream) {
                    const bytes = Buffer.from(chunk);
                    size += bytes.length;
                    totalBytes += bytes.length;
                    if (totalBytes > MAX_MESSAGE_IMAGE_BYTES)
                        throw new Error('图片累计大小超过上限');
                    if (size > MAX_IMAGE_BYTES)
                        throw new Error('图片超过 20 MB 上限');
                    chunks.push(bytes);
                }
                if (!size)
                    throw new Error('图片为空');
                if (message.message_type === 'file')
                    return fileMedia(Buffer.concat(chunks), content.file_name);
                return { kind: 'image', data: Buffer.concat(chunks), mediaType: resource.headers?.['content-type']?.split(';')[0] };
            };
            media.push(await Promise.race([consume(), aborted]));
        }
        finally {
            signal.removeEventListener('abort', abort);
            stream?.destroy();
        }
    }
    return { text: texts.join('\n'), media };
}
/** 群消息只有明确 mention 当前机器人本身才算 addressed；@ 其他成员不触发。 */
export function isFeishuBotMentioned(mentions, botOpenId) {
    if (!botOpenId || !Array.isArray(mentions))
        return false;
    return mentions.some((mention) => mention.id?.open_id === botOpenId);
}
/** Ambient observations contain bounded text only: never download an unaddressed attachment. */
export function summarizeFeishuGroupMessage(message, botOpenId) {
    if (typeof message.content !== 'string' || message.content.length > 64_000)
        return '';
    let body;
    try {
        body = JSON.parse(message.content);
    }
    catch {
        return '';
    }
    let text = '';
    if (message.message_type === 'text')
        text = typeof body?.text === 'string' ? body.text : '';
    else if (message.message_type === 'post') {
        const post = body?.content ? body : body?.zh_cn ?? body?.en_us ?? Object.values(body || {})[0];
        if (post && Array.isArray(post.content))
            text = [typeof post.title === 'string' ? post.title : '', ...post.content.flat().map((x) => typeof x?.text === 'string' ? x.text : x?.tag === 'img' ? '[图片，未读取内容]' : '')].join(' ');
    }
    else if (message.message_type === 'image')
        text = '[图片，未读取内容]';
    else if (message.message_type === 'interactive') {
        const parts = [];
        let visited = 0;
        const visit = (node, depth = 0) => {
            if (++visited > 300 || depth > 8 || !node || typeof node !== 'object')
                return;
            for (const [key, value] of Object.entries(node)) {
                if (['value', 'url', 'href', 'actions'].includes(key))
                    continue;
                if (typeof value === 'string' && ['text', 'content', 'title'].includes(key))
                    parts.push(value);
                else if (typeof value === 'object')
                    visit(value, depth + 1);
            }
        };
        visit(body);
        text = parts.join('\n') || '[消息卡片，无可读取文字]';
    }
    else if (message.message_type === 'sticker')
        text = '[飞书表情，未读取内容]';
    else if (message.message_type === 'file')
        text = '[群文件，未下载]';
    for (const m of message.mentions || [])
        if (m.key && m.key.length <= 100)
            text = text.split(m.key).join(m.id?.open_id === botOpenId ? '@机器人' : '@其他群成员');
    return text.trim().slice(0, 500);
}
/** Read only the bound group and an explicit lower time boundary, using the existing bot client. */
export async function readFeishuGroupHistory(client, chatId, since, until, signal, current, selfId = '', options = {}) {
    if (!/^oc_[a-zA-Z0-9]+$/.test(chatId) || !Number.isFinite(since) || !Number.isFinite(until) || since <= 0 || since > until)
        throw new Error('群历史读取范围无效');
    const rows = [];
    const seen = new Set();
    const bots = new Map();
    let pageToken, hasMore = false, readCount = 0;
    for (let page = 0; page < 4; page++) {
        signal.throwIfAborted();
        current();
        let result;
        try {
            result = await fileOperation(client.im.message.list({ params: { container_id_type: 'chat', container_id: chatId,
                    start_time: String(Math.ceil(since / 1000)), end_time: String(Math.ceil(until / 1000)), sort_type: 'ByCreateTimeDesc', page_size: 50, with_sender_name: true, card_msg_content_type: 'user_card_content',
                    ...(pageToken ? { page_token: pageToken } : {}) } }), signal);
            if (isRejectedCode(result?.code))
                throw { response: { data: result } };
        }
        catch (error) {
            if (signal.aborted)
                throw signal.reason;
            const data = error?.response?.data;
            const code = Number(data?.code);
            const permission = /scope|permission|权限|access denied/i.test(String(data?.msg || '')) || [99991668, 99991672].includes(code);
            throw Object.assign(new Error(permission ? '机器人缺少群历史读取权限。请在飞书应用后台开通“获取群组中所有消息”（im:message.group_msg）和消息读取权限，发布版本后重试。' : `飞书群历史读取失败${Number.isFinite(code) ? `（错误码 ${code}）` : ''}，请检查连接和机器人可见范围。`), { status: permission ? 403 : 502 });
        }
        signal.throwIfAborted();
        current();
        for (const item of result?.data?.items || []) {
            if (item.chat_id && item.chat_id !== chatId)
                continue;
            const time = Number(item.create_time);
            if (!Number.isFinite(time) || time < since || time > until || item.deleted || !item.message_id || seen.has(item.message_id))
                continue;
            seen.add(item.message_id);
            readCount++;
            const robot = item.sender?.sender_type === 'app' || item.sender?.sender_type === 'bot';
            if (!robot && item.sender?.sender_type !== 'user')
                continue;
            const ids = [...new Set([item.sender?.id, item.sender?.open_bot_id].filter(x => typeof x === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(x)))];
            if (robot && !ids.length)
                continue;
            if (robot && ids.some(x => x === selfId || x === options.selfAppId))
                continue;
            const mentions = (item.mentions || []).map((m) => ({ key: m.key, id: { open_id: m.id } }));
            const text = summarizeFeishuGroupMessage({ message_type: item.msg_type, content: item.body?.content, mentions }, selfId);
            if (robot && ids.length) {
                const botId = ids.includes(item.sender.open_bot_id) ? item.sender.open_bot_id : ids[0];
                const existing = bots.get(botId);
                const sample = text.slice(0, 300);
                if (!existing)
                    bots.set(botId, { id: botId, ids, name: String(item.sender.sender_name || `机器人 ${botId}`).slice(0, 80), sample, messageId: item.message_id });
                else if ((!existing.sample || existing.sample.includes('请升级至最新版本客户端')) && sample && !sample.includes('请升级至最新版本客户端'))
                    Object.assign(existing, { sample, messageId: item.message_id });
                if (!ids.some(x => options.allowedBotIds?.includes(x)))
                    continue;
            }
            if (text)
                rows.push({ messageId: item.message_id, userId: item.sender.id, text, time,
                    ...(robot ? { bot: true, botId: item.sender.open_bot_id || item.sender.id } : {}),
                    parentId: item.parent_id, mentionsOthers: mentions.some((m) => m.id.open_id !== selfId) });
        }
        hasMore = !!result?.data?.has_more;
        const next = result?.data?.page_token;
        if (!hasMore || !next || next === pageToken)
            break;
        pageToken = next;
    }
    return { rows: rows.sort((a, b) => a.time - b.time), bots: [...bots.values()], readCount, hasMore, since, until };
}
export function createFeishuChannel(id, config, log, loadSdk) {
    const appId = config.appId?.trim();
    const appSecret = config.appSecret?.trim();
    if (!appId || !appSecret)
        return undefined;
    let handler;
    let client;
    let ws;
    let statusText = '未连接';
    let lifecycle;
    let botOpenId = '';
    let mediaBridgeScope;
    const label = id === 'lark' ? 'Lark' : '飞书';
    return {
        id,
        label,
        maxMessageLength: 4000,
        async start() {
            await mediaBridgeScope?.dispose();
            lifecycle?.abort();
            const generation = new AbortController();
            lifecycle = generation;
            const current = () => lifecycle === generation && !generation.signal.aborted;
            const incoming = new KeyedSerialQueue();
            let sdk;
            try {
                sdk = await (loadSdk ? loadSdk() : import('@larksuiteoapi/node-sdk'));
            }
            catch {
                throw new Error('缺少依赖 @larksuiteoapi/node-sdk');
            }
            const domain = id === 'lark' || config.domain === 'lark' ? 'https://open.larksuite.com' : undefined;
            const logger = quietSdkLogger(() => log(`[${id}] SDK 请求或连接异常（敏感详情已隐藏）`), id);
            const loggerLevel = sdk.LoggerLevel?.error ?? 1;
            const httpInstance = Object.create(sdk.defaultHttpInstance);
            httpInstance.request = (opts) => sdk.defaultHttpInstance.request({ ...opts, timeout: 30_000, maxRedirects: 0 });
            client = new sdk.Client({ appId, appSecret, logger, loggerLevel, httpInstance, ...(domain ? { domain } : {}) });
            // Optional extension: the existing SDK continues to own all credentials.
            if (id === 'feishu')
                mediaBridgeScope = config.host?.inject?.(['taskPersonaMedia'], (scope) => {
                    const transport = {
                        async readGroupHistory(chatId, since, until, signal, assertCurrent, allowedBotIds = []) {
                            if (!client || !lifecycle)
                                throw new Error('feishu-unavailable');
                            return readFeishuGroupHistory(client, chatId, since, until, AbortSignal.any([timeoutSignal(60_000, lifecycle.signal), signal]), assertCurrent, botOpenId, { selfAppId: appId, allowedBotIds });
                        },
                        async sendText(chatId, text, signal, assertCurrent) {
                            if (!client || !lifecycle)
                                throw new Error('feishu-unavailable');
                            const combined = AbortSignal.any([timeoutSignal(30_000, lifecycle.signal), signal]);
                            combined.throwIfAborted();
                            assertCurrent();
                            const result = await fileOperation(client.im.message.create({ params: { receive_id_type: 'chat_id' }, data: {
                                    receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }),
                                } }), combined);
                            if (isRejectedCode(result?.code) || !result?.data?.message_id)
                                throw new Error('feishu-text-send-unconfirmed');
                            return { messageId: result.data.message_id };
                        },
                        async sendImage(chatId, file, signal, assertCurrent) {
                            if (!client || !lifecycle)
                                throw new Error('feishu-unavailable');
                            const active = client;
                            const combined = AbortSignal.any([timeoutSignal(60_000, lifecycle.signal), signal]);
                            combined.throwIfAborted();
                            assertCurrent();
                            const uploaded = await fileOperation(active.im.image.create({ data: { image_type: 'message', image: Buffer.from(file.data) } }), combined);
                            combined.throwIfAborted();
                            if (!uploaded?.image_key)
                                throw new Error('feishu-image-upload-rejected');
                            assertCurrent();
                            const result = await fileOperation(active.im.message.create({ params: { receive_id_type: 'chat_id' }, data: {
                                    receive_id: chatId, msg_type: 'image', content: JSON.stringify({ image_key: uploaded.image_key }),
                                } }), combined);
                            if (isRejectedCode(result?.code) || !result?.data?.message_id)
                                throw new Error('feishu-image-send-unconfirmed');
                            return { messageId: result.data.message_id };
                        },
                        async sendSticker(chatId, fileKey, signal, assertCurrent) {
                            if (!client || !lifecycle)
                                throw new Error('feishu-unavailable');
                            const combined = AbortSignal.any([timeoutSignal(30_000, lifecycle.signal), signal]);
                            combined.throwIfAborted();
                            assertCurrent();
                            const result = await fileOperation(client.im.message.create({ params: { receive_id_type: 'chat_id' }, data: {
                                    receive_id: chatId, msg_type: 'sticker', content: JSON.stringify({ file_key: fileKey }),
                                } }), combined);
                            if (isRejectedCode(result?.code) || !result?.data?.message_id)
                                throw new Error('feishu-sticker-send-unconfirmed');
                            return { messageId: result.data.message_id };
                        },
                    };
                    const dispose = scope.get('taskPersonaMedia').registerTransport(config.accountId ?? id, transport);
                    scope.effect(() => dispose);
                });
            const identity = await client.request({ url: '/open-apis/bot/v3/info', method: 'GET' });
            botOpenId = identity.bot?.open_id?.trim() ?? '';
            if (!botOpenId)
                throw new Error(`${id}: 无法获取机器人 open_id`);
            const dispatcher = new sdk.EventDispatcher({}).register({
                'card.action.trigger': async (data) => {
                    const token = data.action?.value?.token;
                    const chatId = data.context?.open_chat_id;
                    if (current() && token && chatId && data.operator?.open_id)
                        void Promise.resolve(handler?.({ chatId, userId: data.operator.open_id,
                            text: '', actionToken: token, kind: data.action?.value?.group ? 'group' : 'dm', addressed: true,
                        })).catch(() => log(`[${id}] 按钮操作失败`));
                    return {};
                },
                'im.message.receive_v1': async (data) => {
                    const message = data.message;
                    if (!message)
                        return;
                    const group = message.chat_type === 'group';
                    const addressed = !group || isFeishuBotMentioned(message.mentions, botOpenId);
                    if (!message.chat_id || !current())
                        return;
                    const robot = data.sender?.sender_type === 'app' || data.sender?.sender_type === 'bot';
                    if (id === 'feishu' && group && (data.sender?.sender_id?.open_id === botOpenId || data.sender?.sender_id?.open_id === appId))
                        return;
                    const bridge = id === 'feishu' && group ? config.host?.get('taskPersonaMedia') : undefined;
                    const botInput = { accountId: config.accountId ?? id, chatId: message.chat_id, botId: data.sender?.sender_id?.open_id };
                    if (id === 'feishu' && group && robot && !bridge?.acceptsGroupBot?.(botInput))
                        return;
                    if (id === 'feishu' && group && data.sender?.sender_id?.open_id && (!data.sender.sender_type || data.sender.sender_type === 'user' || robot)) {
                        try {
                            let observation = message;
                            if (robot && message.message_type === 'interactive') {
                                if (!message.message_id)
                                    return;
                                // The event/default read format can contain only an upgrade placeholder for cards 2.0.
                                const result = await fileOperation(client.im.message.get({ path: { message_id: message.message_id },
                                    params: { card_msg_content_type: 'user_card_content', with_sender_name: true } }), timeoutSignal(15_000, generation.signal));
                                if (isRejectedCode(result?.code))
                                    throw new Error('bot-card-read-rejected');
                                const item = result?.data?.items?.find((x) => x.message_id === message.message_id && x.chat_id === message.chat_id && !x.deleted &&
                                    ['app', 'bot'].includes(x.sender?.sender_type) && [x.sender?.id, x.sender?.open_bot_id].includes(botInput.botId));
                                if (!item || typeof item.body?.content !== 'string')
                                    throw new Error('bot-card-identity-mismatch');
                                observation = { ...message, content: item.body.content };
                            }
                            if (!current() || robot && !bridge?.acceptsGroupBot?.(botInput))
                                return;
                            const text = summarizeFeishuGroupMessage(observation, botOpenId);
                            if (text)
                                config.host?.get('taskPersonaMedia')?.captureGroupMessage?.({ accountId: config.accountId ?? id,
                                    chatId: message.chat_id, messageId: message.message_id, userId: data.sender.sender_id.open_id,
                                    ...(robot ? { bot: true, botId: data.sender.sender_id.open_id } : {}),
                                    text, addressed, parentId: message.parent_id, mentionsOthers: !!message.mentions?.some(m => m.id?.open_id !== botOpenId) });
                        }
                        catch {
                            log('[feishu] 群聊观察已跳过（不影响直接消息）');
                        }
                    }
                    // Other bots can chat through the scoped observer, never execute as a human user.
                    if (id === 'feishu' && group && robot)
                        return;
                    if (!addressed)
                        return;
                    const chatId = message.chat_id;
                    return incoming.run(chatId, async () => {
                        if (!current())
                            return;
                        let resolved;
                        try {
                            resolved = await resolveFeishuContent(client, message, timeoutSignal(30_000, generation.signal));
                        }
                        catch {
                            if (!current())
                                return;
                            log(`[${id}] 图片或消息读取失败`);
                            await client?.im.message.create({
                                params: { receive_id_type: 'chat_id' },
                                data: { receive_id: message.chat_id, msg_type: 'text', content: JSON.stringify({ text: channelNotice(config.host, '图片或消息读取失败，请重发图片或发送文字。') }) },
                            }).then(result => {
                                const code = result?.code;
                                if (isRejectedCode(code))
                                    throw new Error('media-notice-rejected');
                            }).catch(() => log(`[${id}] 媒体提示发送失败`));
                            return;
                        }
                        if (!current())
                            return;
                        if (group && id === 'feishu') {
                            for (const mention of message.mentions || [])
                                if (mention.key && mention.id?.open_id === botOpenId)
                                    resolved.text = resolved.text.split(mention.key).join('').trim();
                            if (!resolved.text && !resolved.media.length)
                                resolved.text = '[群聊里有人 @ 了机器人，没有附加文字。]';
                        }
                        await handler?.({
                            chatId,
                            userId: data.sender?.sender_id?.open_id,
                            text: resolved.text,
                            ...(resolved.media.length ? { media: resolved.media } : {}),
                            messageId: message.message_id,
                            kind: group ? 'group' : 'dm',
                            addressed,
                        });
                        if (id === 'feishu') {
                            try {
                                const bridge = config.host?.get('taskPersonaMedia');
                                const raw = JSON.parse(message.content ?? '{}');
                                bridge?.captureIncoming({ accountId: config.accountId ?? id, chatId, kind: group ? 'group' : 'dm',
                                    messageId: message.message_id, media: resolved.media,
                                    ...(message.message_type === 'sticker' ? { stickerKey: raw.file_key } : {}),
                                });
                            }
                            catch {
                                log('[feishu] 表情候选收藏失败（不影响原消息处理）');
                            }
                        }
                    }).catch(() => { if (current())
                        log(`[${id}] 消息处理失败`); });
                },
            });
            const wsClient = new sdk.WSClient({ appId, appSecret, logger, loggerLevel, ...(domain ? { domain } : {}) });
            ws = wsClient;
            await wsClient.start({ eventDispatcher: dispatcher });
            statusText = '长连接已建立';
            log(`[${id}] WebSocket 长连接已启动`);
        },
        async stop() {
            await mediaBridgeScope?.dispose();
            mediaBridgeScope = undefined;
            lifecycle?.abort();
            lifecycle = undefined;
            ws?.close({ force: true });
            ws = undefined;
            statusText = '已停止';
        },
        canDeliverDeferred() { return statusText === '长连接已建立'; },
        async send(chatId, text) {
            if (!client)
                throw new Error(`${id}: 尚未连接`);
            const sender = client;
            // 飞书普通回复使用原生文本气泡；Lark 保留上游卡片路径。
            let delivered = false;
            for (const part of id === 'feishu' ? (text.trim() ? [text] : []) : splitByTableLimit(text)) {
                try {
                    if (id === 'feishu') {
                        const plain = await sender.im.message.create({ params: { receive_id_type: 'chat_id' },
                            data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text: part }) },
                        });
                        if (isThrottleCode(plain?.code))
                            throw new DeliveryRejected('feishu: text-send-throttled');
                        if (isRejectedCode(plain?.code))
                            throw new Error('feishu: text-send-rejected');
                        delivered = true;
                        continue;
                    }
                    // 网络异常直接交给上层；只有明确业务拒绝才回退，避免重复投递。
                    // 飞书要渲染 Markdown 表格，卡片必须是 Schema 2.0（body.elements）
                    const card = await sender.im.message.create({
                        params: { receive_id_type: 'chat_id' },
                        data: {
                            receive_id: chatId,
                            msg_type: 'interactive',
                            content: JSON.stringify({ schema: '2.0', config: { wide_screen_mode: true }, body: { elements: [{ tag: 'markdown', content: part }] } }),
                        },
                    });
                    if (!isRejectedCode(card?.code)) {
                        delivered = true;
                        continue;
                    }
                    // 被限流时改发纯文本只会再被限流，直接交给上层退避重试。
                    if (isThrottleCode(card?.code))
                        throw new DeliveryRejected(`${id}: text-send-throttled code=${card?.code}`);
                    const rejected = card?.code;
                    // 卡片被拒（内容过大、接口不支持等）时退回纯文本，不丢正文。
                    const plain = await sender.im.message.create({
                        params: { receive_id_type: 'chat_id' },
                        data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text: part }) },
                    });
                    if (isThrottleCode(plain?.code))
                        throw new DeliveryRejected(`${id}: text-send-throttled code=${plain?.code}`);
                    if (isRejectedCode(plain?.code))
                        throw new Error(`${id}: text-send-rejected code=${plain?.code} card=${String(rejected)}`);
                    delivered = true;
                }
                catch (error) {
                    const normalized = error instanceof DeliveryRejected || !throttledResponse(error)
                        ? error : new DeliveryRejected(`${id}: text-send-throttled http=${error.response?.status}`);
                    throw delivered ? afterPartialDelivery(normalized) : normalized;
                }
            }
        },
        async sendChoices(message, text, buttons) {
            if (!client)
                throw new Error('channel-unavailable');
            const result = await client.im.message.create({ params: { receive_id_type: 'chat_id' }, data: {
                    receive_id: message.chatId, msg_type: 'interactive', content: JSON.stringify({ config: { wide_screen_mode: true }, elements: [
                            { tag: 'markdown', content: text },
                            ...buttons.map(button => ({ tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: button.label.slice(0, 60) },
                                        type: 'default', value: { token: button.token, group: message.kind === 'group' } }] })),
                        ] }),
                } }).catch(error => { throw choiceSendError(error); });
            if (isRejectedCode(result?.code))
                throw new ChoiceSendError('rejected');
            const messageId = result?.data?.message_id;
            const sender = client;
            if (!messageId)
                return;
            return { close: async (status) => {
                    const updated = await sender.im.message.patch({ path: { message_id: messageId }, data: { content: JSON.stringify({ config: { wide_screen_mode: true }, elements: [
                                    { tag: 'markdown', content: text }, { tag: 'div', text: { tag: 'plain_text', content: status } },
                                ] }) } });
                    if (isRejectedCode(updated?.code))
                        throw new Error('card-update-failed');
                } };
        },
        async addStatusReaction(message, state, _label, signal) {
            // 飞书聊天不自动附加 OnIt / DONE / ERROR；保留其他渠道原有状态反馈。
            if (id === 'feishu')
                return;
            if (!client || !message.messageId || state === 'cancelled')
                return;
            const emoji = (state === 'success' || state === 'ended') ? 'DONE' : state === 'error' ? 'ERROR' : 'OnIt';
            signal.throwIfAborted();
            const result = await fileOperation(client.im.messageReaction.create({
                path: { message_id: message.messageId }, data: { reaction_type: { emoji_type: emoji } },
            }), signal);
            if (isRejectedCode(result.code) || !result.data?.reaction_id)
                throw new Error('reaction-rejected');
            return result.data.reaction_id;
        },
        async removeStatusReaction(message, reaction, signal) {
            if (!client)
                return;
            signal.throwIfAborted();
            const result = await fileOperation(client.im.messageReaction.delete({ path: { message_id: message.messageId, reaction_id: reaction } }), signal);
            if (isRejectedCode(result.code))
                throw new Error('reaction-rejected');
        },
        async sendFile(chatId, file, signal) {
            if (!client || !lifecycle)
                throw new Error(`${id}: 尚未连接`);
            const active = client;
            const scope = AbortSignal.any([timeoutSignal(120_000, lifecycle.signal), ...(signal ? [signal] : [])]);
            scope.throwIfAborted();
            const uploaded = await fileOperation(active.im.file.create({ data: { file_type: 'stream', file_name: file.name, file: Buffer.from(file.data) } }), scope);
            scope.throwIfAborted();
            if (!uploaded?.file_key)
                throw new Error('file-upload-rejected');
            const sent = await active.im.message.create({
                params: { receive_id_type: 'chat_id' },
                data: { receive_id: chatId, msg_type: 'file', content: JSON.stringify({ file_key: uploaded.file_key }) },
            });
            if (isRejectedCode(sent.code))
                throw new Error('file-send-rejected');
        },
        setMessageHandler(h) { handler = h; },
        async diagnose(signal) {
            const domain = id === 'lark' || config.domain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
            let token;
            const auth = await probe('credentials', signal, async () => {
                const data = await diagnosticJson(`${domain}/open-apis/auth/v3/tenant_access_token/internal`, signal, { app_id: appId, app_secret: appSecret });
                platformResult(data.code, [10003, 10014]);
                requireDiagnostic(typeof data.tenant_access_token === 'string' && data.tenant_access_token);
                token = data.tenant_access_token;
            });
            if (auth.status !== 'passed')
                return [auth];
            return [auth, await probe('bot', signal, async () => {
                    const data = await diagnosticJson(`${domain}/open-apis/bot/v3/info`, signal, undefined, { Authorization: `Bearer ${token}` });
                    platformResult(data.code);
                    const bot = data.bot;
                    requireDiagnostic(typeof bot?.open_id === 'string' && bot.open_id);
                })];
        },
        status() { return statusText; },
    };
}
