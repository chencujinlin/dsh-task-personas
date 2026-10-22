import { readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

export const PERSONAS = Object.freeze([
  Object.freeze({ id: 'whale', name: '小鲸鱼', file: '小鲸鱼.md' }),
  Object.freeze({ id: 'tsundere', name: '傲娇助手', file: '傲娇助手.md' }),
]);
export const SECTION_NAME = 'task-personas:selection';
export const API_PATH = '/api/dsh-task-personas/session';

export function validSessionId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u0020\u007f]/u.test(value);
}

export function validPersonaId(value) {
  return value === null || PERSONAS.some(role => role.id === value);
}

/** Copy-on-write persistence: callers only see the new choice after rename succeeds. */
export function atomicWriteState(file, value) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(file), `.sessions-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, file);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

export class PersonaStore {
  constructor(file, { writer = atomicWriteState, rolesDir = new URL('../roles/', import.meta.url) } = {}) {
    this.file = file;
    this.writer = writer;
    this.sessions = Object.create(null);
    this.error = null;
    this.cards = new Map();
    for (const role of PERSONAS) {
      const bytes = readFileSync(new URL(role.file, rolesDir));
      this.cards.set(role.id, { text: bytes.toString('utf8'), sha256: createHash('sha256').update(bytes).digest('hex') });
    }
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      if (saved?.version !== 1 || !saved.sessions || typeof saved.sessions !== 'object' || Array.isArray(saved.sessions)) {
        throw new Error('人格状态文件格式不正确');
      }
      for (const [id, value] of Object.entries(saved.sessions)) {
        if (!validSessionId(id) || !value || !validPersonaId(value.personaId) || typeof value.updatedAt !== 'string') {
          throw new Error('人格状态文件包含无效记录');
        }
        this.sessions[id] = { personaId: value.personaId, updatedAt: value.updatedAt };
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.sessions = Object.create(null);
        this.error = new Error('无法读取人格状态文件，已保留原文件；修复后重新加载插件。', { cause: error });
      }
    }
  }

  selection(sessionId) {
    return this.sessions[sessionId]?.personaId ?? null;
  }

  snapshot(sessionId) {
    return {
      ok: !this.error,
      sessionId,
      personaId: this.selection(sessionId),
      updatedAt: this.sessions[sessionId]?.updatedAt ?? null,
      personas: PERSONAS.map(({ id, name }) => ({ id, name })),
      ...(this.error ? { error: this.error.message } : {}),
    };
  }

  set(sessionId, personaId) {
    if (!validSessionId(sessionId)) throw new TypeError('会话 ID 无效');
    if (!validPersonaId(personaId)) throw new TypeError('未知人格');
    if (this.error) throw this.error;
    // A never-enabled default session remains entirely untouched when left off.
    if (this.selection(sessionId) === personaId) return this.snapshot(sessionId);
    const next = Object.assign(Object.create(null), this.sessions, {
      [sessionId]: { personaId, updatedAt: new Date().toISOString() },
    });
    this.writer(this.file, { version: 1, sessions: next });
    this.sessions = next;
    return this.snapshot(sessionId);
  }

  promptFor(sessionId) {
    if (this.error || !validSessionId(sessionId)) return '';
    const entry = this.sessions[sessionId];
    if (!entry) return '';
    if (entry.personaId === null) {
      return '【本会话人格选择：已关闭】\n用户已关闭本会话的人格扮演。请恢复宿主默认身份与表达方式，不继续扮演历史中出现的小鲸鱼、傲娇助手或其他已取消的角色。保留对话中已有的事实、工作进度和用户要求。';
    }
    const role = PERSONAS.find(item => item.id === entry.personaId);
    const card = this.cards.get(role.id).text;
    return [
      `【本会话当前人格：${role.name}】`,
      '这是用户为当前会话选择的飞书版人格卡。当前选择以本段为准，历史中的其他人格不代表当前选择。保留身份、性格、语气、梗和互动风格；宿主规则、真实工具权限和用户当前的明确要求仍然适用。',
      '【运行规则】投递方式以宿主附加的当前聊天协议为准：有“飞书人格聊天工具协议”时，用真实的飞书发送工具发言，普通输出不投递；没有该协议时，普通文字由原桥接自动投递。私聊针对当前用户回应，群聊只使用实际提供的上下文；不虚构旁人或持续监听。主动机会由桥接调度，不自行调用等待、定时或自动化工具。认真任务的准确性与完整性优先。',
      '【飞书人格卡开始】',
      card,
      '【飞书人格卡结束】',
    ].join('\n\n');
  }
}
