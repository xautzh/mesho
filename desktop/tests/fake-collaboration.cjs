// Deterministic collaboration transport fixture, not a real model.
const fs=require('node:fs');
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>input+=c);
process.stdin.on('end',async()=>{
  try {
    const args=process.argv.slice(2),resume=args.indexOf('resume'),sid=resume>=0?args[resume+1]:'collab-'+Date.now();
    fs.appendFileSync('collaboration-executions.jsonl',JSON.stringify({args,input})+'\n');
    console.log(JSON.stringify({type:'thread.started',thread_id:sid}));
    let text='接口字段是 customerId，必填字符串。';
    if(process.env.MESHO_COLLAB_URL) {
      if(resume<0) {
        const match=input.match(/本轮接口信息在本机文件 ("(?:[^"\\]|\\.)*") 中/);
        if(!match) throw new Error('Missing native-independent connection file');
        const connection=JSON.parse(fs.readFileSync(JSON.parse(match[1]),'utf8'));
        const response=await fetch(connection.url,{method:'POST',headers:{Authorization:'Bearer '+connection.token,'Content-Type':'application/json'},body:JSON.stringify({action:'ask',to:'bob',text:'注册接口必填字段是什么？'})});
        if(!response.ok) throw new Error(await response.text());
        text='已经询问同事，等待答复。';
      } else {
        if(!input.includes('customerId')) throw new Error('Missing correlated answer');
        text='已按 customerId 完成联调。测试通过，请验收。';
      }
    }
    console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}}));
    console.log(JSON.stringify({type:'turn.completed'}));
  }catch(e){console.error('Error: '+e.message);process.exitCode=1;}
});
