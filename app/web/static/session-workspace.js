/* One row per saved chat; execution metrics remain scoped to each AI. */
function sessionWorkspaceRows(chats,items,metrics,runs,describeWork){
  const goals=new Map(items.map(item=>[item.chat_id,item]));
  return chats.filter(chat=>chat.task&&!chat.archived).map(chat=>{
    const item=goals.get(chat.id),values=metrics.filter(row=>row.chat_id?row.chat_id===chat.id:row.task===chat.task);
    const active=runs.filter(run=>run.command?.chat_id?run.command.chat_id===chat.id:run.command?.task===chat.task);
    const view=item?describeWork(item):null,unknown=active.some(run=>!run.cancellable);
    const title=item&&chat.task===item.title.slice(0,75)+' / '+item.id?item.title:chat.task;
    return {chat,item,metrics:values,active,title,
      status:view?.status||(unknown?'상태 미확인':active.length?'진행 중':chat.status==='paused'?'보류':chat.status==='done'?'완료':'실행 없음'),
      tone:view?.tone||(unknown?'unknown':active.length?'running':chat.status==='paused'?'paused':chat.status==='done'?'done':'neutral'),
      reason:view?.reason||(unknown?'종료 여부 확인 필요':active.length?'AI 실행 중':'다음 지시 대기'),
      phase:view?.phase||'미지정',mode:view?.executionMode||(unknown?'확인 필요':active.length>1?'병렬 '+active.length:active.length?'단일':'—'),
      clients:[...new Set([...active.map(run=>run.command?.client||run.adapter),...values.map(row=>row.client),item?.client].filter(Boolean))],
    };
  }).sort((a,b)=>Number(Boolean(b.active.length))-Number(Boolean(a.active.length))||Number(Boolean(b.chat.pinned))-Number(Boolean(a.chat.pinned)));
}
if(typeof module!=='undefined')module.exports={sessionWorkspaceRows};
if(typeof document!=='undefined')(()=>{
  const page=el('section',undefined,'session-dashboard-page');page.id='session-dashboard-page';
  const header=el('header'),menu=button('',()=>{$('toggle-sidebar').click();}),title=el('h1','작업 대시보드');
  window.actionIcon(menu,'menu','프로젝트와 채팅 목록 열기');menu.setAttribute('aria-controls','sidebar');header.append(menu,title);
  const scope=el('p',undefined,'session-page-context'),tabs=el('div',undefined,'session-tabs');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','작업 대시보드 항목');
  const panels=new Map(),dashboardTabs=[['sessions','AI 세션','.compact-session-panel'],['accounts','계정 사용량','.codex-account-summary'],['environment','실행환경','.compact-environment']];
  page.append(header,scope,tabs);$('workspace').append(page);
  const navigation=el('a','작업 대시보드','btn btn-outline-secondary');navigation.id='open-dashboard';navigation.href='#dashboard';$('sidebar').querySelector('.chat-navigation').before(navigation);
  for(const [key,label,selector] of dashboardTabs){
    const panel=document.querySelector(selector),tab=button(label,()=>{location.hash=key==='sessions'?'#dashboard':'#dashboard/'+key;});
    tab.id='dashboard-tab-'+key;tab.setAttribute('role','tab');tab.setAttribute('aria-controls','dashboard-panel-'+key);tab.dataset.dashboardTab=key;
    panel.id='dashboard-panel-'+key;panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby',tab.id);tabs.append(tab);page.append(panel);panels.set(key,panel);
  }
  const alerts=$('session-alerts');page.append(alerts);$('workspace-status')?.remove();
  const list=panels.get('sessions').querySelector('.dashboard-body');list.removeAttribute('tabindex');
  const count=el('p',undefined,'session-count'),table=el('table',undefined,'session-workspace-table'),head=el('thead'),headRow=el('tr'),body=el('tbody');
  const columns=['세션','현재 상태','단계','AI','방식'];for(const label of columns){const cell=el('th',label);cell.scope='col';headRow.append(cell);}head.append(headRow);table.append(head,body);list.replaceChildren(count,table);
  const loadStatus=el('div',undefined,'session-load-status');loadStatus.setAttribute('role','status');panels.get('sessions').append(loadStatus);
  const chatHeader=el('section',undefined,'session-chat-summary'),back=el('a','작업 대시보드로','session-back');back.href='#dashboard';
  const badges=el('div',undefined,'session-properties'),goalLine=el('p',undefined,'session-current-goal'),chatTabs=el('div',undefined,'session-tabs');chatTabs.setAttribute('role','tablist');chatTabs.setAttribute('aria-label','채팅 세션 내용');
  chatHeader.append(back,badges,goalLine,chatTabs);$('console').querySelector('header').after(chatHeader);
  const historyPanel=el('section',undefined,'session-detail-panel');historyPanel.id='session-work-panel';
  const infoPanel=el('section',undefined,'session-detail-panel');infoPanel.id='session-info-panel';
  const conversationPane=$('messages').closest('.conversation-pane');conversationPane.id='session-conversation-panel';
  $('composer').before(historyPanel,infoPanel);
  const chatPanels={chat:conversationPane,history:historyPanel,info:infoPanel};
  for(const [key,label] of [['chat','대화'],['history','작업 기록'],['info','세션 정보']]){
    const tab=button(label,()=>{const current=chatRoute();if(current)location.hash='#chat/'+current[1]+(key==='chat'?'':'/'+key);});
    tab.id='session-tab-'+key;tab.dataset.sessionTab=key;tab.setAttribute('role','tab');tab.setAttribute('aria-controls',chatPanels[key].id);chatTabs.append(tab);
    chatPanels[key].setAttribute('role','tabpanel');chatPanels[key].setAttribute('aria-labelledby',tab.id);
  }
  let metrics=[],running=[],items=[],rows=[],ticket=0,loadedProject='',observedProject=null,loading=false,goalsError='',infoSignature='',historySignature='',messageRows=[],messageChat=null,routeTicket=0;
  const goalDrafts=new Map();
  const chatRoute=()=>location.hash.match(/^#chat\/([a-f0-9]{32})(?:\/(history|info))?$/);
  const aiName=client=>({codex:'Codex',claude:'Claude',mock:'테스트 AI'})[client]||client;
  function badge(text,tone='neutral'){const node=el('span',text,'work-item-badge');node.dataset.tone=tone;return node;}
  function contextText(metric){const used=metric.context_usage?.used_tokens,size=metric.context_usage?.window_tokens;return Number.isSafeInteger(used)&&used>=0?(Number.isSafeInteger(size)&&size>0?(used/size*100).toFixed(1)+'%':used.toLocaleString()+' 토큰'):'측정값 없음';}
  function tokenText(metric){const known=Number.isFinite(metric.input_tokens)&&Number.isFinite(metric.output_tokens);return known?(metric.input_tokens+metric.output_tokens).toLocaleString()+(metric.input_reports===metric.runs&&metric.output_reports===metric.runs?'':' (일부)'):'미수신';}
  function currentRow(){const id=chatRoute()?.[1]||window.chatState.identity($('project').value,filter);return rows.find(row=>row.chat.id===id);}
  function rebuild(){
    rows=sessionWorkspaceRows(groups,items,metrics,running,workItemView);
    if(loadedProject!==$('project').value)for(const row of rows){row.phase='미확인';if(!row.active.length){row.status=goalsError?'상태 미확인':'확인 중';row.tone='unknown';row.reason=goalsError?'목표 조회 실패':'목표 상태 확인 중';}}
    renderList();renderChatSummary();
  }
  function renderList(){
    count.textContent=$('project').value?rows.length+'개 세션':'프로젝트를 선택하세요.';body.replaceChildren();
    for(const row of rows){
      const tr=el('tr'),name=el('td'),open=button(row.title,()=>switchChat(row.chat.task),'session-title-link');open.setAttribute('aria-label',row.title+' 채팅 열기');name.append(open);
      const summary=row.metrics.length===1?'컨텍스트 '+contextText(row.metrics[0])+' / '+tokenText(row.metrics[0])+' 토큰':row.metrics.length>1?'AI별 측정값은 세션 정보에서 확인':'아직 측정된 사용량 없음';name.append(el('p',summary,'session-row-meta'));
      const state=el('td');state.append(badge(row.status,row.tone),el('p',row.reason,'session-row-meta'));
      const phase=el('td',row.phase),ai=el('td'),names=el('div',undefined,'session-ai-tags');for(const client of row.clients)names.append(badge(aiName(client)));ai.append(names);
      if(!row.clients.length)ai.append(el('span','미지정'));
      if(row.metrics.length===1)ai.append(el('p',row.metrics[0].execution_model||'모델 정보 없음','session-row-meta'));
      const mode=el('td');mode.append(row.mode==='—'?el('span','—'):badge(row.mode));tr.append(name,state,phase,ai,mode);[...tr.children].forEach((cell,index)=>cell.dataset.label=columns[index]);body.append(tr);
    }
    if(!rows.length){const row=el('tr'),cell=el('td',$('project').value?'아직 채팅이 없습니다. 새 채팅을 만들어 시작하세요.':'프로젝트를 선택하면 채팅과 작업 상태를 확인할 수 있습니다.');cell.colSpan=5;row.append(cell);body.append(row);}
  }
  function renderChatSummary(){
    const row=currentRow();badges.replaceChildren();goalLine.textContent='';
    if(!row)return;
    $('chat-title').textContent=row.title;badges.append(badge(row.status,row.tone),badge(row.phase));for(const client of row.clients)badges.append(badge(aiName(client)));if(row.mode!=='—')badges.append(badge(row.mode));
    goalLine.textContent=loadedProject!==$('project').value?(goalsError?'목표 상태를 불러오지 못했습니다. 작업 기록에서 다시 시도하세요.':'목표 상태를 확인하고 있습니다.'):
      (row.item?'현재 목표: '+row.item.goal:'일반 대화, 세션 정보에서 목표와 완료 조건을 연결할 수 있습니다.')+(goalsError?' (마지막 확인 정보)':'');
  }
  async function refreshGoals(){
    if(!projectReady||!$('project').value)return;const project=$('project').value,b=base(),id=++ticket;loading=true;
    try{const data=await api(b+'/work-items');if(id!==ticket||project!==$('project').value)return;items=data.items;loadedProject=project;goalsError='';loadStatus.replaceChildren();rebuild();renderSelectedContent();}
    catch(error){if(id!==ticket||project!==$('project').value)return;goalsError=error.message;loadStatus.replaceChildren(el('p','목표 상태 조회 실패: '+error.message),button('다시 불러오기',refreshGoals));rebuild();renderSelectedContent();}
    finally{if(id===ticket)loading=false;}
  }
  function renderHistory(row){
    if(loadedProject!==$('project').value){window.workItems.attachToChat(null);historySignature='';historyPanel.replaceChildren(el('p',goalsError?'목표 상태를 불러오지 못했습니다. '+goalsError:'목표 상태를 확인하고 있습니다.'),button('다시 불러오기',refreshGoals));return;}
    if(row?.item){historySignature='goal:'+row.item.id;window.workItems.attachToChat(row.item.id,historyPanel);return;}
    window.workItems.attachToChat(null);
    const key=JSON.stringify([row?.chat.id,messageRows]);if(historySignature===key)return;historySignature=key;historyPanel.replaceChildren();
    if(!row){historyPanel.append(el('p','세션을 불러오는 중입니다.'));return;}
    historyPanel.append(el('h2','실행 기록'));
    const records=messageChat===row.chat.id?messageRows.filter(message=>message.run_id):[];
    if(!records.length)historyPanel.append(el('p','아직 실행 기록이 없습니다. 대화에서 작업을 지시하면 이곳에서 결과를 확인할 수 있습니다.','hint'));
    for(const record of records){const item=el('section',undefined,'session-run-record');item.append(el('h3',aiName(record.adapter)+', '+(statusNames[record.status]||record.status)),el('p',new Date(record.created_at).toLocaleString(),'hint'),el('p',record.text),consoleOutput(record.output||record.error||'실행 결과를 기다리고 있습니다.'));historyPanel.append(item);}
  }
  function renderInfo(row){
    const signature=JSON.stringify([row,loadedProject,goalsError]);if(infoSignature===signature)return;infoSignature=signature;infoPanel.replaceChildren();if(!row)return;
    const details=el('dl',undefined,'session-info-grid');details.append(el('dt','채팅 이름'),el('dd',row.title),el('dt','현재 상태'),el('dd',row.status),el('dt','실행 방식'),el('dd',row.mode));infoPanel.append(details);
    if(!row.metrics.length)infoPanel.append(el('p','CLI가 보고한 모델과 컨텍스트 정보가 아직 없습니다.','hint'));
    for(const metric of row.metrics){const group=el('section',undefined,'session-metric-group'),values=el('dl',undefined,'session-info-grid');group.append(el('h2',aiName(metric.client)));for(const [label,value] of [['실행 모델',metric.execution_model||'정보 없음'],['컨텍스트',contextText(metric)],['누적 토큰',tokenText(metric)],['측정 시각',metric.context_usage?.observed_at?new Date(metric.context_usage.observed_at).toLocaleString():'기록 없음']])values.append(el('dt',label),el('dd',value));group.append(values);infoPanel.append(group);}
    if(row.item){const target=el('section',undefined,'session-goal-info');target.append(el('h2','현재 목표'),el('p',row.item.goal),el('h3','완료 조건'),el('p',row.item.done_criteria),button('작업 기록과 결과 확인',()=>{location.hash='#chat/'+row.chat.id+'/history';}));infoPanel.append(target);return;}
    if(loadedProject!==$('project').value){infoPanel.append(el('p',goalsError?'목표 상태를 불러오지 못했습니다. '+goalsError:'목표 연결 상태를 확인하고 있습니다.','hint'),button('다시 불러오기',refreshGoals));return;}
    const form=el('form',undefined,'session-goal-form');form.append(el('h2','이 대화에 목표 연결'),el('p','현재 대화를 유지하면서 목표와 완료 조건을 함께 관리합니다.','hint'));
    const key=$('project').value+'/'+row.chat.id,saved=goalDrafts.get(key)||{},fields={};
    for(const [name,label] of [['goal','현재 목표'],['done_criteria','완료 조건']]){const caption=el('label',label),input=el('textarea');input.id='session-goal-'+name;caption.htmlFor=input.id;input.name=name;input.rows=3;input.required=true;input.maxLength=8000;input.value=saved[name]||'';fields[name]=input;form.append(caption,input);}
    form.oninput=()=>goalDrafts.set(key,Object.fromEntries(new FormData(form)));
    const save=el('button','이 세션에 목표 연결');save.type='submit';const status=el('p');status.setAttribute('role','status');form.append(save,status);infoPanel.append(form);
    form.onsubmit=event=>{event.preventDefault();void act(async()=>{const b=base(),project=$('project').value;form.inert=true;status.textContent='연결 중…';try{await api(b+'/work-items','POST',{chat_id:row.chat.id,title:row.title,goal:fields.goal.value,done_criteria:fields.done_criteria.value});goalDrafts.delete(key);if(project!==$('project').value)return;await refreshGoals();notice('목표를 연결했습니다.',false,{success:true});}catch(error){status.textContent=error.message;}finally{form.inert=false;}});};
  }
  function renderSelectedContent(){const route=chatRoute();if(!route)return;const row=currentRow();if(route[2]==='history')renderHistory(row);else if(route[2]==='info')renderInfo(row);}
  function navigate(){
    const hash=location.hash,route=chatRoute(),isDashboard=/^#dashboard(?:\/(accounts|environment))?$/.test(hash),selected=hash.split('/')[1]||'sessions';
    if(!hash){location.replace('#dashboard');return;}
    page.hidden=!isDashboard;navigation.setAttribute('aria-current',isDashboard?'page':'false');
    if(hash.startsWith('#work-items')){window.workItems.attachToChat(null);$('console').hidden=true;return;}
    $('console').hidden=isDashboard;
    for(const [key,panel] of panels){panel.hidden=selected!==key;tabs.querySelector('[data-dashboard-tab='+key+']').setAttribute('aria-selected',String(selected===key));}
    if(!route){window.workItems.attachToChat(null);return;}
    const tab=route[2]||'chat';$('console').dataset.sessionTab=tab;
    for(const [key,panel] of Object.entries(chatPanels)){panel.hidden=tab!==key;chatTabs.querySelector('[data-session-tab='+key+']').setAttribute('aria-selected',String(tab===key));}
    $('composer').hidden=tab!=='chat';$('welcome').hidden=true;
    const chat=groups.find(group=>group.id===route[1]);
    if(projectReady&&chat&&filter!==chat.task){const id=++routeTicket;void act(async()=>{await switchChat(chat.task,{navigate:false});if(id===routeTicket)renderSelectedContent();});}
    else if(projectReady&&!chat){badges.replaceChildren();goalLine.textContent='이 프로젝트에서 채팅을 찾을 수 없습니다. 대시보드에서 다시 선택하세요.';$('composer').hidden=true;conversationPane.hidden=true;historyPanel.hidden=true;infoPanel.hidden=true;}
    renderChatSummary();renderSelectedContent();if(tab==='chat')window.resizeComposer?.();
  }
  window.sessionWorkspace={
    metricsChanged(values,active){metrics=values;running=active;rebuild();if(!loading)void refreshGoals();},
    conversationChanged(messages,chatId){messageRows=messages;messageChat=chatId;rebuild();renderSelectedContent();},
    chatSelected(task,{navigate:shouldNavigate=true}={}){const id=window.chatState.identity($('project').value,task);if(shouldNavigate&&id){location.hash='#chat/'+id;}else if(!shouldNavigate)navigate();},
    projectChanged(){ticket++;routeTicket++;loading=false;goalsError='';items=[];metrics=[];running=[];messageRows=[];messageChat=null;loadedProject='';infoSignature='';historySignature='';window.workItems.attachToChat(null);const changed=observedProject!==null&&observedProject!==$('project').value;observedProject=$('project').value;if(changed&&!location.hash.startsWith('#settings'))location.hash='#dashboard';scope.textContent=$('project').value?projectLabel($('project').value)+' 프로젝트':'프로젝트를 선택해 작업을 시작하세요.';loadStatus.replaceChildren();rebuild();navigate();},
    projectReady(){rebuild();navigate();void refreshGoals();},
  };
  window.addEventListener('hashchange',()=>{window.chatState.save();navigate();});
  window.addEventListener('project-names-changed',()=>{scope.textContent=$('project').value?projectLabel($('project').value)+' 프로젝트':'프로젝트를 선택해 작업을 시작하세요.';});
  $('sidebar').addEventListener('click',event=>{if(event.target.closest('#open-dashboard')&&$('sidebar').matches(':popover-open'))$('sidebar').hidePopover();});
  if(!location.hash)location.replace('#dashboard');navigate();
})();
