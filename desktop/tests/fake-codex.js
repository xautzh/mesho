// Test-only deterministic process fixture. Never used by the production defaults.
const fs=require('node:fs');
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{
  fs.appendFileSync('fixture-executions.jsonl',JSON.stringify({args:process.argv.slice(2),input,restricted:process.env.MESHO_AGENT_RESTRICTED})+'\n');
  const resume=process.argv.indexOf('resume');const id=resume>=0?process.argv[resume+1]:'fixture-session-'+Date.now();
  console.log(JSON.stringify({type:'thread.started',thread_id:id}));
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'模拟执行器：已处理测试请求。此结果用于验证消息与执行流程，不代表真实代码已修复。\n\n**验证结果**\n\n| Key | 用途 |\n| --- | --- |\n| `demo.key` | 配置示例 |\n\n```text\n安全代码块\n```\n<script>window.fixtureInjected=true</script>'}}));
  console.log(JSON.stringify({type:'turn.completed'}));
});
