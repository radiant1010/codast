const $=id=>document.getElementById(id);
let epoch=0, conversationTicket=0, filter=null, offset=0, historyOffset=0, groups=[], busy=false, pollTimer;
const statusNames={running:'실행 중 / 종료 미확인',completed:'완료',failed:'실패',interrupted:'중단'};
const taskStates={active:'진행',paused:'보류',done:'완료'};
function el(tag,text,cls){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;}
function base(){if(!$('project').value)throw Error('프로젝트를 선택하세요.');return '/projects/'+encodeURIComponent($('project').value);}
function valid(b,e=epoch){return e===epoch&&$('project').value&&b==='/projects/'+encodeURIComponent($('project').value);}
function notice(text,error=false){$('status').textContent=text;$('status').classList.toggle('error',error);}
async function api(path,method='GET',body){const r=await fetch('/api'+path,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw Error(typeof d.detail==='string'?d.detail:JSON.stringify(d.detail));return d;}
async function act(fn){try{await fn();}catch(e){notice(e.message,true);}}
function button(label,fn,cls){const n=el('button',label,cls);n.type='button';n.onclick=()=>act(fn);return n;}
function selectedPaths(){return [...$('files').querySelectorAll('input:checked')].map(n=>n.value);}
function showPage(page){for(const n of document.querySelectorAll('.page'))n.hidden=n.id!=='page-'+page;for(const n of document.querySelectorAll('nav button'))n.classList.toggle('selected',n.dataset.page===page);if(page==='history'&&$('project').value)act(()=>history());}
for(const n of document.querySelectorAll('nav button'))n.onclick=()=>showPage(n.dataset.page);
async function projects(selected=''){const d=await api('/projects');$('project').replaceChildren(new Option('선택하세요',''));for(const p of d.projects)$('project').add(new Option(p,p));$('project').value=selected;}
function drawTasks(){
  $('task-list').replaceChildren();$('task-names').replaceChildren();
  const choices=[{task:null,label:'전체 대화'},{task:'',label:'미분류'},...groups.filter(g=>g.task).map(g=>({...g,label:g.task+' · '+g.count+' · '+taskStates[g.status]}))];
  for(const g of choices){const b=button(g.label,async()=>{filter=g.task;offset=0;showPage('chat');await conversation();},'task'+(filter===g.task?' active':''));$('task-list').append(b);if(g.task)$('task-names').append(new Option(g.task,g.task));}
  $('chat-title').textContent=filter===null?'전체 대화':filter||'미분류';$('task-controls').hidden=!filter;
  if(filter){$('task-title').value=filter;$('task-status').value=groups.find(g=>g.task===filter)?.status||'active';}
}
function routeView(route){$('routing').replaceChildren(el('span',(route.task?'작업: '+route.task+' · ':'')+route.reason));for(const name of route.candidates||[])$('routing').append(button(name,async()=>{$('task-name').value=name;notice('작업을 선택했습니다. 보내기를 눌러 실행하세요.');}));}
function metadata(value){try{return typeof value==='string'?JSON.parse(value):value||{};}catch{return {};}}
function messageCard(m,b){
  const card=el('article',undefined,'message'),meta=el('div',undefined,'meta');
  meta.append(el('span',m.task||'미분류'),el('span',new Date(m.created_at).toLocaleString()));card.append(meta,el('pre',m.text,'user'));
  if(m.run_id){const answer=el('div',undefined,'answer');answer.append(el('span',(m.adapter||'클라이언트')+' · '+statusNames[m.status],'state '+m.status),el('pre',m.output||m.error||'실행 상태를 확인하고 있습니다.'));const info=metadata(m.metadata);if(info.elapsed_seconds!==undefined)answer.append(el('p',info.elapsed_seconds+'초 · '+(info.resumed?'세션 이어짐':'새 세션')+' · 참고 대화 '+info.history_count+'개','hint'));if(info.usage){const d=el('details');d.append(el('summary','사용량'),el('pre',JSON.stringify(info.usage,null,2)));answer.append(d);}if(m.status==='running')answer.append(button('상태 확인 · 취소',async()=>{
      const run=await api(b+'/runs/'+m.run_id);if(!valid(b))return;
      if(run.status!=='running'){await conversation();return;}
      if(run.cancellable){if(confirm('이 실행을 취소할까요? 이미 변경된 파일은 유지됩니다.')){await api(b+'/runs/'+m.run_id+'/cancel','POST');await conversation();}}
      else if(confirm('이 서버가 관리하는 실행이 아닙니다. 다른 서버나 CLI 프로세스가 종료된 것을 확인했나요? 확인하면 기록만 중단으로 정리합니다.')){await api(b+'/runs/'+m.run_id+'/reconcile','POST');await conversation();}
    },'secondary'));card.append(answer);}
  const controls=el('details');controls.append(el('summary','작업 이동'));const input=el('input');input.value=m.task;input.maxLength=120;input.setAttribute('list','task-names');input.setAttribute('aria-label','옮길 작업 이름');input.placeholder='비우면 미분류';controls.append(input,button('이동',async()=>{await api(b+'/messages/'+m.id,'PATCH',{task:input.value});if(valid(b))await conversation();},'secondary'));card.append(controls);return card;
}
async function conversation(b=base()){
  const ticket=++conversationTicket,e=epoch,query=filter===null?'':'&task='+encodeURIComponent(filter);
  const [t,d,r]=await Promise.all([api(b+'/tasks'),api(b+'/messages?limit=20&offset='+offset+query),api(b+'/runs?limit=20')]);
  if(!valid(b,e)||ticket!==conversationTicket)return;groups=t.tasks;drawTasks();$('messages').replaceChildren();
  for(const m of [...d.messages].reverse())$('messages').append(messageCard(m,b));
  if(!d.messages.length)$('messages').append(el('div','아직 대화가 없습니다. 아래에서 시작하세요.','empty'));
  $('messages-prev').disabled=offset===0;$('messages-next').disabled=d.messages.length<20;$('page-number').textContent=d.messages.length?(offset+1)+'–'+(offset+d.messages.length):'0개';
  const running=r.runs.filter(x=>x.status==='running');$('activity').textContent=running.length?'실행 중인 작업 '+running.length+'개':'';
  $('connection').textContent=running.length?'클라이언트 실행 중':'로컬 작업 기록';drawOverview(r.runs);
  clearTimeout(pollTimer);if(running.length)pollTimer=setTimeout(()=>act(()=>conversation(b)),1800);
}
function drawOverview(runs){$('overview').replaceChildren();const stats=el('div',undefined,'stats');for(const [label,count] of [['작업',groups.filter(g=>g.task).length],['보류',groups.filter(g=>g.status==='paused').length],['최근 실패',runs.filter(r=>r.status==='failed').length]]){const s=el('div',label,'stat');s.append(el('strong',String(count)));stats.append(s);}$('overview').append(stats,el('p','최근 실행 20개 기준 · 작업을 선택하면 관련 대화와 결과를 함께 볼 수 있습니다.','hint'));for(const g of groups.filter(g=>g.task))$('overview').append(button(g.task+' · '+taskStates[g.status],async()=>{filter=g.task;offset=0;showPage('chat');await conversation();},'task'));}
async function loadProject(){
  epoch++;conversationTicket++;clearTimeout(pollTimer);filter=null;offset=0;historyOffset=0;groups=[];$('text').value='';$('task-name').value='';$('routing').replaceChildren();$('messages').replaceChildren();$('files').replaceChildren();$('history').replaceChildren();$('rules').textContent='프로젝트 선택 대기';drawTasks();
  if(!$('project').value){notice('프로젝트를 선택하세요.');return;}
  const b=base(),e=epoch,s=await api(b+'/settings');if(!valid(b,e))return;$('cwd').value=s.cwd;$('client').value=s.client;$('mode').value=s.mode;
  await filesAndRules(b,s.context_paths);if(!valid(b,e))return;await conversation(b);notice('프로젝트 준비 완료');
}
async function filesAndRules(b=base(),checked=selectedPaths()){
  const e=epoch,[rules,listing]=await Promise.all([api(b+'/rules?cwd='+encodeURIComponent($('cwd').value)),api(b+'/files')]);if(!valid(b,e))return;
  $('rules').textContent=rules.rules.map(r=>'# '+r.path+'\n'+r.content).join('\n')||'RULES.md 없음';$('files').replaceChildren();for(const path of listing.files){const label=el('label'),box=el('input');box.type='checkbox';box.value=path;box.checked=checked.includes(path);label.append(box,document.createTextNode(path));$('files').append(label);}
}
async function history(){const b=base(),e=epoch,d=await api(b+'/runs?limit=20&offset='+historyOffset);if(!valid(b,e))return;$('history').replaceChildren();for(const r of d.runs){const item=el('details');item.append(el('summary',new Date(r.started_at).toLocaleString()+' · '+r.adapter+' · '+statusNames[r.status]+' · '+r.command.text.slice(0,60)),el('pre',r.output||r.error||'실행 중 / 종료 미확인'));$('history').append(item);}if(!d.runs.length)$('history').textContent='실행 기록이 없습니다.';$('history-prev').disabled=historyOffset===0;$('history-next').disabled=d.runs.length<20;}
$('composer').onsubmit=e=>{e.preventDefault();if(busy)return;act(async()=>{
  const b=base(),generation=epoch;busy=true;$('send').disabled=true;
  try{const data=await api(b+'/chat','POST',{text:$('text').value,task:$('task-name').value,auto_route:$('auto-route').checked,action:$('action').value,client:$('client').value,mode:$('mode').value,fresh:$('fresh').checked,cwd:$('cwd').value,context_paths:selectedPaths()});
    if(!valid(b,generation))return;routeView(data.routing);if(data.needs_selection){notice('어떤 작업인지 선택한 뒤 다시 보내세요. 아직 실행하지 않았습니다.');return;}
    $('text').value='';$('task-name').value='';$('fresh').checked=false;filter=null;offset=0;await conversation(b);notice(data.run_id?'요청을 접수했습니다. 대화에서 실행 상태를 확인하세요.':'메시지를 저장했습니다.');
  }finally{busy=false;$('send').disabled=false;}
});};
$('preview-route').onclick=()=>act(async()=>{const b=base(),text=$('text').value,route=await api(b+'/route','POST',{text});if(valid(b)&&text===$('text').value)routeView(route);});
$('action').onchange=()=>{$('action-hint').textContent=$('action').value==='note'?'기록만 저장하며 AI를 실행하지 않습니다.':'선택한 클라이언트로 요청과 관련 대화를 전달합니다. 권한이 필요한 명령은 클라이언트 정책에 따라 거절될 수 있습니다.';};
$('project').onchange=()=>act(loadProject);
$('create').onsubmit=e=>{e.preventDefault();act(async()=>{const name=$('name').value;await api('/projects','POST',{name});await projects(name);await loadProject();});};
$('reload').onclick=()=>act(()=>conversation());$('reload-rules').onclick=()=>act(()=>filesAndRules());
$('messages-prev').onclick=()=>act(async()=>{offset=Math.max(0,offset-20);await conversation();});$('messages-next').onclick=()=>act(async()=>{offset+=20;await conversation();});
$('history-prev').onclick=()=>act(async()=>{historyOffset=Math.max(0,historyOffset-20);await history();});$('history-next').onclick=()=>act(async()=>{historyOffset+=20;await history();});
$('save-settings').onclick=()=>act(async()=>{await api(base()+'/settings','PUT',{cwd:$('cwd').value,context_paths:selectedPaths(),client:$('client').value,mode:$('mode').value});notice('작업 폴더·파일·클라이언트·권한 설정을 저장했습니다.');});
$('update-task').onclick=()=>act(async()=>{const title=$('task-title').value.trim();if(!title)throw Error('작업 이름을 입력하세요.');if(title!==filter&&groups.some(g=>g.task===title)&&!confirm('두 작업의 기록을 합칠까요? 클라이언트 대화는 새로 시작합니다.'))return;await api(base()+'/tasks','PATCH',{task:filter,title,status:$('task-status').value});filter=title;await conversation();notice('작업을 변경했습니다.');});
$('read').onclick=()=>act(async()=>{const b=base(),d=await api(b+'/file?path='+encodeURIComponent($('path').value));if(valid(b))$('content').value=d.content;});
$('write').onclick=()=>act(async()=>{const b=base();await api(b+'/file','PUT',{path:$('path').value,content:$('content').value});if(valid(b)){await filesAndRules();notice('파일을 저장했습니다.');}});
$('probe-clients').onclick=()=>act(async()=>{
  $('probe-clients').disabled=true;$('clients').textContent='확인 중…';try{const d=await api('/clients');$('clients').replaceChildren();for(const c of d.clients){const card=el('div',undefined,'client-card');card.append(el('h3',c.client==='codex'?'Codex':'Claude'),el('p',({installed:'설치 확인',missing:'설치 필요',error:'확인 실패'}[c.state]||c.state)+(c.version?' · '+c.version:'')),el('p',c.detail||(c.auth==='ready'?'인증 확인 완료':c.auth==='check_required'?'터미널에서 로그인 상태를 확인하세요.':'인증은 실제 실행 시 확인합니다.'),'hint'));const input=el('input');input.value=c.path||'';input.placeholder='실행 파일 경로 (비우면 PATH에서 탐색)';input.setAttribute('aria-label',c.client+' 실행 파일 경로');card.append(input,button('경로 저장',async()=>{await api('/clients/'+c.client,'PUT',{path:input.value});notice('클라이언트 경로를 저장했습니다. 다시 확인을 눌러 검증하세요.');}));$('clients').append(card);}}finally{$('probe-clients').disabled=false;}
});
act(()=>projects());
