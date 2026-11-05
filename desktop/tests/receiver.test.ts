import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../electron/store';
import { Engine } from '../electron/engine';
import { defaults, ChatMessage } from '../electron/types';

test('receiver chooses directory, approval, trust and reply; sync is idempotent and results never loop', async () => {
  const store = new Store(':memory:');
  store.saveConfig({...defaults, token:'test', userId:'bob', workingDirectory:process.cwd(), incomingMode:'auto', incomingSince:10, trustedPeers:['alice'], replyMode:'draft'});
  let runs=0;
  const engine = new Engine(store, async (t,c) => {
    runs++; assert.equal(c.projects[t.project],process.cwd()); return {text:'local result'};
  });
  const conversation={id:'group',kind:'group',name:'team',owner:'alice',members:['alice','bob','carol'],created:1};
  const msg=(id:string,extra:Partial<ChatMessage>={}):ChatMessage=>({id,seq:1,conversation:'group',from:'alice',kind:'text',text:'hello',mentions:['bob'],agent:'',project:'',taskId:'',created:11,...extra});
  let incoming=[msg('before',{created:2}),msg('unmentioned',{mentions:[]}),msg('result',{kind:'result'}),msg('mine',{from:'bob'}),msg('trusted'),msg('untrusted',{from:'carol'})];
  engine.api=async <T>(path:string,body?:unknown)=> (body ? {...body as object,seq:20} : {conversations:[conversation],messages:incoming,cursor:6}) as T;
  await engine.chat.sync();
  assert.equal(store.tasks().length,2);
  assert.equal(store.tasks().find(t=>t.peer==='carol')?.state,'pending');
  await engine.pump(); assert.equal(runs,1);
  const completed=store.tasks().find(t=>t.state==='completed')!;
  assert.ok(completed);
  assert.equal(engine.chat.history('group').filter(m=>m.from==='bob'&&m.kind==='result').length,0);
  engine.chat.publish(completed.id); engine.chat.publish(completed.id);
  assert.equal(engine.chat.history('group').filter(m=>m.from==='bob'&&m.kind==='result').length,1);
  await engine.chat.sync(); await engine.pump(); assert.equal(runs,1);
  store.saveConfig({...store.config(), incomingMode:'manual',replyMode:'auto'});
  incoming=[msg('manual')]; await engine.chat.sync(); assert.equal(store.tasks().length,2);
  engine.chat.delegate('manual'); await engine.pump(); assert.equal(runs,2);
  assert.equal(engine.chat.history('group').filter(m=>m.from==='bob'&&m.kind==='result').length,2);
  assert.throws(()=>engine.chat.delegate('result'),/普通消息/);
  store.close();
});

test('fresh sessions receive earlier chat context without future or unrelated messages', async () => {
 const store=new Store(':memory:');store.saveConfig({...defaults,token:'t',userId:'bob',workingDirectory:process.cwd()});
 let received='';const engine=new Engine(store,async t=>{received=t.input;return {text:'ok'};});
 const c={id:'dm',kind:'direct',name:'',owner:'alice',members:['alice','bob'],created:1};
 const m=(id:string,seq:number,text:string,extra={})=>({id,seq,conversation:'dm',from:'alice',kind:'text',text,mentions:[],agent:'',project:'',taskId:'',created:seq,...extra});
 engine.api=async <T>()=>({conversations:[c],messages:[m('keys',1,'mind.channel.registration-url-template',{from:'bob',kind:'result'}),m('question',2,'这些 key 的值是什么'),m('future',3,'future-secret'),m('other',4,'other-secret',{conversation:'other'})],cursor:4}) as T;
 await engine.chat.sync();engine.chat.delegate('question');await engine.pump();
 assert.match(received,/mind.channel.registration-url-template/);assert.match(received,/这些 key 的值是什么/);
 assert.ok(!received.includes('future-secret'));assert.ok(!received.includes('other-secret'));store.close();
});
