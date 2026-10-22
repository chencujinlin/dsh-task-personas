window.__ModuleLoader__.load({
  id: 'dsh-task-personas',
  factory(require) {
    const React = require('react');
    const { createElement: h, useEffect, useSyncExternalStore, useState, useRef, useMemo } = React;
    const { Button, Menu, Modal, SegmentedTabs, IconAgentPresetOutlineRegular: PersonaIcon, IconChevronDownOutlineRegular: ChevronIcon, IconPlusOutlineRegular: PlusIcon, IconRefreshOutlineRegular: RefreshIcon, IconSearchOutlineRegular: SearchIcon, IconCloseOutlineRegular: CloseIcon, IconCheckOutlineRegular: CheckIcon, IconCheckCircleOutlineRegular: ConnectedIcon } = require('@deepseek-ai/dsh-client-ui-primitives');
    const API = '/api/dsh-task-personas/session';
    const STICKERS = '/api/dsh-task-personas/stickers';
    const SOCIAL = '/api/dsh-task-personas/social';
    const records = new Map();
    let disposed = false;

    function record(id) {
      if (!records.has(id)) records.set(id, {
        value: { ready: false, saving: false, personaId: null, error: null, personas: [] },
        listeners: new Set(), sequence: 0, controller: null,
      });
      return records.get(id);
    }
    function publish(row, patch) {
      if (disposed) return;
      row.value = { ...row.value, ...patch };
      for (const listener of row.listeners) listener();
    }
    async function request(id, personaId, mutate = false) {
      const row = record(id);
      if (row.value.saving) return;
      row.controller?.abort();
      const controller = new AbortController();
      row.controller = controller;
      const sequence = ++row.sequence;
      publish(row, { saving: mutate, error: null });
      try {
        const response = await fetch(mutate ? API : `${API}?sessionId=${encodeURIComponent(id)}`, {
          method: mutate ? 'PUT' : 'GET',
          credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
          ...(mutate ? {
            headers: { 'Content-Type': 'application/json', 'x-dsh-task-personas-client': '1' },
            body: JSON.stringify({ sessionId: id, personaId }),
          } : {}),
        });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.error || '人格选择读取失败');
        if (row.sequence === sequence) publish(row, {
          ready: true, saving: false, personaId: data.personaId,
          personas: data.personas, feishu: data.feishu, social: data.social, error: null,
        });
      } catch (error) {
        if (!controller.signal.aborted && row.sequence === sequence) {
          publish(row, { saving: false, error: error.message || '人格服务暂时不可用' });
        }
      }
    }
    async function toggleProactive(id, group = false) {
      const row = record(id); if (row.value.saving) return;
      publish(row, { saving: true, error: null });
      try {
        const patch = group ? { groupParticipationEnabled: !row.value.social?.group?.enabled } : { proactiveEnabled: !(row.value.social?.proactiveEnabled ?? true) };
        const response = await fetch(SOCIAL, { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'x-dsh-task-personas-client': '1' }, body: JSON.stringify({ sessionId: id, ...patch }) });
        const data = await response.json(); if (!response.ok || !data.ok) throw Error(data.error || '聊天习惯保存失败');
        publish(row, { saving: false, social: data });
      } catch (e) { publish(row, { saving: false, error: e.message }); }
    }
    async function readGroup(id) {
      const row = record(id); if (row.value.saving) return;
      publish(row, { saving: true, error: null, notice: null });
      try {
        const response = await fetch(`${SOCIAL}/read-group`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'x-dsh-task-personas-client': '1' }, body: JSON.stringify({ sessionId: id }) });
        const data = await response.json(); if (!response.ok || !data.ok) throw Error(data.error || '群历史读取失败');
        const { read, ...social } = data;
        publish(row, { saving: false, social, notice: `已读取接入后 ${read.readCount} 条消息，${read.hasMore ? '本次达到200条上限；' : ''}最近 ${read.contextCount} 条消息交给模型了解背景。` });
      } catch (e) { publish(row, { saving: false, error: e.message }); }
    }
    const CSS = `
      .dsh-persona-control{display:inline-flex;align-items:center;flex-shrink:0;gap:4px;font:inherit}
      .dsh-persona-trigger{height:28px;padding:0 6px;gap:5px;font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
      .dsh-persona-trigger[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
      .dsh-persona-trigger>svg{flex-shrink:0;color:var(--dsw-alias-label-tertiary)}
      .dsh-persona-trigger-label{max-width:88px;overflow:hidden;text-overflow:ellipsis}
      .dsh-persona-menu{min-width:248px;max-width:calc(100vw - 24px)}
      .dsh-persona-option{display:grid;gap:2px;padding:2px 0;font-size:13px;line-height:20px}
      .dsh-persona-option small,.dsh-persona-menu-note{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
      .dsh-persona-menu-note{margin:7px 10px 8px;max-width:232px;white-space:normal;overflow-wrap:anywhere}
      .dsh-persona-error{font-size:12px;color:var(--dsw-alias-state-error-primary)}
      .dsh-persona-bots{width:min(560px,calc(100vw - 32px));max-height:calc(100dvh - 48px);padding:0;overflow:auto;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base)}
      .dsh-persona-bots-body{padding:24px;display:flex;flex-direction:column;gap:16px;font-size:13px;line-height:20px}
      .dsh-persona-bots-body h2,.dsh-persona-bots-body p{margin:0}
      .dsh-persona-bots-body h2{font-size:18px;font-weight:600;flex:1}
      .dsh-persona-bots-body>.dsh-persona-actions{justify-content:flex-end}
      .dsh-persona-bots-list{display:grid;gap:8px;max-height:45dvh;overflow:auto}
      .dsh-persona-bot-row{display:flex;gap:10px;align-items:flex-start;padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;cursor:pointer}
      .dsh-persona-bot-row input{margin-top:4px;accent-color:var(--dsw-alias-brand-primary)}
      .dsh-persona-bot-row>span{display:grid;gap:4px;min-width:0;overflow-wrap:anywhere}
      .dsh-persona-bot-row code,.dsh-persona-bot-row small{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
      .dsh-persona-library{box-sizing:border-box;width:min(940px,calc(100vw - 40px));max-width:940px;height:min(688px,calc(100dvh - 56px));max-height:calc(100dvh - 56px);padding:0;overflow:hidden;border-radius:var(--dsw-radius-lg,16px);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base)}
      .dsh-persona-library *{box-sizing:border-box}
      .dsh-persona-shell{display:flex;flex-direction:column;height:100%;min-height:0;font-size:13px;line-height:20px}
      .dsh-persona-shell h2,.dsh-persona-shell h3,.dsh-persona-shell p{margin:0}
      .dsh-persona-library-header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:22px 24px 16px;flex-shrink:0}
      .dsh-persona-library-title{display:flex;align-items:center;gap:12px;min-width:0}
      .dsh-persona-library-title h2{font-size:18px;font-weight:600;line-height:26px;letter-spacing:-.2px;white-space:nowrap}
      .dsh-persona-connection{display:inline-flex;align-items:center;gap:4px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
      .dsh-persona-connection[data-connected=true]>svg{color:var(--dsw-alias-state-success-primary)}
      .dsh-persona-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
      .dsh-persona-actions button{white-space:nowrap}
      .dsh-persona-icon-button{width:28px;padding:0}
      .dsh-persona-library-tools{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:0 24px 16px;flex-shrink:0}
      .dsh-persona-tabs{width:230px;flex-shrink:0}
      .dsh-persona-search{display:flex;align-items:center;gap:7px;width:228px;max-width:45%;color:var(--dsw-alias-label-secondary)}
      .dsh-persona-search input{border:0;padding:5px 0;background:transparent;outline:none!important;font-size:12px;min-width:0;width:100%;color:var(--dsw-alias-label-primary)}
      .dsh-persona-search:focus-within{box-shadow:0 1px 0 var(--dsw-alias-brand-primary)}
      .dsh-persona-search input::placeholder,.dsh-persona-fields input::placeholder,.dsh-persona-fields textarea::placeholder{color:var(--dsw-alias-label-secondary);opacity:1}
      .dsh-persona-library-body{display:grid;grid-template-columns:minmax(0,1fr) 270px;min-height:0;flex:1;border-top:1px solid var(--dsw-alias-border-l1)}
      .dsh-persona-gallery-pane{display:flex;flex-direction:column;min-height:0;min-width:0}
      .dsh-persona-candidate-note{padding:14px 24px 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:19px}
      .dsh-persona-gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(126px,1fr));gap:16px;align-content:start;padding:20px 22px;overflow:auto;min-height:0;flex:1;list-style:none;margin:0}
      .dsh-persona-gallery>li{min-width:0}
      .dsh-persona-tile{appearance:none;border:0;display:flex;flex-direction:column;gap:7px;background:transparent;color:var(--dsw-alias-label-primary);width:100%;padding:0;font:inherit;text-align:left;cursor:pointer;border-radius:var(--dsw-radius-md,12px)}
      .dsh-persona-tile-frame{display:grid;place-items:center;aspect-ratio:1;width:100%;border:1px solid transparent;border-radius:var(--dsw-radius-md,12px);padding:10px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
      .dsh-persona-tile-frame img{display:block;max-width:100%;width:100%;height:100%;min-height:0;object-fit:contain}
      .dsh-persona-tile:hover .dsh-persona-tile-frame{background:var(--dsw-alias-interactive-bg-hover)}
      .dsh-persona-tile[aria-pressed=true] .dsh-persona-tile-frame{border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 7%,var(--dsw-alias-bg-layer-1))}
      .dsh-persona-tile:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:4px}
      .dsh-persona-tile-caption{display:flex;align-items:center;gap:5px;min-width:0;width:100%;padding:0 2px}
      .dsh-persona-tile-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:18px}
      .dsh-persona-tile-meta{font-size:10px;line-height:16px;color:var(--dsw-alias-label-secondary);flex-shrink:0}
      .dsh-persona-tile-caption>svg{color:var(--dsw-alias-brand-primary);flex-shrink:0}
      .dsh-persona-native-placeholder{display:grid;place-items:center;gap:6px;color:var(--dsw-alias-label-secondary);font-size:12px;text-align:center}
      .dsh-persona-editor{min-height:0;overflow:auto;padding:18px 20px 20px;border-left:1px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;gap:16px}
      .dsh-persona-editor h3{font-size:13px;font-weight:600;line-height:20px}
      .dsh-persona-detail-preview{display:grid;place-items:center;height:156px;padding:4px}
      .dsh-persona-detail-preview img{display:block;width:100%;height:148px;min-height:0;min-width:0;max-height:100%;object-fit:contain}
      .dsh-persona-fields{display:grid;gap:14px}
      .dsh-persona-fields label{display:grid;gap:6px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
      .dsh-persona-fields input,.dsh-persona-fields textarea{width:100%;min-width:0;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;resize:vertical}
      .dsh-persona-fields textarea{min-height:80px;max-height:160px}
      .dsh-persona-fields input:focus-visible,.dsh-persona-fields textarea:focus-visible{outline:1px solid var(--dsw-alias-brand-primary);outline-offset:0}
      .dsh-persona-editor-note{font-size:12px;line-height:19px;color:var(--dsw-alias-label-secondary)}
      .dsh-persona-editor-buttons{display:flex;flex-direction:column;gap:8px;margin-top:auto}
      .dsh-persona-editor-buttons>.dsh-persona-actions{justify-content:space-between;gap:4px}
      .dsh-persona-danger{color:var(--dsw-alias-state-error-primary)}
      .dsh-persona-library-footer{display:flex;justify-content:space-between;align-items:center;gap:12px;border-top:1px solid var(--dsw-alias-border-l1);padding:10px 24px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;flex-shrink:0;min-height:45px}
      .dsh-persona-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:28px;min-height:220px;flex:1;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:20px}
      .dsh-persona-empty strong{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500}
      .dsh-persona-alert{padding:10px 24px;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:19px}
      .dsh-persona-skeleton{aspect-ratio:1;border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-2)}
      .dsh-persona-upload-zone{display:flex;flex-direction:column;gap:12px;align-items:center;justify-content:center;padding:22px 14px;border:1px dashed var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md,12px);color:var(--dsw-alias-label-secondary);font-size:12px;text-align:center}
      .dsh-persona-upload-zone[data-dragging=true]{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-interactive-bg-hover)}
      .dsh-persona-upload-file{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
      @media(prefers-reduced-motion:no-preference){.dsh-persona-tile-frame{transition:background-color 120ms,border-color 120ms}.dsh-persona-tile:active{transform:scale(.98)}}
      @media(max-width:720px){.dsh-persona-library{width:calc(100vw - 24px);height:calc(100dvh - 32px);max-height:calc(100dvh - 32px)}.dsh-persona-library-header{padding:16px}.dsh-persona-library-title{flex-direction:column;align-items:flex-start;gap:2px}.dsh-persona-library-tools{padding:0 16px 12px;gap:10px}.dsh-persona-tabs{width:200px}.dsh-persona-library-body{grid-template-columns:minmax(0,1fr);overflow:auto;display:block}.dsh-persona-gallery-pane{min-height:180px;max-height:42dvh}.dsh-persona-gallery{grid-template-columns:repeat(auto-fill,minmax(88px,1fr));padding:16px;gap:12px}.dsh-persona-editor{border-left:0;border-top:1px solid var(--dsw-alias-border-l1);padding:16px;display:grid;grid-template-columns:100px minmax(0,1fr);align-items:start;gap:12px}.dsh-persona-detail-preview{height:100px}.dsh-persona-detail-preview img{height:92px}.dsh-persona-fields{grid-column:2;grid-row:1}.dsh-persona-editor-note{grid-column:2;grid-row:2}.dsh-persona-editor-buttons{grid-column:2;grid-row:3}.dsh-persona-editor h3{grid-column:1/-1}.dsh-persona-editor-buttons{margin-top:0}.dsh-persona-upload-zone{grid-column:1/-1}.dsh-persona-library-footer{padding:10px 16px}.dsh-persona-search{max-width:42%;width:auto}.dsh-persona-editor>.dsh-persona-detail-preview{grid-column:1;grid-row:1}.dsh-persona-editor[data-importing=true]{display:flex}.dsh-persona-editor>.dsh-persona-empty{grid-column:1/-1}}
    `;
    function icon(Component, size = 16) { return h(Component, { size, 'aria-hidden': true }); }
    function previewUrl(sessionId, id) { return `${STICKERS}/image?sessionId=${encodeURIComponent(sessionId)}&id=${id}`; }
    async function stickerRequest(sessionId, path = '', body, signal) {
      const response = await fetch(`${STICKERS}${path}${body ? '' : `?sessionId=${encodeURIComponent(sessionId)}`}`, {
        method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', signal,
        ...(body ? { headers: { 'Content-Type': 'application/json', 'x-dsh-task-personas-client': '1' }, body: JSON.stringify({ ...body, sessionId }) } : {}),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || '表情库操作失败');
      return result;
    }
    function Preview({ item, sessionId, detail = false }) {
      return h('div', { className: detail ? 'dsh-persona-detail-preview' : 'dsh-persona-tile-frame' },
        item.kind === 'image' ? h('img', { src: previewUrl(sessionId, item.id), alt: item.name, loading: detail ? 'eager' : 'lazy', decoding: 'async' })
          : h('span', { className: 'dsh-persona-native-placeholder' }, icon(PersonaIcon, detail ? 32 : 24), '飞书原生表情'));
    }
    function GroupBots({ sessionId, onClose }) {
      const [bots, setBots] = useState([]), [selected, setSelected] = useState([]), [busy, setBusy] = useState(true), [error, setError] = useState(null);
      useEffect(() => {
        const controller = new AbortController();
        void (async () => {
          try {
            const response = await fetch(`${SOCIAL}/bots`, { method: 'POST', credentials: 'same-origin', signal: controller.signal, headers: { 'Content-Type': 'application/json', 'x-dsh-task-personas-client': '1' }, body: JSON.stringify({ sessionId }) });
            const data = await response.json(); if (!response.ok || !data.ok) throw Error(data.error || '机器人读取失败');
            if (!controller.signal.aborted) { setBots(data.read.bots); setSelected(data.group.allowedBots.map(p => p.id)); publish(record(sessionId), { social: data }); }
          } catch (e) { if (!controller.signal.aborted) setError(e.message); }
          finally { if (!controller.signal.aborted) setBusy(false); }
        })();
        return () => controller.abort();
      }, [sessionId]);
      async function save() {
        setBusy(true); setError(null);
        try {
          const response = await fetch(SOCIAL, { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'x-dsh-task-personas-client': '1' }, body: JSON.stringify({ sessionId, allowedBotIds: selected }) });
          const data = await response.json(); if (!response.ok || !data.ok) throw Error(data.error || '保存失败，原选择已保留');
          publish(record(sessionId), { social: data, notice: '群机器人设置已保存。22:00–次日08:00暂停机器人互聊，真人照常。' }); onClose();
        } catch (e) { setError(e.message); setBusy(false); }
      }
      return h(Modal, { open: true, onClose, headless: true, title: '群机器人互聊', className: 'dsh-persona-bots' },
        h('div', { className: 'dsh-persona-bots-body' },
          h('div', { className: 'dsh-persona-library-title' }, h('h2', null, '群机器人'), h(Button, { size: 'sm', className: 'dsh-persona-icon-button', 'aria-label': '关闭', onClick: onClose }, icon(CloseIcon))),
          h('p', { className: 'dsh-persona-editor-note' }, '选择可以互聊的机器人。只对当前群生效；模型会自己决定是否接话。'),
          h('p', { className: 'dsh-persona-editor-note' }, '22:00–次日08:00（台北时间）不回应机器人，真人照常。'),
          error ? h('p', { role: 'alert', className: 'dsh-persona-error' }, error) : null,
          h('div', { className: 'dsh-persona-bots-list', 'aria-busy': busy }, bots.length ? bots.map(p => h('label', { key: p.id, className: 'dsh-persona-bot-row' },
            h('input', { type: 'checkbox', disabled: busy, checked: selected.includes(p.id), onChange: e => setSelected(previous => e.target.checked ? [...previous, p.id] : previous.filter(id => id !== p.id)) }),
            h('span', null, h('strong', null, p.name), h('code', null, p.id), p.sample ? h('small', null, p.sample) : null)))
            : h('p', { className: 'dsh-persona-editor-note' }, busy ? '正在读取本群机器人的消息…' : '最近消息中没有发现其他机器人。请确认已开通包含机器人消息的权限。')),
          h('div', { className: 'dsh-persona-actions' }, h(Button, { size: 'sm', onClick: onClose }, '取消'), h(Button, { size: 'sm', variant: 'primary', disabled: busy || !bots.length && !!error, onClick: () => void save() }, busy ? '读取中…' : '保存'))));
    }
    function StickerEditor({ item, sessionId, mutate, busy }) {
      const [name, setName] = useState(item.name);
      const [description, setDescription] = useState(item.description);
      const [confirmDelete, setConfirmDelete] = useState(false);
      const dirty = name !== item.name || description !== item.description;
      return h(React.Fragment, null,
        h(Preview, { item, sessionId, detail: true }),
        h('div', { className: 'dsh-persona-fields' },
          h('label', null, '名称', h('input', { value: name, maxLength: 80, disabled: busy, 'aria-label': '表情名称', onChange: e => setName(e.target.value) })),
          h('label', null, '适用场景', h('textarea', { value: description, maxLength: 500, rows: 3, disabled: busy, 'aria-label': '表情适用场景', placeholder: '例如：开心、收到、安慰', onChange: e => setDescription(e.target.value) }))),
        h('p', { className: 'dsh-persona-editor-note' }, item.scope.startsWith('仅') ? '收到的素材，仅在当前飞书会话使用。' : '本地素材，可供其他飞书人格会话使用。', item.kind === 'sticker' ? ' 原生表情暂不支持预览，请填写内容说明。' : ''),
        h('div', { className: 'dsh-persona-editor-buttons' },
          h(Button, { variant: 'primary', size: 'sm', disabled: busy || !name.trim() || item.saved && !dirty,
            onClick: () => mutate('/collect', { id: item.id, name, description, saved: true }, item.saved ? '更改已保存' : '已加入收藏') }, busy ? '保存中…' : item.saved ? '保存更改' : '收藏表情'),
          confirmDelete ? h('div', null, h('p', { className: 'dsh-persona-editor-note' }, '从表情库删除这张素材？'),
            h('div', { className: 'dsh-persona-actions' }, h(Button, { size: 'sm', className: 'dsh-persona-danger', disabled: busy, onClick: () => mutate('/remove', { id: item.id }, '表情已删除') }, '确认删除'),
              h(Button, { size: 'sm', disabled: busy, onClick: () => setConfirmDelete(false) }, '取消')))
            : h('div', { className: 'dsh-persona-actions' },
              item.saved ? h(Button, { size: 'sm', disabled: busy, onClick: () => mutate('/collect', { id: item.id, name, description, saved: false }, '已移到待收藏') }, '移出收藏') : h('span'),
              h(Button, { size: 'sm', className: 'dsh-persona-danger', disabled: busy, onClick: () => setConfirmDelete(true) }, item.saved ? '删除' : '忽略'))));
    }
    function UploadEditor({ busy, onUpload, onCancel }) {
      const picker = useRef(null);
      const [file, setFile] = useState(null);
      const [url, setUrl] = useState(null);
      const [name, setName] = useState('');
      const [description, setDescription] = useState('');
      const [error, setError] = useState(null);
      const [dragging, setDragging] = useState(false);
      useEffect(() => {
        if (!file) { setUrl(null); return; }
        const next = URL.createObjectURL(file); setUrl(next);
        return () => URL.revokeObjectURL(next);
      }, [file]);
      function choose(next) {
        setError(null); if (!next) return;
        if (next.size > 10 * 1024 * 1024) { setError('图片不能超过 10 MB'); return; }
        if (!/\.(png|jpe?g|webp|gif)$/i.test(next.name)) { setError('请选择 PNG、JPG、WEBP 或 GIF'); return; }
        setFile(next); setName(next.name.replace(/\.[^.]+$/, ''));
      }
      return h(React.Fragment, null, h('h3', null, '导入表情'),
        h('input', { hidden: true, ref: picker, type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', disabled: busy, 'aria-label': '选择本地图片', onChange: e => choose(e.target.files?.[0]) }),
        file && url ? h('div', { className: 'dsh-persona-detail-preview' }, h('img', { src: url, alt: file.name })) : null,
        h('div', { className: 'dsh-persona-upload-zone', 'data-dragging': dragging,
          onDragOver: e => { e.preventDefault(); if (!busy) setDragging(true); }, onDragLeave: () => setDragging(false),
          onDrop: e => { e.preventDefault(); setDragging(false); if (!busy) choose(e.dataTransfer.files?.[0]); } },
          file ? h('span', { className: 'dsh-persona-upload-file', title: file.name }, file.name) : h('span', null, '拖入图片，或选择本地文件'),
          h(Button, { variant: 'outline', size: 'sm', disabled: busy, onClick: () => picker.current?.click() }, file ? '重新选择' : '选择图片'),
          h('span', null, 'PNG / JPG / WEBP / GIF · 最大 10 MB')),
        file ? h('div', { className: 'dsh-persona-fields' },
          h('label', null, '名称', h('input', { value: name, maxLength: 80, disabled: busy, onChange: e => setName(e.target.value) })),
          h('label', null, '适用场景', h('textarea', { value: description, maxLength: 500, rows: 3, disabled: busy, placeholder: '告诉人格什么时候用这张图', onChange: e => setDescription(e.target.value) }))) : null,
        error ? h('p', { role: 'alert', className: 'dsh-persona-danger' }, error) : null,
        h('p', { className: 'dsh-persona-editor-note' }, '导入后加入收藏，其他飞书人格会话也可以使用。'),
        h('div', { className: 'dsh-persona-editor-buttons' },
          h(Button, { variant: 'primary', size: 'sm', disabled: busy || !file || !name.trim(), onClick: () => onUpload(file, name, description) }, busy ? '导入中…' : '导入并收藏'),
          h(Button, { size: 'sm', disabled: busy, onClick: onCancel }, '取消')));
    }
    function StickerLibrary({ sessionId, onClose }) {
      const controller = useRef(null);
      const mounted = useRef(true);
      const [data, setData] = useState(null);
      const [error, setError] = useState(null);
      const [notice, setNotice] = useState('');
      const [busy, setBusy] = useState(false);
      const [tab, setTab] = useState('saved');
      const [query, setQuery] = useState('');
      const [selected, setSelected] = useState(null);
      const [importing, setImporting] = useState(false);
      const items = data?.[tab] || [];
      const visible = useMemo(() => items.filter(item => `${item.name} ${item.description}`.toLocaleLowerCase().includes(query.toLocaleLowerCase().trim())), [items, query]);
      const item = visible.find(item => item.id === selected) || visible[0];
      async function refresh() {
        controller.current?.abort();
        const active = new AbortController(); controller.current = active;
        setError(null);
        try { const result = await stickerRequest(sessionId, '', undefined, active.signal); if (mounted.current && !active.signal.aborted) setData(result); }
        catch (e) { if (mounted.current && !active.signal.aborted) setError(e.message); }
      }
      useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false; controller.current?.abort(); }; }, [sessionId]);
      async function mutate(path, body, message) {
        if (busy) return;
        setBusy(true); setError(null); setNotice('');
        try {
          await stickerRequest(sessionId, path, body, controller.current?.signal);
          if (!mounted.current) return;
          await refresh(); setNotice(message);
        } catch (e) { if (mounted.current && e.name !== 'AbortError') setError(e.message); }
        finally { if (mounted.current) setBusy(false); }
      }
      async function upload(file, name, description) {
        if (busy) return;
        setBusy(true); setError(null); setNotice('');
        try {
          const encoded = await new Promise((resolve, reject) => {
            const reader = new FileReader(); reader.onerror = () => reject(new Error('本地图片读取失败'));
            reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.readAsDataURL(file);
          });
          if (!mounted.current) return;
          const result = await stickerRequest(sessionId, '/upload', { data: encoded, name, description }, controller.current?.signal);
          if (!mounted.current) return;
          setTab('saved'); setQuery(''); setSelected(result.item.id); setImporting(false);
          await refresh(); setNotice('表情已导入');
        } catch (e) { if (mounted.current && e.name !== 'AbortError') setError(e.message); }
        finally { if (mounted.current) setBusy(false); }
      }
      const close = () => { if (!busy) onClose(); };
      return h(Modal, { open: true, onClose: close, title: '飞书表情库', headless: true, className: 'dsh-persona-library' },
        h('div', { className: 'dsh-persona-shell' },
          h('header', { className: 'dsh-persona-library-header' },
            h('div', { className: 'dsh-persona-library-title' }, h('h2', null, '表情库'),
              data ? h('span', { className: 'dsh-persona-connection', 'data-connected': data.connected }, data.connected ? icon(ConnectedIcon, 14) : null, data.connected ? '飞书已连接' : '飞书未连接') : null),
            h('div', { className: 'dsh-persona-actions' },
              h(Button, { variant: 'outline', size: 'sm', icon: icon(PlusIcon, 14), disabled: busy || importing, onClick: () => setImporting(true) }, '导入表情'),
              h(Button, { size: 'sm', className: 'dsh-persona-icon-button', disabled: busy, 'aria-label': '关闭表情库', onClick: close }, icon(CloseIcon, 16)))),
          h('div', { className: 'dsh-persona-library-tools' },
            h(SegmentedTabs, { className: 'dsh-persona-tabs', label: '表情来源', value: tab,
              items: [{ value: 'saved', label: `已收藏 ${data?.saved.length || 0}` }, { value: 'candidates', label: `待收藏 ${data?.candidates.length || 0}` }],
              onChange: next => { setTab(next); setSelected(null); setImporting(false); setNotice(''); } }),
            h('label', { className: 'dsh-persona-search' }, icon(SearchIcon, 15),
              h('input', { type: 'search', value: query, 'aria-label': '搜索表情', placeholder: '搜索名称或场景', onChange: e => setQuery(e.target.value) }))),
          error ? h('div', { className: 'dsh-persona-alert', role: 'alert' }, error) : null,
          h('div', { className: 'dsh-persona-library-body' },
            h('section', { className: 'dsh-persona-gallery-pane', 'aria-label': tab === 'saved' ? '已收藏表情' : '待收藏表情' },
              tab === 'candidates' ? h('p', { className: 'dsh-persona-candidate-note' }, '在飞书向机器人发图片、GIF 或表情后刷新。群聊需要 @ 机器人；收藏后才会使用。') : null,
              !data && !error ? h('div', { className: 'dsh-persona-gallery', role: 'status', 'aria-label': '正在读取表情库' }, ...Array.from({ length: 6 }, (_, key) => h('div', { key, className: 'dsh-persona-skeleton' })))
                : visible.length ? h('ul', { className: 'dsh-persona-gallery' }, ...visible.map(entry => h('li', { key: entry.id },
                  h('button', { type: 'button', className: 'dsh-persona-tile', 'aria-label': entry.name, 'aria-pressed': !importing && item?.id === entry.id,
                    onClick: () => { setSelected(entry.id); setImporting(false); setNotice(''); } },
                    h(Preview, { item: entry, sessionId }),
                    h('span', { className: 'dsh-persona-tile-caption' }, h('span', { className: 'dsh-persona-tile-name', title: entry.name }, entry.name),
                      entry.mime === 'image/gif' ? h('span', { className: 'dsh-persona-tile-meta' }, 'GIF') : null,
                      !importing && item?.id === entry.id ? icon(CheckIcon, 12) : null)))))
                  : h('div', { className: 'dsh-persona-empty' }, icon(PersonaIcon, 28),
                    h('strong', null, query.trim() ? '没有匹配的表情' : error ? '暂时无法读取表情库' : tab === 'saved' ? '收藏第一张表情' : '还没有收到素材'),
                    h('p', null, query.trim() ? '试试其他名称或场景。' : tab === 'saved' ? '从本地导入，或从待收藏中挑选。' : '收到的图片和表情会出现在这里。'),
                    query.trim() ? h(Button, { size: 'sm', onClick: () => setQuery('') }, '清除搜索') : null)),
            h('aside', { className: 'dsh-persona-editor', 'data-importing': importing, 'aria-label': importing ? '导入表情' : '编辑表情' },
              importing ? h(UploadEditor, { busy, onUpload: upload, onCancel: () => setImporting(false) })
                : item ? h(StickerEditor, { key: `${item.id}:${item.name}:${item.description}:${item.saved}`, item, sessionId, mutate, busy })
                  : h('div', { className: 'dsh-persona-empty' }, '选中一张表情，编辑名称和适用场景。'))),
          h('footer', { className: 'dsh-persona-library-footer' },
            h('span', { role: 'status' }, busy ? '正在保存…' : notice || `${items.length} 张表情 · 启用人格后可使用`),
            h(Button, { size: 'sm', icon: icon(RefreshIcon, 13), disabled: busy, onClick: () => void refresh() }, '刷新'))));
    }
    function PersonaSelector({ sessionId, useSessions, placement }) {
      const row = record(sessionId);
      const [open, setOpen] = useState(false);
      const trigger = useRef(null);
      const [libraryOpen, setLibraryOpen] = useState(false);
      const [botsOpen, setBotsOpen] = useState(false);
      const blank = useSessions(state => state.byId[sessionId]?.blank === true);
      const value = useSyncExternalStore(
        React.useCallback(listener => { row.listeners.add(listener); return () => row.listeners.delete(listener); }, [row]),
        React.useCallback(() => row.value, [row]));
      useEffect(() => {
        void request(sessionId);
        const refresh = () => { if (!row.value.saving) void request(sessionId); };
        window.addEventListener('focus', refresh);
        return () => window.removeEventListener('focus', refresh);
      }, [sessionId, row]);
      useEffect(() => { setOpen(false); setLibraryOpen(false); setBotsOpen(false); }, [sessionId]);
      if (placement === 'conversation.input.left' && blank) return null;
      const current = value.personas.find(role => role.id === value.personaId);
      const summaries = { whale: '俏皮嘴硬，像熟悉的网友', tsundere: '嘴硬心软，认真帮你做事' };
      const items = [{ id: 'title', type: 'label', text: '当前会话人格' },
        { id: 'off', label: h('span', { className: 'dsh-persona-option' }, '关闭', h('small', null, '使用默认身份与语气')) },
        ...value.personas.map(role => ({ id: role.id, label: h('span', { className: 'dsh-persona-option' }, role.name, h('small', null, summaries[role.id])) }))];
      return h('span', { className: 'dsh-persona-control', 'data-task-personas': '' },
        h(Menu, { open, onClose: () => setOpen(false), items, selectedId: value.personaId || 'off',
          portal: true, side: placement === 'conversation.hero.options' ? 'bottom' : 'top', align: 'start', autoFocus: true, listClassName: 'dsh-persona-menu',
          footer: value.feishu ? [...(value.personaId ? [{ id: 'proactive', label: `主动聊天 · ${(value.social?.proactiveEnabled ?? true) ? '已开启' : '已关闭'}` },
            ...(value.social?.group?.available ? [{ id: 'group', label: `自主参与群聊 · ${value.social.group.enabled ? '已开启' : '已关闭'}` }, ...(value.social.group.enabled ? [{ id: 'read-group', label: '补读接入后群消息' }, { id: 'bots', label: `群机器人 · ${value.social.group.allowedBots?.length || 0} 个可互聊` }] : [])] : [])] : []), { id: 'library', label: '表情库' }] : undefined,
          onSelect: id => { setOpen(false); if (id === 'library') { trigger.current?.focus(); setLibraryOpen(true); } else if (id === 'bots') setBotsOpen(true); else if (id === 'read-group') void readGroup(sessionId); else if (id === 'proactive' || id === 'group') void toggleProactive(sessionId, id === 'group'); else void request(sessionId, id === 'off' ? null : id, true); },
          anchor: h(Button, { ref: trigger, size: 'sm', className: 'dsh-persona-trigger', icon: icon(PersonaIcon, 16),
            'aria-label': `当前会话人格：${current?.name || '关闭'}`, 'aria-haspopup': 'menu', 'aria-expanded': open,
            title: value.error || '人格仅影响当前会话，从下一次模型请求生效', disabled: !value.ready || value.saving,
            onClick: () => setOpen(previous => !previous) },
            h('span', { className: 'dsh-persona-trigger-label' }, value.saving ? '保存中…' : current?.name || '人格'), icon(ChevronIcon, 12)),
        }, h('p', { className: 'dsh-persona-menu-note' }, value.notice || value.social?.error || (value.social?.group?.available && value.personaId
          ? value.social.group.enabled ? '只对本群生效。群消息全部交给模型阅读，自行决定是否接话；22:00–次日08:00不回应机器人，真人照常。' : '开启后无需 @，群消息全部交给模型阅读，自行决定是否接话；其他群不受影响。'
          : value.feishu && value.personaId ? '只对当前会话生效。冷场时偶尔主动开聊，夜间降低频率；关闭人格即停止。' : '仅当前会话生效，新会话默认关闭。'))),
        libraryOpen && value.feishu ? h(StickerLibrary, { key: sessionId, sessionId, onClose: () => { setLibraryOpen(false); queueMicrotask(() => trigger.current?.focus()); } }) : null,
        botsOpen ? h(GroupBots, { key: sessionId, sessionId, onClose: () => { setBotsOpen(false); queueMicrotask(() => trigger.current?.focus()); } }) : null,
        value.error ? h(Button, { size: 'sm', className: 'dsh-persona-error', title: value.error, onClick: () => void request(sessionId) }, '读取失败，重试') : null);
    }
    return {
      inject: ['slots'],
      apply(ctx) {
        disposed = false;
        const style = document.createElement('style'); style.dataset.taskPersonasStyle = ''; style.textContent = CSS;
        document.head.appendChild(style);
        for (const slot of ['conversation.hero.options', 'conversation.input.left']) {
          ctx.slots.inject(slot, () => ctx.slots.register({ name: slot, id: 'task-personas', order: 25 }, props => h(PersonaSelector, { ...props, placement: slot })));
        }
        ctx.effect(() => () => {
          disposed = true; style.remove();
          for (const row of records.values()) { row.controller?.abort(); row.listeners.clear(); }
          records.clear();
        });
      },
    };
  },
});
