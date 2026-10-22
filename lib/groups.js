import { createHash, randomUUID } from 'node:crypto';

const MINUTE = 60_000;
export const validBotId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
export const validBotPeer = peer => peer && validBotId(peer.id) && typeof peer.name === 'string' && peer.name.length <= 80 && Array.isArray(peer.ids) && peer.ids.length > 0 && peer.ids.length <= 4 && peer.ids.every(validBotId) && peer.ids.includes(peer.id);
const clock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Taipei', hour: '2-digit', hourCycle: 'h23' });
export function botQuietHours(now) { const hour = Number(clock.format(new Date(now))); return hour >= 22 || hour < 8; }

/** Per-group observations stay in memory. They never become user task instructions. */
export class GroupParticipation {
  constructor(social) { this.social = social; this.states = new Map(); this.revisions = new Map(); this.reading = new Set(); }
  available(id) { return this.social.media.library.binding(id)?.kind === 'group'; }
  enabled(id) { return this.available(id) && this.social.enabled(id) && this.social.store.get(id)?.groupParticipationEnabled === true; }
  current(id, revision) { return this.enabled(id) && (this.revisions.get(id) || 0) === revision; }
  bindingId(input) {
    const matches = this.social.media.library.bindings().map(([, b]) => b).filter(b => b.kind === 'group' && b.channel === input.accountId && b.chatId === input.chatId);
    return matches.length === 1 ? matches[0].sessionId : undefined;
  }
  peer(id, botId) { return validBotId(botId) && this.social.store.get(id)?.allowedBots?.find(p => p.ids.includes(botId)); }
  acceptsBot(input) { const id = this.bindingId(input); return !!id && this.enabled(id) && !!this.peer(id, input.botId) && !botQuietHours(this.social.now()); }
  botPeers(id) {
    const peers = new Map((this.social.store.get(id)?.allowedBots || []).map(p => [p.id, p]));
    for (const p of this.states.get(id)?.bots || []) if (validBotPeer(p)) peers.set(p.id, p);
    return [...peers.values()];
  }
  resolveBots(id, ids) {
    if (!this.available(id) || !Array.isArray(ids) || ids.length > 32 || !ids.every(validBotId)) throw Object.assign(Error('机器人选择无效'), { status: 400 });
    const peers = this.botPeers(id);
    return [...new Set(ids)].map(botId => {
      const p = peers.find(p => p.id === botId);
      if (!p) throw Object.assign(Error('请先读取本群机器人，再选择。'), { status: 400 });
      return { id: p.id, ids: p.ids, name: p.name };
    });
  }
  state(id) {
    if (!this.states.has(id)) this.states.set(id, { rows: [], unread: [], seen: new Set(), own: new Set(), due: 0, lastObservedAt: 0, lastAmbientAt: 0, expiresAt: 0 });
    return this.states.get(id);
  }
  clear(id) { this.states.delete(id); this.revisions.set(id, (this.revisions.get(id) || 0) + 1); }
  prune() { for (const id of this.states.keys()) if (!this.enabled(id)) this.clear(id); }
  cancelBatch(id) {
    const s = this.states.get(id); if (!s) return;
    s.inFlight = null;
    s.due = s.unread.length || s.historyRows?.length ? this.social.now() + 8000 : 0;
  }
  consumed(id, batchId) {
    const s = this.states.get(id), batch = s?.inFlight;
    if (!batch || batch.id !== batchId) return;
    const ids = new Set(batch.rows.map(r => r.messageId));
    s.unread = s.unread.filter(r => !ids.has(r.messageId));
    if (batch.history === s.historyRows) s.historyRows = null;
    s.inFlight = null; s.lastDeliveredAt = this.social.now();
    s.due = s.unread.length || s.historyRows?.length ? this.social.now() : 0;
  }
  snapshot(id) {
    const s = this.states.get(id);
    return { available: this.available(id), enabled: this.enabled(id), lastObservedAt: s?.lastObservedAt || null,
      lastAmbientAt: s?.lastAmbientAt || null, buffered: s?.rows.length || 0, unread: s?.unread.length || 0, readAllMessages: true, lastDeliveredAt: s?.lastDeliveredAt || null, lastReadAt: s?.lastReadAt || null, lastReadCount: s?.lastReadCount ?? null,
      allowedBots: this.social.store.get(id)?.allowedBots || [], botQuietHours: botQuietHours(this.social.now()), botNight: { start: 22, end: 8, timeZone: 'Asia/Taipei' } };
  }
  async readHistory(id, discoveryOnly = false) {
    if (!this.enabled(id)) throw Object.assign(Error('请先为当前群启用人格和自主参与。'), { status: 400 });
    if (this.reading.has(id)) throw Object.assign(Error('正在读取这个群，请稍候。'), { status: 409 });
    const binding = { ...this.social.media.library.binding(id) }, revision = this.revisions.get(id) || 0;
    const match = id.match(/^im:feishu(?:_[a-zA-Z0-9]+)?:group:(\d{13}):oc_[a-zA-Z0-9]+$/);
    const since = match && Number(match[1]), until = this.social.now();
    if (!since || since > until) throw Object.assign(Error('没有可验证的群会话接入时间，暂不读取历史。'), { status: 400 });
    const transport = this.social.media.transports.get(binding.channel);
    if (!transport?.readGroupHistory) throw Object.assign(Error('飞书尚未连接或桥接未更新，请稍后重试。'), { status: 503 });
    const s = this.state(id);
    if (!discoveryOnly && s.lastReadAt && until - s.lastReadAt < MINUTE) throw Object.assign(Error('刚刚读过这个群，请一分钟后再试。'), { status: 429 });
    const current = () => { const b = this.social.media.library.binding(id); if (!this.current(id, revision) || b?.channel !== binding.channel || b?.chatId !== binding.chatId || this.social.media.transports.get(binding.channel) !== transport) throw Object.assign(Error('群会话或人格已变化，取消读取。'), { status: 409 }); };
    this.reading.add(id);
    try {
      const allowedIds = botQuietHours(until) ? [] : (this.social.store.get(id)?.allowedBots || []).flatMap(p => p.ids);
      current(); const result = await transport.readGroupHistory(binding.chatId, since, until, AbortSignal.timeout(60_000), current, allowedIds); current();
      s.bots = (result.bots || []).filter(validBotPeer).slice(0,32);
      if (discoveryOnly) return { bots: this.botPeers(id), readCount: result.readCount, hasMore: result.hasMore, since, until };
      // Manual catch-up is bounded separately; live unread messages are never trimmed with recent context.
      const rows = result.rows.filter(x => x.time >= since && x.time <= until && (!x.bot || allowedIds.includes(x.botId))).slice(-40).map(x => ({
        messageId: x.messageId,
        speaker: x.bot ? this.peer(id, x.botId)?.name || '群机器人' : x.userId ? `群成员-${createHash('sha256').update(x.userId).digest('hex').slice(0, 6)}` : '群成员', text: x.text.slice(0,500), time: x.time,
        ...(x.bot ? { bot: true, botId: x.botId } : {}),
        mentionsOthers: !!x.mentionsOthers, replyToSelf: !!x.parentId && s.own.has(x.parentId), replyToOther: !!x.parentId && !s.own.has(x.parentId), historical: true }));
      s.lastReadAt = until; s.lastReadCount = result.readCount; s.historyRows = rows;
      for (const x of result.rows) s.seen.add(x.messageId);
      while (s.seen.size > 200) s.seen.delete(s.seen.values().next().value);
      s.due = rows.length || s.unread.length ? until : 0; s.expiresAt = until + 2 * MINUTE;
      const queued = rows.length ? await this.tick(id) : false;
      return { readCount: result.readCount, contextCount: rows.length, hasMore: result.hasMore, since, until, queued };
    } finally { this.reading.delete(id); }
  }
  sent(id, messageId, text = '') {
    if (!this.enabled(id) || !messageId) return;
    const s = this.state(id); s.own.add(messageId);
    while (s.own.size > 50) s.own.delete(s.own.values().next().value);
    s.rows.push({ self: true, speaker: '机器人', text: String(text || '[表情]').slice(0, 500), time: this.social.now() });
    this.trim(s);
  }
  trim(s) { s.rows = s.rows.filter(x => this.social.now() - x.time < 15 * MINUTE).slice(-12); }
  capture(input) {
    const id = this.bindingId(input);
    if (!id || input.bot && !this.acceptsBot(input)) return false;
    if (!this.enabled(id) || this.social.store.error || this.social.paused.has(id) || !input.messageId || typeof input.text !== 'string') return false;
    const s = this.state(id);
    if (s.seen.has(input.messageId) || s.unread.some(r => r.messageId === input.messageId)) return false;
    s.seen.add(input.messageId); while (s.seen.size > 100) s.seen.delete(s.seen.values().next().value);
    const now = this.social.now();
    const replyToSelf = !!input.parentId && s.own.has(input.parentId);
    const e = this.social.ensure(id);
    // Activity postpones idle chatter; another person's farewell does not end the whole group.
    this.social.store.put(id, { ...e, lastIncomingAt: now, followupAt: 0 });
    s.lastObservedAt = now;
    const row = { messageId: input.messageId, speaker: input.bot ? this.peer(id, input.botId).name : input.userId ? `群成员-${createHash('sha256').update(input.userId).digest('hex').slice(0, 6)}` : '群成员',
      ...(input.bot ? { bot: true, botId: input.botId } : {}),
      text: input.text.slice(0, 500), mentionsOthers: !!input.mentionsOthers, replyToSelf, replyToOther: !!input.parentId && !replyToSelf,
      directlyAddressed: !!input.addressed, time: now };
    s.rows.push(row);
    this.trim(s);
    if (input.addressed && !input.bot) {
      // Direct requests use the ordinary IM route and take precedence over an ambient opportunity.
      this.revisions.set(id, (this.revisions.get(id) || 0) + 1);
      this.social.clearPending(id);
      return true;
    }
    s.lastAmbientAt = now;
    s.unread.push(row);
    if (!s.due) s.due = now + 8000;
    return true;
  }
  async tick(id) {
    if (!this.enabled(id)) { this.clear(id); return false; }
    const s = this.states.get(id); if (!s?.due || s.due > this.social.now()) return false;
    const now = this.social.now(), quiet = botQuietHours(now);
    if (s.historyRows && s.expiresAt < now) s.historyRows = null;
    if (quiet) {
      s.unread = s.unread.filter(r => !r.bot);
      if (s.historyRows) s.historyRows = s.historyRows.filter(r => !r.bot);
    }
    // A direct reply or another automatic wake may already own this group.
    if (this.social.pending.has(id) || this.social.claimed.has(id) || s.inFlight) return false;
    this.trim(s);
    const history = s.historyRows?.length ? s.historyRows : null;
    // Separate bot/human batches so the night rule can cancel bot work without blocking humans.
    const botTriggered = !!(history || s.unread)[0]?.bot;
    const selected = history || s.unread.filter(r => !!r.bot === botTriggered).slice(0,40);
    if (!selected.length) { s.due = 0; return false; }
    const unreadIds = new Set(s.unread.map(r => r.messageId));
    const context = history ? [] : s.rows.filter(r => (!r.bot || !quiet && this.peer(id,r.botId)) && !unreadIds.has(r.messageId)).map(r => ({ ...r, context: true }));
    const rows = [...context, ...selected.map(r => ({ ...r, new: true }))];
    const revision = this.revisions.get(id) || 0;
    const batch = { id: randomUUID(), rows: selected, history }; s.inFlight = batch;
    try {
      const queued = await this.social.queueGroup(id, rows, revision, !!history, botTriggered, batch.id);
      if (!queued && s.inFlight === batch) s.inFlight = null;
      return queued;
    } catch (e) { if (s.inFlight === batch) s.inFlight = null; throw e; }
  }
  dispose() { this.states.clear(); this.revisions.clear(); this.reading.clear(); }
}
