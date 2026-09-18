const $=id=>document.getElementById(id);
let projectDefaults={}, chatLoading=false;
let epoch=0, conversationTicket=0, filter=null, offset=0, historyOffset=0, groups=[], busy=false, pollTimer;
const statusNames={running:'실행 중 / 종료 미확인',completed:'완료',failed:'실패',interrupted:'중단'};
const taskStates={active:'진행',paused:'보류',done:'완료'};
function el(tag,text,cls){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;}
function base(){if(!$('project').value)throw Error('프로젝트를 선택하세요.');return '/projects/'+encodeURIComponent($('project').value);}
function valid(b,e=epoch){return e===epoch&&$('project').value&&b==='/projects/'+encodeURIComponent($('project').value);}
function notice(text,error=false){$('status').textContent=text;$('status').classList.toggle('error',error);}
async function api(path,method='GET',body){const r=await fetch('/api'+path,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const d=await r.json();if(!r.ok){const error=Error(typeof d.detail==='string'?d.detail:JSON.stringify(d.detail));error.status=r.status;throw error;}return d;}
async function act(fn){try{await fn();}catch(e){notice(e.message,true);}}
function button(label,fn,cls){const n=el('button',label,cls);n.type='button';n.onclick=()=>act(fn);if(cls==='secondary'||cls==='icon-action')window.decorateAction?.(n,label);return n;}
function selectedPaths(){return [];}
function showPage(){}
let streams=[];

function closeStreams(){for(const stream of streams)stream.close();streams=[];}
function atBottom(){const n=$('messages');return n.scrollHeight-n.scrollTop-n.clientHeight<80;}
function followOutput(follow){if(follow){$('messages').scrollTop=$('messages').scrollHeight;$('new-output').hidden=true;}else $('new-output').hidden=false;}
function streamRun(id,b,container,refresh){
  let last=0;const generation=epoch;
  const source=new EventSource('/api'+b+'/runs/'+id+'/events');streams.push(source);
  source.addEventListener('run_event',event=>{
    if(!valid(b,generation)||!container.isConnected){source.close();return;}
    const row=JSON.parse(event.data);if(row.seq<=last)return;last=row.seq;
    const follow=atBottom(),previous=container.lastElementChild;
    if(row.kind==='assistant'&&previous?.dataset.kind==='assistant')previous.textContent+=row.text;
    else{const line=el('pre',row.text,'event '+row.kind);line.dataset.kind=row.kind;container.append(line);}
    followOutput(follow);
  });
  source.addEventListener('end',()=>{source.close();if(refresh&&valid(b,generation)&&container.isConnected)act(async()=>{await conversation(b);if(valid(b,generation))notice('실행이 종료되었습니다. 결과와 실행 과정을 확인하세요.');});});
  source.addEventListener('detached',()=>{source.close();if(refresh&&valid(b,generation)&&container.isConnected)act(async()=>{await conversation(b);if(valid(b,generation))notice('서버 연결이 바뀌었습니다. 실행 종료 여부를 확인한 뒤 기록을 정리하세요.',true);});});
  source.onerror=()=>{if(valid(b,generation)&&container.isConnected&&source.readyState!==EventSource.CLOSED)notice('출력 연결 재시도 중 · 저장된 위치부터 이어받습니다.');};
}
$('toggle-sidebar').onclick=()=>{const collapsed=$('workspace').classList.toggle('collapsed');$('toggle-sidebar').setAttribute('aria-expanded',String(!collapsed));$('toggle-sidebar').title=collapsed?'제어판 펼치기':'제어판 접기';};
$('new-output').onclick=()=>followOutput(true);
$('messages').onscroll=()=>{if(atBottom())$('new-output').hidden=true;};
$('history-panel').ontoggle=()=>{if($('history-panel').open&&$('project').value)act(()=>history());};
async function projects(selected=''){const d=await api('/projects');$('project').replaceChildren(new Option('선택하세요',''));for(const p of d.projects)$('project').add(new Option(p,p));$('project').value=selected;}
function drawTasks(){
  $('task-list').replaceChildren();$('task-names').replaceChildren();$('archived-chats').replaceChildren();
  const drafts=window.chatState.drafts($('project').value).filter(task=>!groups.some(g=>g.task===task)).map(task=>({task,label:task+' · 작성 중'}));
  const visible=groups.filter(g=>g.task&&!g.archived).sort((a,b)=>Number(b.pinned)-Number(a.pinned));
  const choices=[...visible,...drafts];
  for(const g of choices){
    const row=el('div',undefined,'chat-list-row');row.dataset.task=g.task??'';
    const b=button(g.label||g.task,async()=>{await switchChat(g.task);},'task'+(filter===g.task?' active':''));b.title=g.task||g.label;row.append(b);
    if(g.task){
      $('task-names').append(new Option(g.task,g.task));
      if(groups.some(item=>item.task===g.task)){
        const actions=el('div',undefined,'chat-row-actions');
        const pin=button('',()=>updateChatPreference(g.task,{pinned:!g.pinned}));window.actionIcon(pin,'pin',g.pinned?'채팅 고정 해제':'채팅 고정');pin.setAttribute('aria-pressed',String(Boolean(g.pinned)));pin.classList.toggle('is-pinned',Boolean(g.pinned));
        const rename=button('',()=>renameChat(g.task));window.actionIcon(rename,'edit','채팅 이름 변경');
        const archive=button('',()=>updateChatPreference(g.task,{archived:true}));window.actionIcon(archive,'archive','채팅 보관');actions.append(pin,rename,archive);row.append(actions);
      }
    }
    $('task-list').append(row);
  }
  const archived=groups.filter(g=>g.task&&g.archived);
  $('archive-label').textContent='보관된 채팅'+(archived.length?' · '+archived.length:'');
  for(const g of archived){const row=el('div',undefined,'archived-chat-row'),restore=button('',()=>updateChatPreference(g.task,{archived:false}));window.actionIcon(restore,'restore',g.task+' 채팅 복원');row.append(el('span',g.task),restore);$('archived-chats').append(row);}
  if(!archived.length)$('archived-chats').append(el('p','보관된 채팅이 없습니다.','hint'));
  $('chat-title').textContent=filter||'채팅 선택';window.refreshSetup?.();
}
async function updateChatPreference(task,change){
  const b=base(),e=epoch;window.chatState.save();await api(b+'/tasks','PATCH',{task,chat_id:window.chatState.identity($('project').value,task),...change});if(!valid(b,e))return;
  if(change.archived&&filter===task)await switchChat(null);else await conversation(b);
  notice(change.archived===true?'채팅을 보관했습니다. 보관된 채팅에서 복원할 수 있습니다.':change.archived===false?'채팅을 복원했습니다.':change.pinned?'채팅을 고정했습니다.':'채팅 고정을 해제했습니다.');
}
async function renameChat(task){
  const answer=prompt('새 채팅 이름',task);if(answer===null)return;
  const title=answer.trim();if(!title)throw Error('채팅 이름을 입력하세요.');if(title===task)return;
  if(groups.some(g=>g.task===title)||window.chatState.drafts($('project').value).includes(title))throw Error('같은 이름의 채팅이 있습니다. 다른 이름을 입력하세요.');
  const b=base(),e=epoch,name=$('project').value;window.chatState.save();
  window.chatState.checkRename(name,task,title);
  await api(b+'/tasks','PATCH',{task,title,chat_id:window.chatState.identity(name,task)});window.chatState.rename(name,task,title);if(!valid(b,e))return;
  if(filter===task)await switchChat(title);else await switchChat(filter);notice('채팅 이름을 변경했습니다.');
}
function routeView(route){$('routing').replaceChildren(el('span',(route.task?'작업: '+route.task+' · ':'')+route.reason));for(const name of route.candidates||[])$('routing').append(button(name,async()=>{$('task-name').value=name;notice('작업을 선택했습니다. 보내기를 눌러 실행하세요.');}));}
function metadata(value){try{return typeof value==='string'?JSON.parse(value):value||{};}catch{return {};}}
function messageCard(m,b){
  const card=el('article',undefined,'message'),meta=el('div',undefined,'meta');
  const questionInfo=metadata(m.metadata),awaitingAnswer=questionInfo.question&&!questionInfo.reply_run_id&&!questionInfo.superseded_by;
  const runningLabel=m.cancellable?'실행 중':'종료 확인 필요';
  meta.append(el('span',m.task||'미분류'),el('span',new Date(m.created_at).toLocaleString()));card.append(meta,el('h3','요청'),el('pre',m.text,'user'));
  if(m.run_id){const answer=el('div',undefined,'answer');answer.append(el('h3',m.status==='running'?'진행':'결과'),el('span',(m.adapter||'클라이언트')+' · '+(m.status==='running'?runningLabel:awaitingAnswer?'답변 대기':statusNames[m.status]),'state '+m.status),el('pre',m.output||m.error||(m.cancellable?'에이전트가 작업 중입니다. 아래에서 실행 과정을 펼쳐 볼 수 있습니다.':'서버가 이 실행을 관리하고 있지 않습니다. 프로세스가 종료됐는지 확인해 주세요.')));const info=metadata(m.metadata);if(info.elapsed_seconds!==undefined)answer.append(el('p',info.elapsed_seconds+'초 · '+(info.resumed?'세션 이어짐':'새 세션')+' · 참고 대화 '+info.history_count+'개','hint'));if(info.usage){const d=el('details');d.append(el('summary','사용량'),el('pre',JSON.stringify(info.usage,null,2)));answer.append(d);}if(m.status==='running')answer.append(button(m.cancellable?'실행 취소':'종료 확인 후 기록 정리',async()=>{
      const run=await api(b+'/runs/'+m.run_id);if(!valid(b))return;
      if(run.status!=='running'){await conversation();return;}
      if(run.cancellable!==m.cancellable){await conversation();notice('실행 상태가 바뀌었습니다. 표시된 동작을 다시 확인하세요.');return;}
      if(run.cancellable){if(confirm('이 실행을 취소할까요? 이미 변경된 파일은 유지됩니다.')){await api(b+'/runs/'+m.run_id+'/cancel','POST');await conversation();}}
      else if(confirm('이 서버가 관리하는 실행이 아닙니다. 다른 서버나 CLI 프로세스가 종료된 것을 확인했나요? 확인하면 기록만 중단으로 정리합니다.')){await api(b+'/runs/'+m.run_id+'/reconcile','POST');await conversation();}
    },'secondary'));card.append(answer);
    if(m.status==='running'){const detail=el('details'),log=el('div',undefined,'stream');detail.append(el('summary',m.cancellable?'실행 과정 보기 · 실시간':'실행 과정 보기 · 저장된 기록'),log);answer.append(detail);queueMicrotask(()=>{if(log.isConnected)streamRun(m.run_id,b,log,m.cancellable);});}
    else{const detail=el('details'),log=el('div',undefined,'stream');detail.append(el('summary','실행 과정 보기'),log);let loaded=false;detail.ontoggle=()=>{if(detail.open&&!loaded){loaded=true;streamRun(m.run_id,b,log,false);}};answer.append(detail);}
  }
  if(m.status==='completed'){const question=window.questionCard?.(m,b,conversation);if(question){const output=card.querySelector('.answer>pre');if(output)output.hidden=true;card.append(question);}}
  return card;
}
async function conversation(b=base()){
  const ticket=++conversationTicket,e=epoch,chatId=window.chatState.identity($('project').value,filter),query=chatId?'&chat_id='+chatId:'&task='+encodeURIComponent(filter||'');
  const [t,d,r,q]=await Promise.all([api(b+'/tasks'),filter?api(b+'/messages?limit=20&offset='+offset+query):Promise.resolve({messages:[]}),api(b+'/runs?limit=20'),chatId?api(b+'/questions?chat_id='+chatId):Promise.resolve({messages:[]})]);
  if(!valid(b,e)||ticket!==conversationTicket)return;const follow=atBottom(),scroll=$('messages').scrollTop;closeStreams();groups=t.tasks;window.chatState.bind($('project').value,groups);if(chatId){filter=groups.find(g=>g.id===chatId)?.task||filter;$('task-name').value=filter||'';}drawTasks();$('messages').replaceChildren();
  for(const m of [...d.messages].reverse())$('messages').append(messageCard(m,b));
  for(const pending of q.messages||[])if(!d.messages.some(m=>m.run_id===pending.run_id))$('messages').append(messageCard(pending,b));
  if(!d.messages.length)$('messages').append(el('div',filter?'아직 대화가 없습니다. 아래에서 시작하세요.':'왼쪽에서 채팅을 선택하거나 새 채팅을 만드세요.','empty'));
  $('messages-prev').disabled=offset===0;$('messages-next').disabled=d.messages.length<20;$('page-number').textContent=d.messages.length?(offset+1)+'–'+(offset+d.messages.length):'0개';
  const running=r.runs.filter(x=>x.status==='running');$('activity').textContent=running.length?'실행 중인 작업 '+running.length+'개':'';
  $('connection').textContent=running.length?'클라이언트 실행 중':'로컬 작업 기록';drawOverview(r.runs);window.refreshSessionView?.(r.runs);
  clearTimeout(pollTimer);if(follow)followOutput(true);else $('messages').scrollTop=scroll;
}
function drawOverview(runs){$('overview').replaceChildren();const stats=el('div',undefined,'stats');for(const [label,count] of [['작업',groups.filter(g=>g.task).length],['보류',groups.filter(g=>g.status==='paused').length],['최근 실패',runs.filter(r=>r.status==='failed').length]]){const s=el('div',label,'stat');s.append(el('strong',String(count)));stats.append(s);}$('overview').append(stats,el('p','최근 실행 20개 기준 · 작업을 선택하면 관련 대화와 결과를 함께 볼 수 있습니다.','hint'));for(const g of groups.filter(g=>g.task))$('overview').append(button(g.task+' · '+taskStates[g.status],async()=>{await switchChat(g.task);},'task'));}
async function switchChat(task){
  window.chatState.pause();epoch++;conversationTicket++;closeStreams();chatLoading=true;$('send').disabled=true;
  $('routing').replaceChildren();$('new-output').hidden=true;
  task=task||null;filter=task;const b=base(),e=epoch;
  try{const restored=await window.chatState.restore($('project').value,task,projectDefaults);
    if(!valid(b,e)||!restored)return;
    try{await loadRules(b);}catch(error){if(valid(b,e))notice('룰북 조회 실패 · 작업 경로를 확인하세요: '+error.message,true);}
    if(!valid(b,e))return;
    await conversation(b);if(valid(b,e))window.chatState.finish(restored);
  }finally{if(valid(b,e)){chatLoading=false;$('send').disabled=busy;}}
}
async function loadProject(){
  window.chatState.pause();chatLoading=true;$('send').disabled=true;
  epoch++;conversationTicket++;closeStreams();clearTimeout(pollTimer);filter=null;offset=0;historyOffset=0;groups=[];$('text').value='';$('task-name').value='';$('routing').replaceChildren();$('messages').replaceChildren();$('history').replaceChildren();$('rules').textContent='프로젝트 선택 대기';$('workspace-root').value='';drawTasks();window.refreshSetup?.();
  if(!$('project').value){chatLoading=false;notice('프로젝트를 선택하세요.');return;}
  const b=base(),e=epoch,[s,workspace,t]=await Promise.all([api(b+'/settings'),api(b+'/workspace'),api(b+'/tasks')]);if(!valid(b,e))return;$('workspace-root').value=workspace.path;projectDefaults=s;groups=t.tasks;window.chatState.bind($('project').value,groups);
  await switchChat(window.chatState.selected($('project').value));window.refreshSetup?.();notice('프로젝트와 채팅의 작성 상태를 복원했습니다.');
}
async function loadRules(b=base()){
  const e=epoch,rules=await api(b+'/rules?cwd='+encodeURIComponent($('cwd').value));if(!valid(b,e))return;
  window.renderRulebook?.(rules);
  $('rules').textContent=rules.rules.map(r=>'# '+r.path+'\n'+r.content).join('\n')||'적용된 룰북이 없습니다.';
}

async function history(){const b=base(),e=epoch,d=await api(b+'/runs?limit=20&offset='+historyOffset);if(!valid(b,e))return;$('history').replaceChildren();for(const r of d.runs){const item=el('details');item.append(el('summary',new Date(r.started_at).toLocaleString()+' · '+r.adapter+' · '+statusNames[r.status]+' · '+r.command.text.slice(0,60)),el('pre',r.output||r.error||'실행 중 / 종료 미확인'));$('history').append(item);}if(!d.runs.length)$('history').textContent='실행 기록이 없습니다.';$('history-prev').disabled=historyOffset===0;$('history-next').disabled=d.runs.length<20;}
$('composer').onsubmit=e=>{e.preventDefault();if(busy||chatLoading)return;act(async()=>{
  const b=base(),generation=epoch,sentProject=$('project').value,sentTask=filter,sentText=$('text').value;window.chatState.save();busy=true;$('send').disabled=true;
  const payload={text:$('text').value,task:$('task-name').value,chat_id:window.chatState.identity(sentProject,$('task-name').value),auto_route:$('auto-route').checked,action:$('action').value,client:$('client').value,mode:$('mode').value,fresh:$('fresh').checked,model:window.selectedExecutionModel?.()||null,cwd:$('cwd').value,context_paths:selectedPaths()};
  try{const requestId=window.chatState.request(sentProject,sentTask,payload);
    const data=await api(b+'/chat','POST',{...payload,request_id:requestId});
    window.chatState.acknowledge(sentProject,sentTask,requestId);
    if(!data.needs_selection)window.chatState.sent(sentProject,sentTask,sentText);if(!valid(b,generation))return;routeView(data.routing);if(data.needs_selection){notice('어떤 작업인지 선택한 뒤 다시 보내세요. 아직 실행하지 않았습니다.');return;}
    window.setupRequestSent?.();if($('text').value===sentText)$('text').value='';$('task-name').value=data.routing.task||'';$('fresh').checked=false;actionHint();filter=data.routing.task||'';offset=0;window.chatState.save();await conversation(b);notice(data.run_id?'요청을 접수했습니다. 대화에서 실행 상태를 확인하세요.':'메시지를 저장했습니다.');
  }finally{busy=false;$('send').disabled=chatLoading;}
});};
$('preview-route').onclick=()=>act(async()=>{const b=base(),text=$('text').value,route=await api(b+'/route','POST',{text});if(valid(b)&&text===$('text').value)routeView(route);});
function actionHint(){const match=$('text').value.trim().match(/^\/(codex|claude)(?:\s|$)/);const client=match?match[1]:$('client').value;const run=!!match||$('action').value==='run';$('action-hint').textContent=(run?client+' 실행 · '+($('mode').value==='read-only'?'읽기 전용':'코드 수정 허용'):'일반 메시지는 기록만')+' · /codex 또는 /claude 명령은 지정한 에이전트로 실행합니다.';}
for(const id of ['action','client','mode'])$(id).onchange=actionHint;
$('text').oninput=actionHint;
$('text').onkeydown=e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();$('composer').requestSubmit();}};
actionHint();
$('project').onchange=()=>act(loadProject);
$('home').onclick=event=>{event.preventDefault();act(async()=>{
  window.chatState.pause();$('project').value='';await loadProject();window.refreshSessionView?.();
});};
$('create').onsubmit=e=>{e.preventDefault();act(async()=>{const name=$('name').value;await api('/projects','POST',{name});await projects(name);await loadProject();});};
$('reload').onclick=()=>act(()=>conversation());$('reload-rules').onclick=()=>act(()=>loadRules());
$('messages-prev').onclick=()=>act(async()=>{offset=Math.max(0,offset-20);await conversation();});$('messages-next').onclick=()=>act(async()=>{offset+=20;await conversation();});
$('history-prev').onclick=()=>act(async()=>{historyOffset=Math.max(0,historyOffset-20);await history();});$('history-next').onclick=()=>act(async()=>{historyOffset+=20;await history();});
$('save-settings').onclick=()=>act(async()=>{projectDefaults=await api(base()+'/settings','PUT',{cwd:$('cwd').value,context_paths:selectedPaths(),client:$('client').value,mode:$('mode').value,model:window.selectedConfiguredModel?.()||null});window.setupSettingsSaved?.();notice('설정을 저장했습니다. 첫 요청을 입력해 보세요.');});
$('probe-clients').onclick=()=>act(async()=>{
  $('probe-clients').disabled=true;$('clients').textContent='확인 중…';try{const d=await api('/clients');$('clients').replaceChildren();for(const c of d.clients){const card=el('div',undefined,'client-card');card.append(el('h3',c.client==='codex'?'Codex':'Claude'),el('p',({installed:'설치 확인',missing:'설치 필요',error:'확인 실패'}[c.state]||c.state)+(c.version?' · '+c.version:'')),el('p',c.detail||(c.auth==='ready'?'인증 확인 완료':c.auth==='check_required'?'터미널에서 로그인 상태를 확인하세요.':'인증은 실제 실행 시 확인합니다.'),'hint'));const input=el('input');input.value=c.path||'';input.placeholder='실행 파일 경로 (비우면 PATH에서 탐색)';input.setAttribute('aria-label',c.client+' 실행 파일 경로');const pathRow=el('div',undefined,'client-path-row');pathRow.append(input,button('경로 등록',async()=>{await api('/clients/'+c.client,'PUT',{path:input.value});notice('클라이언트 경로를 저장했습니다. 다시 확인을 눌러 검증하세요.');},'icon-action'));card.append(pathRow);$('clients').append(card);}}finally{$('probe-clients').disabled=false;}
});


async function trash(){
  const d=await api('/deleted-projects');$('deleted-projects').replaceChildren();
  for(const name of d.projects){const row=el('div',undefined,'row');row.append(el('span',name),button('복원',async()=>{await api('/deleted-projects/'+encodeURIComponent(name)+'/restore','POST');await projects(name);await loadProject();await trash();notice('프로젝트와 기존 기록을 복원했습니다.');},'icon-action'));$('deleted-projects').append(row);}
  if(!d.projects.length)$('deleted-projects').textContent='삭제한 프로젝트가 없습니다.';
}
$('trash-panel').ontoggle=()=>{if($('trash-panel').open)act(trash);};
$('delete-project').onclick=()=>act(async()=>{
  const b=base(),name=$('project').value;
  if(!confirm('“'+name+'” 프로젝트를 삭제할까요?\n목록에서 제거하며 파일·대화·실행 기록은 휴지통에서 복원할 수 있습니다.'))return;
  await api(b,'DELETE');
  await projects();await loadProject();await trash();notice('프로젝트를 삭제했습니다. 왼쪽 휴지통에서 복원할 수 있습니다.');
});
