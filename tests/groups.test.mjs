import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { PersonaStore } from '../lib/personas.js';
import { StickerLibrary, StickerBridge } from '../lib/stickers.js';
import { SocialStore, SocialController } from '../lib/social.js';
import { registerSocial } from '../lib/index.js';
import { createFeishuChannel, summarizeFeishuGroupMessage } from '../im-connect/lib/channels/feishu.js';
const MINUTE = 60_000;
function fixture(t, random = () => 0) {
 const dir=mkdtempSync(join(tmpdir(),'dsh-groups-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const personas=new PersonaStore(join(dir,'personas.json'));personas.set('group','whale');personas.set('dm','whale');
 let bindings={a:{sessionId:'group',channel:'feishu_test',chatId:'group-chat',kind:'group'},b:{sessionId:'dm',channel:'feishu_test',chatId:'dm-chat',kind:'dm'}};
 const ctx={agents:{get(){}},logger(){return {warn(){}}}};
 const library=new StickerLibrary(dir,{readBindings:()=>bindings}),media=new StickerBridge(ctx,personas,library),store=new SocialStore(join(dir,'social.json'));
 let time=10_000_000;const queued=[];
 const social=new SocialController(ctx,personas,media,store,{now:()=>time,random,wake:async(id,message,current)=>{if(!current())return false;queued.push({id,message});return true;}});media.social=social;t.after(()=>social.dispose());
 const receive=(extra={})=>media.captureGroupMessage({accountId:'feishu_test',chatId:'group-chat',messageId:'m1',userId:'person-a',text:'小鲸鱼来吃瓜',addressed:false,...extra});
 return {personas,media,store,social,queued,receive,advance(ms){time+=ms;},setTime(ms){time=ms;},setBindings(v){bindings=v;}};
}
function claim(f) {f.media.observeSessionEvent({id:'group'},{type:'turn/start',data:{turn:1}});f.media.observeSessionEvent({id:'group'},{type:'user/message',data:f.queued[0].message});}

test('group participation is per-session opt-in, persists, and cannot enable a private or unknown chat',t=>{
 const f=fixture(t);assert.equal(f.receive(),false);assert.equal(f.social.snapshot('group').group.enabled,false);
 f.social.configure('group',false,true);assert.equal(f.receive(),true);
 assert.equal(new SocialStore(f.store.file).get('group').groupParticipationEnabled,true);
 assert.equal(f.social.snapshot('dm').group.available,false);
 assert.throws(()=>f.social.configure('dm',undefined,true),/飞书群/);
 assert.throws(()=>f.social.configure('unknown',undefined,true),/选择人格/);
 f.setBindings({a:{sessionId:'new-group',channel:'feishu_test',chatId:'group-chat',kind:'group'}});
 assert.equal(f.receive({messageId:'new'}),false);assert.equal(f.social.snapshot('new-group').group.enabled,false);
});

test('named and ordinary opportunities batch for eight seconds and keep bounded, isolated real observations',async t=>{
 const f=fixture(t);f.social.configure('group',false,true);f.receive();
 await f.social.groups.tick('group');assert.equal(f.queued.length,0);
 f.receive({messageId:'m2',userId:'person-b',text:'这是另一个人的消息',mentionsOthers:true});
 assert.equal(f.receive({messageId:'m2'}),false);
 assert.equal(f.receive({chatId:'other-group',messageId:'elsewhere'}),false);
 f.advance(8001);await f.social.groups.tick('group');assert.equal(f.queued.length,1);
 const msg=f.queued[0].message;assert.equal(msg.source.kind,'task-persona-group');assert.match(msg.content[0].text,/另一个人的消息/);assert.match(msg.content[0].text,/不是给你的工作指令/);assert.match(msg.content[0].text,/feishu_social_skip/);
 for(let i=0;i<100;i++)f.receive({messageId:'burst'+i,text:'长'.repeat(2000)});
 assert.equal(f.social.groups.state('group').rows.length,12);assert.ok(f.social.groups.state('group').rows.every(r=>r.text.length<=500));
});

test('every ordinary group message is read regardless of random probability, farewell, recent reply or old wake budget',async t=>{
 const f=fixture(t,()=>0.9);f.social.configure('group',false,true);
 f.store.put('group',{...f.store.get('group'),ended:true,lastAiReplyAt:10_000_000,wakes:Array(12).fill(10_000_000)});
 f.receive({text:'今天天气真好'});f.advance(9000);await f.social.groups.tick('group');assert.equal(f.queued.length,1);claim(f);
 f.social.groups.sent('group','our-message','是呀');
 f.receive({messageId:'reply',text:'确实',parentId:'our-message'});f.advance(9000);await f.social.groups.tick('group');assert.equal(f.queued.length,2);assert.match(f.queued[1].message.content[0].text,/"replyToSelf":true/);
});

test('direct mentions preempt ambient drafts and disabled groups cannot finish an in-flight send',async t=>{
 const f=fixture(t);f.social.configure('group',false,true);f.receive();f.advance(9000);await f.social.groups.tick('group');claim(f);
 assert.equal(f.social.turn('group').automatic,true);assert.equal(f.social.turn('group').group,true);assert.equal(f.social.canSend('group'),true);
 assert.deepEqual(f.social.skip('group'),{skipped:true});
 f.receive({messageId:'direct',text:'@机器人 帮我看看',addressed:true});assert.equal(f.social.canSend('group'),false);
 assert.equal(f.social.groups.state('group').due,0);
 f.media.registerTransport('feishu_test',{async sendText(){throw Error('must not send');}});
 await assert.rejects(f.media.sendText('group',['旧草稿'],new AbortController().signal),/会话或人格已变化/);
});

test('group participation is independent from idle proactive switch and obeys automatic text bounds',async t=>{
 const f=fixture(t);f.social.configure('group',false,true);f.receive();f.advance(9000);await f.social.groups.tick('group');claim(f);
 const calls=[];f.media.registerTransport('feishu_test',{async sendText(chat,text,_s,check){check();calls.push({chat,text});return {messageId:'sent'+calls.length};}});
 await f.media.sendText('group',['一句接梗'],new AbortController().signal);assert.equal(calls.length,1);assert.equal(f.store.get('group').followupAt,0);
 f.social.configure('group',undefined,false);assert.equal(f.social.canSend('group'),false);assert.equal(f.social.groups.states.has('group'),false);
});

test('busy groups retain unread input beyond two minutes and deliver it when the owner becomes idle',async t=>{
 const f=fixture(t);f.social.configure('group',false,true);f.receive();f.advance(9000);
 f.social.registerRuntime({wake:async()=>false});await f.social.groups.tick('group');assert.equal(f.queued.length,0);assert.equal(f.social.pending.size,0);
 f.advance(3*MINUTE);await f.social.groups.tick('group');assert.equal(f.social.snapshot('group').group.unread,1);
 f.social.registerRuntime({wake:async(id,message,current)=>{if(current())f.queued.push({id,message});return current();}});
 await f.social.groups.tick('group');assert.equal(f.queued.length,1);assert.equal(f.social.snapshot('group').group.unread,1,'ack only after the native user/message event');claim(f);assert.equal(f.social.snapshot('group').group.unread,0);
 f.social.groups.clear('group');assert.equal(f.social.snapshot('group').group.buffered,0);
 f.receive({messageId:'fresh'});f.setBindings({});await f.social.tick();assert.equal(f.social.groups.states.size,0);
});

test('a burst larger than recent context reaches the model in full, including input arriving during async wake',async t=>{
 const f=fixture(t,()=>1);f.social.configure('group',false,true);
 for(let i=0;i<105;i++)assert.equal(f.receive({messageId:'all-'+i,text:'群消息-'+i}),true);
 assert.equal(f.social.groups.state('group').rows.length,12);assert.equal(f.social.groups.state('group').unread.length,105);
 f.advance(9000);let release;
 f.social.registerRuntime({wake:async(id,message,current)=>{await new Promise(r=>release=r);if(current())f.queued.push({id,message});return current();}});
 const waiting=f.social.groups.tick('group');f.receive({messageId:'during-wake',text:'恢复时新来的消息'});release();await waiting;
 const consume=()=>{const message=f.queued.at(-1).message;f.media.observeSessionEvent({id:'group'},{type:'turn/start',data:{turn:f.queued.length}});f.media.observeSessionEvent({id:'group'},{type:'user/message',data:message});};consume();
 f.social.registerRuntime({wake:async(id,message,current)=>{if(current())f.queued.push({id,message});return current();}});
 while(f.social.groups.state('group').unread.length){await f.social.groups.tick('group');consume();}
 const rows=f.queued.flatMap(x=>{const text=x.message.content[0].text;const start=text.indexOf('\n[')+1,end=text.indexOf('\n【本轮边界】');return JSON.parse(text.slice(start,end)).filter(r=>r.new);});
 assert.equal(rows.length,106);assert.equal(new Set(rows.map(r=>r.messageId)).size,106);assert.ok(rows.some(r=>r.messageId==='all-0'));assert.ok(rows.some(r=>r.messageId==='during-wake'));
 assert.equal(f.queued.length,3,'all 106 messages read in three bounded batches, with no minute/hour gate');
});

test('direct mentions cancel an unconsumed draft but preserve older unread messages for the next decision',async t=>{
 const f=fixture(t);f.social.configure('group',false,true);f.receive({text:'普通消息应该被读到'});f.advance(9000);await f.social.groups.tick('group');
 assert.equal(f.social.pending.size,1);f.receive({messageId:'direct',text:'@机器人 现在看我',addressed:true});assert.equal(f.social.pending.size,0);assert.equal(f.social.groups.state('group').unread.length,1);
 f.advance(9000);await f.social.groups.tick('group');assert.equal(f.queued.length,2);assert.match(f.queued[1].message.content[0].text,/普通消息应该被读到/);
});

test('night transition drops pending bot chatter while ordinary human messages still reach the model',async t=>{
 const f=fixture(t);f.setTime(Date.parse('2026-10-22T21:59:55+08:00'));f.social.configure('group',false,true);
 f.social.groups.state('group').bots=[{id:'ou_fixture_bot',ids:['ou_fixture_bot'],name:'测试机器人'}];f.social.configure('group',undefined,undefined,['ou_fixture_bot']);
 f.receive({messageId:'night-bot',bot:true,botId:'ou_fixture_bot',text:'机器人夜间不应接话'});f.receive({messageId:'night-human',text:'真人仍然可以聊'});
 f.advance(9000);await f.social.groups.tick('group');const m=f.queued[0].message;assert.ok(!m.source.botTriggered);assert.match(m.content[0].text,/真人仍然可以聊/);assert.ok(!m.content[0].text.includes('机器人夜间不应接话'));
 claim(f);assert.equal(f.social.canSend('group'),true);assert.equal(f.social.groups.state('group').unread.length,0);
});

test('pending group wakes are invalidated if selection changes during native resume',async t=>{
 const f=fixture(t);f.social.configure('group',false,true);f.receive();f.advance(9000);
 let release;f.social.registerRuntime({wake:async(_id,_msg,current)=>{await new Promise(r=>release=r);return current();}});
 const pending=f.social.groups.tick('group');await Promise.resolve();f.personas.set('group',null);f.social.selectionChanged('group');release();assert.equal(await pending,false);assert.equal(f.social.pending.size,0);
});

test('group settings API authenticates writes, rejects private/invalid inputs and preserves prior state after disk failure',async t=>{
 const f=fixture(t);let route;registerSocial({effect:fn=>fn(),webServer:{register(r){route=r;}},connection:{requestRejection:req=>req.headers.cookie==='signed-in'?undefined:401}},f.social);
 const server=createServer((req,res)=>route.handler(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(r=>server.close(r)));
 const url=`http://127.0.0.1:${server.address().port}/api/dsh-task-personas/social`,headers={'content-type':'application/json',cookie:'signed-in','x-dsh-task-personas-client':'1'};
 const put=(body,h=headers)=>fetch(url,{method:'PUT',headers:h,body:JSON.stringify(body)});
 assert.equal((await put({sessionId:'group',groupParticipationEnabled:true},{'content-type':'application/json'})).status,401);
 for(const body of [{sessionId:'dm',groupParticipationEnabled:true},{sessionId:'group',groupParticipationEnabled:'true'},{sessionId:'group',groupParticipationEnabled:true,chatId:'elsewhere'}])assert.equal((await put(body)).status,400);
 assert.equal((await put({sessionId:'group',groupParticipationEnabled:true})).status,200);
 f.store.writer=()=>{throw Error('disk full');};assert.equal((await put({sessionId:'group',groupParticipationEnabled:false})).status,503);assert.equal(f.store.get('group').groupParticipationEnabled,true);
});

test('Feishu group transport observes non-at user messages without injecting them as user tasks, fetching files, or echoing bots',async()=>{
 const observations=[],received=[];let events,downloads=0;
 const bridge={captureGroupMessage(x){observations.push(x);},registerTransport(){return ()=>{};}};
 class Client {im={messageResource:{get(){downloads++;throw Error('must not fetch');}}};async request(){return {bot:{open_id:'self'}};}}
 class EventDispatcher{register(x){events=x;return this;}}class WSClient{async start(){}close(){}}
 const sdk={Client,EventDispatcher,WSClient,defaultHttpInstance:{request(){}},LoggerLevel:{error:1}};
 const host={get(){return bridge;}};
 const ch=createFeishuChannel('feishu',{appId:'fake',appSecret:'fake',accountId:'feishu_test',host},()=>{},async()=>sdk);ch.setMessageHandler(x=>received.push(x));await ch.start();
 try{
 const send=async(sender_type='user',open_id='human',extra={})=>events['im.message.receive_v1']({sender:{sender_type,sender_id:{open_id}},message:{chat_id:'group-chat',chat_type:'group',message_id:'one',message_type:'text',content:JSON.stringify({text:'小鲸鱼你觉得呢'}),...extra}});
 await send();assert.equal(observations.length,1);assert.equal(received.length,0);assert.equal(observations[0].addressed,false);
 await send('app','another-bot');await send('user','self');assert.equal(observations.length,1);
 await send('user','human',{message_type:'image',content:JSON.stringify({image_key:'sensitive-key'})});assert.equal(downloads,0);assert.match(observations[1].text,/未读取内容/);
 await send('user','human',{mentions:[{key:'@_user_1',id:{open_id:'self'}}],content:JSON.stringify({text:'@_user_1'})});assert.equal(received.length,1);assert.ok(!received[0].text.includes('@_user_1'));assert.equal(received[0].addressed,true);
 }finally{await ch.stop();}
 assert.equal(summarizeFeishuGroupMessage({message_type:'text',content:'bad'},'self'),'');
 assert.equal(summarizeFeishuGroupMessage({message_type:'file',content:'{}'},'self'),'[群文件，未下载]');
});

test('bot history reader enforces the current chat, time window, pagination bounds and hides SDK request details',async()=>{
 const {readFeishuGroupHistory}=await import('../im-connect/lib/channels/feishu.js');
 const since=1704081600000,until=since+100000,calls=[];
 const client={im:{message:{async list(args){calls.push(args);return {code:0,data:{has_more:false,items:[
  {message_id:'old',chat_id:'oc_target',create_time:String(since-1),sender:{id:'human',sender_type:'user'},msg_type:'text',body:{content:'{"text":"old private context"}'}},
  {message_id:'other',chat_id:'oc_other',create_time:String(since+10),sender:{id:'human',sender_type:'user'},msg_type:'text',body:{content:'{"text":"different group"}'}},
  {message_id:'ok',chat_id:'oc_target',create_time:String(since+1000),sender:{id:'human',sender_type:'user'},msg_type:'text',body:{content:'{"text":"hello group"}'}},
  {message_id:'bot',chat_id:'oc_target',create_time:String(since+2000),sender:{id:'bot',sender_type:'app'},msg_type:'text',body:{content:'{"text":"bot echo"}'}},
 ]}};}}}};
 const result=await readFeishuGroupHistory(client,'oc_target',since,until,new AbortController().signal,()=>{});
 assert.equal(calls.length,1);assert.equal(calls[0].params.container_id,'oc_target');assert.equal(calls[0].params.start_time,String(Math.ceil(since/1000)));
 assert.equal(result.readCount,2);assert.equal(result.rows.length,1);assert.equal(result.rows[0].text,'hello group');
 const denied={im:{message:{async list(){throw {response:{data:{code:99991672,msg:'permission denied'}},config:{headers:{Authorization:'SECRET'}}};}}}};
 await assert.rejects(readFeishuGroupHistory(denied,'oc_target',since,until,new AbortController().signal,()=>{}),e=>e.status===403 && !e.message.includes('SECRET') && /im:message.group_msg/.test(e.message));
});

test('manual catch-up uses the durable session start and queues historical context without creating a user task',async t=>{
 const f=fixture(t),since=1704081600000,id=`im:feishu_test:group:${since}:oc_target`;
 f.advance(since-10_000_000+100000);f.setBindings({a:{sessionId:id,channel:'feishu_test',chatId:'oc_target',kind:'group'}});f.personas.set(id,'whale');f.social.configure(id,false,true);
 let range;f.media.registerTransport('feishu_test',{async readGroupHistory(chat,start,end,_signal,current){current();range={chat,start,end};return {readCount:2,hasMore:false,rows:[{messageId:'old',userId:'human',time:start-1,text:'must never enter'},{messageId:'new',userId:'human',time:start+1000,text:'小鲸鱼你好'}]};}});
 const result=await f.social.groups.readHistory(id);assert.equal(range.start,since);assert.equal(range.chat,'oc_target');assert.equal(result.queued,true);assert.equal(f.queued[0].message.source.kind,'task-persona-group');assert.equal(f.queued[0].message.source.summary,'补读接入后群消息');
 assert.match(f.queued[0].message.content[0].text,/不逐条补答旧消息/);assert.ok(!f.queued[0].message.content[0].text.includes('must never enter'));
 await assert.rejects(f.social.groups.readHistory(id),e=>e.status===429);
});

test('manual group history endpoint rejects anonymous requests and cannot accept a supplied recipient or time boundary',async t=>{
 const f=fixture(t);let route,reads=0;f.social.groups.readHistory=async()=>{reads++;return {readCount:1,contextCount:1,hasMore:false};};
 registerSocial({effect:fn=>fn(),webServer:{register(r){route=r;}},connection:{requestRejection:req=>req.headers.cookie==='signed-in'?undefined:401}},f.social);
 const server=createServer((req,res)=>route.handler(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(r=>server.close(r)));
 const url=`http://127.0.0.1:${server.address().port}/api/dsh-task-personas/social/read-group`,headers={'content-type':'application/json',cookie:'signed-in','x-dsh-task-personas-client':'1'};
 const post=(body,h=headers)=>fetch(url,{method:'POST',headers:h,body:JSON.stringify(body)});
 assert.equal((await post({sessionId:'group'},{'content-type':'application/json'})).status,401);
 assert.equal((await post({sessionId:'group',chatId:'oc_other'})).status,400);assert.equal((await post({sessionId:'group',since:0})).status,400);assert.equal(reads,0);
 assert.equal((await post({sessionId:'group'})).status,200);assert.equal(reads,1);
});

test('bot quiet time uses Taipei and enforces both boundaries across midnight',async()=>{
 const {botQuietHours}=await import('../lib/groups.js');
 for(const [stamp,quiet] of [['2026-10-22T21:59:59+08:00',false],['2026-10-22T22:00:00+08:00',true],['2026-10-23T00:00:00+08:00',true],['2026-10-23T07:59:59+08:00',true],['2026-10-23T08:00:00+08:00',false]])assert.equal(botQuietHours(Date.parse(stamp)),quiet,stamp);
});

test('approved bot aliases persist per group, do not inherit to new groups and disk failure keeps the selection',t=>{
 const f=fixture(t);f.social.configure('group',false,true);
 f.social.groups.state('group').bots=[{id:'ou_fixture_bot',ids:['cli_fixture_bot','ou_fixture_bot'],name:'测试机器人'}];
 f.social.configure('group',undefined,undefined,['ou_fixture_bot']);
 assert.deepEqual(new SocialStore(f.store.file).get('group').allowedBots[0].ids,['cli_fixture_bot','ou_fixture_bot']);
 assert.equal(f.media.acceptsGroupBot({accountId:'feishu_test',chatId:'group-chat',botId:'cli_fixture_bot'}),true);
 assert.equal(f.media.acceptsGroupBot({accountId:'feishu_test',chatId:'dm-chat',botId:'cli_fixture_bot'}),false);
 assert.throws(()=>f.social.configure('group',undefined,undefined,['invented']),/读取本群/);
 f.store.writer=()=>{throw Error('disk full');};assert.throws(()=>f.social.configure('group',undefined,undefined,[]),/disk full/);assert.equal(f.store.get('group').allowedBots.length,1);
 f.setBindings({a:{sessionId:'new-group',channel:'feishu_test',chatId:'group-chat',kind:'group'}});f.personas.set('new-group','whale');f.store.writer=()=>{};f.social.configure('new-group',false,true);
 assert.equal(f.media.acceptsGroupBot({accountId:'feishu_test',chatId:'group-chat',botId:'ou_fixture_bot'}),false);
});

test('bot chat has no two-turn or thirty-second cooldown and cannot become a human task; in-flight night transition blocks sends',async t=>{
 const f=fixture(t,()=>0.99);f.setTime(Date.parse('2026-10-22T21:50:00+08:00'));f.social.configure('group',false,true);
 f.social.groups.state('group').bots=[{id:'ou_fixture_bot',ids:['cli_fixture_bot','ou_fixture_bot'],name:'测试机器人'}];f.social.configure('group',undefined,undefined,['ou_fixture_bot']);
 const base={bot:true,botId:'ou_fixture_bot',userId:'ou_fixture_bot',addressed:true,text:'我来接话了'};
 assert.equal(f.receive({...base,botId:'unknown'}),false);
 for(let i=0;i<4;i++){
  assert.equal(f.receive({...base,messageId:'bot-'+i}),true);f.advance(8001);assert.equal(await f.social.groups.tick('group'),true);
  const message=f.queued.at(-1).message;assert.equal(message.source.botTriggered,true);assert.equal(message.source.kind,'task-persona-group');
  f.media.observeSessionEvent({id:'group'},{type:'turn/start',data:{turn:i+1}});f.media.observeSessionEvent({id:'group'},{type:'user/message',data:message});
  assert.equal(f.social.canSend('group'),true);f.social.sent('group');
 }
 assert.equal(f.queued.length,4);assert.equal(f.store.get('group').wakes.length,0,'bot turns do not consume the human ambient wake budget');
 f.setTime(Date.parse('2026-10-22T22:00:00+08:00'));assert.equal(f.social.canSend('group'),false);
 assert.equal(f.receive({...base,messageId:'night'}),false);
 f.media.registerTransport('feishu_test',{async sendText(){throw Error('must not send after ten');}});
 await assert.rejects(f.media.sendText('group',['迟到的接话'],new AbortController().signal),/会话或人格已变化/);
 assert.equal(f.receive({messageId:'human',addressed:true,text:'小鲸鱼帮我'}),true);
 f.media.observeSessionEvent({id:'group'},{type:'turn/start',data:{turn:5}});f.media.observeSessionEvent({id:'group'},{type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text:'小鲸鱼帮我'}]}});
 assert.equal(f.social.canSend('group'),true,'humans are unaffected');
 f.setTime(Date.parse('2026-10-23T08:00:00+08:00'));assert.equal(f.receive({...base,messageId:'morning'}),true);
});

test('bot discovery reads identities without waking a model; native history requires an approved alias',async t=>{
 const {readFeishuGroupHistory}=await import('../im-connect/lib/channels/feishu.js');
 const f=fixture(t),since=1704081600000,id=`im:feishu_test:group:${since}:oc_target`;f.setTime(since+100000);
 f.setBindings({a:{sessionId:id,channel:'feishu_test',chatId:'oc_target',kind:'group'}});f.personas.set(id,'whale');f.social.configure(id,false,true);
 const item=(sender,message_id,text)=>({message_id,chat_id:'oc_target',create_time:String(since+1000),sender,msg_type:'interactive',body:{content:JSON.stringify({elements:[{tag:'markdown',content:text}],actions:[{value:'must-not-read'}]})}});
 const client={im:{message:{async list(){return {code:0,data:{items:[item({id:'cli_self',sender_type:'app'},'self','echo'),item({id:'cli_fixture_bot',open_bot_id:'ou_fixture_bot',sender_type:'app',sender_name:'测试机器人'},'fixture-bot','测试机器人已收到消息'),item({sender_type:'bot'},'missing','must-not-read')]}};}}}};
 f.media.registerTransport('feishu_test',{readGroupHistory:(chat,start,end,signal,current,allowedBotIds)=>readFeishuGroupHistory(client,chat,start,end,signal,current,'ou_self',{selfAppId:'cli_self',allowedBotIds})});
 const result=await f.social.groups.readHistory(id,true);assert.equal(f.queued.length,0);assert.equal(result.bots.length,1);assert.equal(result.bots[0].name,'测试机器人');assert.match(result.bots[0].sample,/测试机器人已收到消息/);
 assert.equal(f.social.groups.state(id).due,0);f.social.configure(id,undefined,undefined,['ou_fixture_bot']);
 const read=await f.social.groups.readHistory(id);assert.equal(read.contextCount,1);assert.equal(read.queued,true);assert.match(f.queued[0].message.content[0].text,/测试机器人已收到消息/);assert.ok(!f.queued[0].message.content[0].text.includes('must-not-read'));
});

test('transport accepts approved app/bot senders only as observations even when they mention us',async()=>{
 const seen=[],received=[];let events;
 const bridge={acceptsGroupBot:input=>input.botId==='ou_fixture_bot',captureGroupMessage:x=>seen.push(x)};
 class Client{async request(){return {bot:{open_id:'self'}};}}class EventDispatcher{register(x){events=x;return this;}}class WSClient{async start(){}close(){}}
 const sdk={Client,EventDispatcher,WSClient,defaultHttpInstance:{request(){}},LoggerLevel:{error:1}};
 const ch=createFeishuChannel('feishu',{appId:'fake',appSecret:'fake',host:{get:()=>bridge}},()=>{},async()=>sdk);ch.setMessageHandler(x=>received.push(x));await ch.start();
 try{for(const [sender_type,open_id] of [['bot','ou_fixture_bot'],['app','ou_fixture_bot'],['app','unknown'],['bot','self']])await events['im.message.receive_v1']({sender:{sender_type,sender_id:{open_id}},message:{message_id:sender_type+open_id,chat_id:'group',chat_type:'group',message_type:'text',content:'{"text":"@me hi"}',mentions:[{key:'@me',id:{open_id:'self'}}]}});
 assert.equal(seen.length,2);assert.equal(received.length,0);assert.ok(seen.every(x=>x.bot&&x.botId==='ou_fixture_bot'));}finally{await ch.stop();}
});

test('bot discovery and selection endpoints authenticate and reject invented peers or recipients',async t=>{
 const f=fixture(t);f.social.configure('group',false,true);f.social.groups.state('group').bots=[{id:'ou_fixture_bot',ids:['ou_fixture_bot'],name:'测试机器人'}];
 let route,reads=0;f.social.groups.readHistory=async(_id,discovery)=>{assert.equal(discovery,true);reads++;return {bots:[]};};
 registerSocial({effect:fn=>fn(),webServer:{register(r){route=r;}},connection:{requestRejection:req=>req.headers.cookie==='signed-in'?undefined:401}},f.social);
 const server=createServer((req,res)=>route.handler(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(r=>server.close(r)));
 const url=`http://127.0.0.1:${server.address().port}/api/dsh-task-personas/social`,headers={'content-type':'application/json',cookie:'signed-in','x-dsh-task-personas-client':'1'};
 const send=(path,method,body,h=headers)=>fetch(url+path,{method,headers:h,body:JSON.stringify(body)});
 assert.equal((await send('/bots','POST',{sessionId:'group'},{'content-type':'application/json'})).status,401);
 assert.equal((await send('/bots','POST',{sessionId:'group',chatId:'elsewhere'})).status,400);assert.equal(reads,0);
 assert.equal((await send('/bots','POST',{sessionId:'group'})).status,200);assert.equal(reads,1);
 for(const allowedBotIds of ['ou_fixture_bot',['invented'],[null]])assert.equal((await send('','PUT',{sessionId:'group',allowedBotIds})).status,400);
 assert.equal((await send('','PUT',{sessionId:'dm',allowedBotIds:['ou_fixture_bot']})).status,400);
 assert.equal((await send('','PUT',{sessionId:'group',allowedBotIds:['ou_fixture_bot']})).status,200);assert.equal(f.store.get('group').allowedBots.length,1);
});

test('other bot cards fetch actual card 2.0 content, check the sender/chat and recheck quiet time after the read',async()=>{
 const seen=[],requests=[],received=[];let events,allowed=true,wrongChat=false,afterRead=()=>{};
 const bridge={acceptsGroupBot:input=>allowed&&input.botId==='ou_fixture_bot',captureGroupMessage:x=>seen.push(x)};
 class Client{im={message:{get:async args=>{requests.push(args);afterRead();return {code:0,data:{items:[{message_id:'card',chat_id:wrongChat?'elsewhere':'group',sender:{id:'cli_fixture_bot',open_bot_id:'ou_fixture_bot',sender_type:'app'},body:{content:JSON.stringify({schema:'2.0',body:{elements:[{tag:'markdown',content:'测试机器人已收到消息'}]}})}}]}};}}};async request(){return {bot:{open_id:'self'}};}}
 class EventDispatcher{register(x){events=x;return this;}}class WSClient{async start(){}close(){}}
 const sdk={Client,EventDispatcher,WSClient,defaultHttpInstance:{request(){}},LoggerLevel:{error:1}};
 const ch=createFeishuChannel('feishu',{appId:'fake',appSecret:'fake',host:{get:()=>bridge}},()=>{},async()=>sdk);ch.setMessageHandler(x=>received.push(x));await ch.start();
 const send=()=>events['im.message.receive_v1']({sender:{sender_type:'bot',sender_id:{open_id:'ou_fixture_bot'}},message:{message_id:'card',chat_id:'group',chat_type:'group',message_type:'interactive',content:'{"content":"请升级至最新版本客户端，以查看内容"}'}});
 try{
  await send();assert.equal(seen.length,1);assert.equal(seen[0].text,'测试机器人已收到消息');assert.equal(requests[0].params.card_msg_content_type,'user_card_content');
  wrongChat=true;await send();assert.equal(seen.length,1,'cross-chat response rejected');wrongChat=false;
  afterRead=()=>{allowed=false;};await send();assert.equal(seen.length,1,'night/revocation rechecked after network read');
  assert.equal(received.length,0);
 }finally{await ch.stop();}
});
