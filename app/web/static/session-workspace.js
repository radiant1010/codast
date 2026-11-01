/* One row per saved chat; execution metrics remain scoped to each AI. */
function sessionWorkspaceRows(chats,items,metrics,runs,describeWork){
  const goals=new Map(items.map(item=>[item.chat_id,item]));
  return chats.filter(chat=>chat.task&&!chat.archived).map(chat=>{
    const item=goals.get(chat.id),values=metrics.filter(row=>row.chat_id?row.chat_id===chat.id:row.task===chat.task);
    const active=runs.filter(run=>run.command?.chat_id?run.command.chat_id===chat.id:run.command?.task===chat.task);
    const view=item?describeWork(item):null,unknown=active.some(run=>!run.cancellable);
    const title=item&&chat.task===item.title.slice(0,75)+' / '+item.id?item.title:chat.task;
    // Usage reports can be missing for finished runs, so only saved runs decide whether a chat has started.
    const started=chat.runs>0||values.some(row=>row.runs>0)||active.length>0||Boolean(view?.latest),idle=started?'대기 중':'시작 전';
    const fallback=!view||view.tone==='ready';
    return {chat,item,metrics:values,active,title,
      status:fallback?(unknown?'상태 미확인':active.length?'진행 중':!view&&chat.status==='paused'?'보류':!view&&chat.status==='done'?'완료':idle):view.status,
      tone:fallback?(unknown?'unknown':active.length?'running':!view&&chat.status==='paused'?'paused':!view&&chat.status==='done'?'done':'neutral'):view.tone,
      reason:fallback?(unknown?'종료 여부 확인 필요':active.length?'AI 실행 중':started?'다음 지시 대기':'실행 기록 없음'):view.reason,
      phase:view?.phase||'—',mode:view?.executionMode||(unknown?'확인 필요':active.length>1?'병렬 '+active.length:active.length?'단일':'—'),
      clients:[...new Set([...active.map(run=>run.command?.client||run.adapter),...values.map(row=>row.client),item?.client].filter(Boolean))],
    };
  }).sort((a,b)=>sessionPriority(a)-sessionPriority(b)||Number(Boolean(b.chat.pinned))-Number(Boolean(a.chat.pinned)));
}
function sessionGroup(row){return row.tone==='running'?'running':['attention','paused','blocked','unknown','cancelled'].includes(row.tone)?'attention':row.tone==='done'?'done':row.status==='대기 중'?'idle':'new';}
function sessionPriority(row){return sessionGroup(row)==='running'?0:sessionGroup(row)==='attention'?1:2;}
const aiName=client=>({codex:'Codex',claude:'Claude',mock:'테스트 AI'})[client]||client;
/* Context window share per AI; unknown stays '—' and AIs are never summed. */
function contextPercent(metric){const used=metric.context_usage?.used_tokens,size=metric.context_usage?.window_tokens;if(!Number.isSafeInteger(used)||used<0||!Number.isSafeInteger(size)||size<=0)return '—';const value=Math.round(used/size*100);return used>0&&value===0?'<1%':value+'%';}
function contextSummary(metrics){return metrics.length?metrics.length===1?contextPercent(metrics[0]):metrics.map(metric=>aiName(metric.client)+' '+contextPercent(metric)).join(' / '):'—';}
if(typeof module!=='undefined')module.exports={sessionWorkspaceRows,contextSummary,sessionGroup};
if(typeof document!=='undefined')(()=>{
  const page=el('main',undefined,'session-dashboard-page');page.id='session-dashboard-page';
  const header=el('header'),title=el('h1','세션'),newTask=button('새 작업',()=>document.querySelector('.new-chat').click());header.append(title,newTask);
  const context=el('div',undefined,'session-page-context'),scope=el('label','프로젝트');scope.htmlFor='project';
  const summaryLink=el('a','프로젝트 요약 보기');summaryLink.href='#dashboard/summary';
  context.append(scope,$('project'),$('rename-project'),$('add-workspace'),summaryLink);page.append(header,context);$('workspace').append(page);
  const navigation=el('a','세션 목록','btn btn-outline-secondary');navigation.id='open-dashboard';navigation.href='#dashboard';
  const switcher=button('',()=>{});switcher.id='project-switcher';switcher.setAttribute('aria-expanded','false');switcher.setAttribute('popovertarget','project-switcher-menu');
  window.actionIcon(switcher,'next','프로젝트 선택');switcher.classList.remove('action-icon');
  const switcherText=el('span',undefined,'project-switcher-text'),switcherName=el('strong');switcherText.append(el('span','프로젝트','project-switcher-label'),switcherName);switcher.prepend(switcherText);
  const projectMenu=el('div',undefined,'project-switcher-menu');projectMenu.id='project-switcher-menu';projectMenu.setAttribute('popover','auto');projectMenu.setAttribute('aria-label','프로젝트 선택');
  projectMenu.addEventListener('beforetoggle',event=>switcher.setAttribute('aria-expanded',String(event.newState==='open')));
  const sideSummary=el('a','프로젝트 요약','side-summary-link');sideSummary.href='#dashboard/summary';
  const sideLinks=el('div',undefined,'side-project-links');sideLinks.append(sideSummary,navigation);
  $('project-panel').replaceWith(switcher,projectMenu,sideLinks);sideLinks.after(document.querySelector('.new-chat'));
  const sessionCount=$('sidebar').querySelector('.chat-navigation h2');
  const archive=$('chat-archive'),archiveHome=archive.parentElement;
  const sessions=document.querySelector('.compact-session-panel'),account=document.querySelector('.codex-account-summary'),environment=document.querySelector('.compact-environment');
  page.append(sessions);const listActions=el('div',undefined,'session-list-actions');listActions.append(sessions.querySelector('.section-header-actions'),newTask);header.append(listActions);sessions.querySelector('.compact-panel-head').remove();
  const summary=el('main',undefined,'session-dashboard-page project-summary-page');summary.id='project-summary-page';summary.hidden=true;
  const summaryHeader=el('header'),summaryTitle=el('h1'),back=el('a','세션 목록');back.href='#dashboard';summaryHeader.append(summaryTitle,back);summary.append(summaryHeader);
  const summaryGrid=el('div',undefined,'project-summary-grid');summary.append(summaryGrid);$('workspace').append(summary);
  function region(node,id,label){node.id=id;node.setAttribute('role','region');let heading=node.querySelector('h2');if(!heading){heading=el('h2');node.prepend(heading);}heading.textContent=label;heading.id=id+'-title';node.setAttribute('aria-labelledby',heading.id);summaryGrid.append(node);return node;}
  const sessionSummary=region(el('section'),'summary-sessions','세션 상태');
  region(account,'dashboard-panel-accounts','AI 한도');region(environment,'dashboard-panel-environment','실행환경');
  const goalsSummary=region(el('section'),'summary-goals','목표 작업');
  const projectsPage=el('main',undefined,'session-dashboard-page projects-page');projectsPage.id='projects-page';projectsPage.hidden=true;
  const projectsHeader=el('header');projectsHeader.append(el('h1','프로젝트'),button('프로젝트 추가',()=>$('add-workspace').click()));
  const projectsContext=el('p',undefined,'projects-context'),projectList=el('ul',undefined,'project-list'),projectsStatus=el('p');projectList.setAttribute('aria-label','프로젝트 목록');projectsStatus.setAttribute('role','status');
  projectsPage.append(projectsHeader,projectsContext,projectsStatus,projectList);$('workspace').append(projectsPage);
  let projectsTicket=0,projectRows=[],allRunning=[];
  document.querySelector('.session-dashboard').remove();
  const list=sessions.querySelector('.dashboard-body');list.removeAttribute('tabindex');
  const filters=el('div',undefined,'session-filters');filters.setAttribute('role','group');filters.setAttribute('aria-label','상태별 보기');page.insertBefore(filters,sessions);
  const filterNames={all:'전체',running:'진행 중',attention:'확인 필요',idle:'대기 중',new:'시작 전',done:'완료'};
  let selectedFilter='all',listPage=0;
  for(const [key,label] of Object.entries(filterNames)){const choice=button(label+' 0',()=>{selectedFilter=key;listPage=0;renderList();});choice.dataset.filter=key;choice.setAttribute('aria-pressed',String(key==='all'));filters.append(choice);}
  const table=el('table',undefined,'session-workspace-table'),head=el('thead'),headRow=el('tr'),body=el('tbody');
  const columns=['세션명','현재 상태','진행 단계','AI 종류','컨텍스트'];for(const label of columns){const cell=el('th',label);cell.scope='col';headRow.append(cell);}headRow.lastChild.title='컨텍스트 창 사용률, 누적 토큰은 세션 정보에서 확인';head.append(headRow);table.append(head,body);list.replaceChildren(table);
  const pagination=el('div',undefined,'session-pagination'),range=el('span'),previous=button('이전 페이지',()=>{listPage--;renderList();}),next=button('다음 페이지',()=>{listPage++;renderList();});pagination.append(range,previous,next);list.after(pagination);
  const loadStatus=el('div',undefined,'session-load-status');loadStatus.setAttribute('role','status');sessions.append(loadStatus);
  const chatHeader=el('section',undefined,'session-chat-summary');
  const badges=el('div',undefined,'session-properties'),goalLine=button('',()=>{const row=currentRow();if(row)location.hash='#chat/'+row.chat.id+'/info';},'session-current-goal'),chatTabs=el('div',undefined,'session-tabs');chatTabs.setAttribute('role','tablist');chatTabs.setAttribute('aria-label','채팅 세션 내용');
  chatHeader.append(badges,goalLine,chatTabs);$('console').querySelector('header').after(chatHeader);
  const historyPanel=el('section',undefined,'session-detail-panel');historyPanel.id='session-work-panel';
  const infoPanel=el('section',undefined,'session-detail-panel');infoPanel.id='session-info-panel';
  const conversationPane=$('messages').closest('.conversation-pane');conversationPane.id='session-conversation-panel';
  const conversationPages=$('messages-prev').closest('.pagination');conversationPages.classList.add('conversation-pagination');conversationPane.prepend(conversationPages);
  for(const [id,label] of [['messages-prev','최근 대화 보기'],['messages-next','이전 대화 더 보기']]){const node=$(id);node.textContent=label;node.setAttribute('aria-label',label);node.title=label;node.classList.remove('action-icon');}
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
  function badge(text,tone='neutral'){const node=el('span',text,'work-item-badge');node.dataset.tone=tone;return node;}
  function contextText(metric){const used=metric.context_usage?.used_tokens,size=metric.context_usage?.window_tokens;return Number.isSafeInteger(used)&&used>=0?(Number.isSafeInteger(size)&&size>0?(used/size*100).toFixed(1)+'%':used.toLocaleString()+' 토큰'):'측정값 없음';}
  function tokenText(metric){const known=Number.isFinite(metric.input_tokens)&&Number.isFinite(metric.output_tokens);return known?(metric.input_tokens+metric.output_tokens).toLocaleString()+(metric.input_reports===metric.runs&&metric.output_reports===metric.runs?'':' (일부)'):'미수신';}
  function currentRow(){const id=chatRoute()?.[1]||window.chatState.identity($('project').value,filter);return rows.find(row=>row.chat.id===id);}
  function rebuild(){
    rows=sessionWorkspaceRows(groups,items,metrics,running,workItemView);
    if(loadedProject!==$('project').value)for(const row of rows){row.phase='미확인';if(!row.active.length){row.status=goalsError?'상태 미확인':'확인 중';row.tone='unknown';row.reason=goalsError?'목표 조회 실패':'목표 상태 확인 중';}}
    renderList();decorateTasks();renderChatSummary();renderPath();renderSummary();
  }
  function renderProjectContext(){
    const name=projectLabel($('project').value);summaryLink.textContent=(name?name+' ':'')+'프로젝트 요약 보기';summaryTitle.textContent=(name?name+' ':'')+'프로젝트 요약';
    newTask.disabled=!$('project').value;
    switcherName.textContent=name||'선택하세요';switcher.setAttribute('aria-label','프로젝트 '+switcherName.textContent);switcher.title=switcherName.textContent;projectMenu.replaceChildren();
    for(const option of $('project').options){if(!option.value)continue;const choice=button(option.textContent,async()=>{projectMenu.hidePopover();await selectProject(option.value);});choice.setAttribute('aria-pressed',String(option.selected));projectMenu.append(choice);}
    projectMenu.append(button('전체 프로젝트 보기',()=>{projectMenu.hidePopover();location.hash='#projects';}));
  }
  function decorateTasks(){
    const focused=$('task-list').contains(document.activeElement)?document.activeElement:null;
    sessionCount.textContent='세션 '+groups.filter(chat=>chat.task&&!chat.archived).length;
    for(const node of $('task-list').children){
      const row=rows.find(row=>row.chat.task===node.dataset.task);node.querySelector('.side-session-state')?.remove();if(!row)continue;
      const state=badge(row.status,row.tone);state.classList.add('side-session-state');state.id='side-state-'+row.chat.id;node.append(state);node.querySelector('.task').setAttribute('aria-describedby',state.id);
    }
    rows.forEach((row,index)=>{const node=[...$('task-list').children].find(node=>node.dataset.task===row.chat.task);if(node&&$('task-list').children[index]!==node)$('task-list').insertBefore(node,$('task-list').children[index]||null);});
    if(focused&&document.activeElement!==focused)focused.focus({preventScroll:true});
  }
  function renderSummary(){
    const states=el('dl',undefined,'summary-stats');
    for(const [key,label] of [['running','진행 중'],['attention','확인 필요'],['done','완료']])states.append(el('dt',label),el('dd',String(rows.filter(row=>sessionGroup(row)===key).length)));
    sessionSummary.replaceChildren(el('h2','세션 상태'),states);sessionSummary.firstChild.id='summary-sessions-title';
    goalsSummary.replaceChildren(el('h2','목표 작업'));goalsSummary.firstChild.id='summary-goals-title';
    if(loadedProject!==$('project').value||goalsError){goalsSummary.append(el('p',goalsError?'목표 작업을 불러오지 못했습니다.':'목표 작업을 확인하고 있습니다.'),button('다시 불러오기',refreshGoals));return;}
    const values=items.map(item=>({item,view:workItemView(item)})),counts=el('dl',undefined,'summary-stats');
    for(const [label,count] of [['진행',values.filter(({view})=>!view.waiting&&!view.completed).length],['확인 필요',values.filter(({view})=>view.waiting).length],['완료',values.filter(({view})=>view.completed).length]])counts.append(el('dt',label),el('dd',String(count)));
    goalsSummary.append(counts);
    for(const {item,view} of values.sort((a,b)=>(b.item.updated_at||'').localeCompare(a.item.updated_at||'')).slice(0,2)){
      const link=el('a',item.title);link.href='#chat/'+item.chat_id+'/history';const row=el('p',undefined,'summary-goal');row.append(link,badge(view.status,view.tone));goalsSummary.append(row);
    }
    if(!items.length)goalsSummary.append(el('p','연결된 목표 작업이 없습니다.','hint'));
  }
  async function selectProject(name){
    if($('project').value!==name||!projectReady){$('project').value=name;await loadProject();}
    if(projectReady&&$('project').value===name)location.hash='#dashboard';
  }
  async function refreshProjects(){
    const id=++projectsTicket;projectsStatus.textContent='프로젝트를 불러오는 중…';
    try{
      const data=await api('/projects');
      const loaded=await Promise.all(data.projects.map(async name=>{
        try{const [workspace,chats]=await Promise.all([api('/projects/'+encodeURIComponent(name)+'/workspace'),api('/projects/'+encodeURIComponent(name)+'/tasks')]);return {name,label:data.names?.[name]||name,path:workspace.path,count:chats.tasks.filter(chat=>!chat.archived&&chat.task).length};}
        catch{return {name,label:data.names?.[name]||name,error:true};}
      }));
      if(id!==projectsTicket)return;projectRows=loaded;projectsStatus.textContent='';renderProjects();
    }catch(error){if(id!==projectsTicket)return;projectsStatus.replaceChildren(el('span','프로젝트 조회 실패: '+error.message),button('다시 불러오기',refreshProjects));}
  }
  function renderProjects(){
    const focused=document.activeElement.dataset.project;projectList.replaceChildren();projectsContext.textContent=projectRows.length+'개 프로젝트, 등록된 작업 폴더';
    for(const row of projectRows){
      const card=el('li'),link=el('a',projectLabel(row.name)||row.label);link.href='#dashboard';link.dataset.project=row.name;link.onclick=event=>{event.preventDefault();void act(async()=>{if(![...$('project').options].some(option=>option.value===row.name))await projects($('project').value);await selectProject(row.name);});};
      card.append(link,el('p',row.path||'작업 폴더를 불러오지 못했습니다.','project-card-path'));
      if(row.error)card.append(button('다시 불러오기',refreshProjects));
      else card.append(el('p','세션 '+row.count),el('p','실행 중 '+allRunning.filter(run=>run.project===row.name).length,'hint'));
      projectList.append(card);
    }
    if(!projectRows.length)projectsStatus.textContent='아직 등록된 프로젝트가 없습니다. 프로젝트를 추가해 시작하세요.';
    if(focused)[...projectList.querySelectorAll('a')].find(link=>link.dataset.project===focused)?.focus({preventScroll:true});
  }
  function renderList(){
    const focused=body.contains(document.activeElement)?document.activeElement.dataset.chat:null;
    for(const choice of filters.children){const key=choice.dataset.filter;choice.textContent=filterNames[key]+' '+(key==='all'?rows.length:rows.filter(row=>sessionGroup(row)===key).length);choice.setAttribute('aria-pressed',String(key===selectedFilter));}
    const visible=rows.filter(row=>selectedFilter==='all'||sessionGroup(row)===selectedFilter);listPage=Math.max(0,Math.min(listPage,Math.ceil(visible.length/10)-1));
    const start=listPage*10;range.textContent=(visible.length?start+1:0)+'–'+Math.min(start+10,visible.length)+' / '+visible.length;previous.disabled=!listPage;next.disabled=start+10>=visible.length;body.replaceChildren();
    for(const row of visible.slice(start,start+10)){
      const tr=el('tr'),name=el('td'),open=button(row.title,()=>switchChat(row.chat.task),'session-title-link');open.dataset.chat=row.chat.id;open.title=row.title;open.setAttribute('aria-label',row.title+' 채팅 열기');name.append(open);
      const state=el('td');state.append(badge(row.status,row.tone));
      const phase=el('td');phase.append(row.phase==='—'?el('span','—'):badge(row.phase,'phase'));
      const ai=el('td'),names=el('div',undefined,'session-ai-tags');for(const client of row.clients){const tag=badge(aiName(client),'ai');tag.dataset.client=client;names.append(tag);}ai.append(names);
      if(!row.clients.length)ai.append(el('span','미지정'));
      const context=el('td',contextSummary(row.metrics),'session-context');context.title=context.textContent;tr.append(name,state,phase,ai,context);[...tr.children].forEach((cell,index)=>cell.dataset.label=columns[index]);body.append(tr);
    }
    if(!visible.length){const row=el('tr'),cell=el('td',rows.length?'이 상태의 세션이 없습니다.':$('project').value?'아직 채팅이 없습니다. 새 채팅을 만들어 시작하세요.':'프로젝트를 선택하면 채팅과 작업 상태를 확인할 수 있습니다.');cell.colSpan=5;row.append(cell);body.append(row);}
    if(focused)(body.querySelector('[data-chat="'+focused+'"]')||filters.querySelector('[aria-pressed=true]')).focus({preventScroll:true});
  }
  function renderChatSummary(){
    const row=currentRow();badges.replaceChildren();goalLine.textContent='';
    if(!row)return;
    $('chat-title').textContent=row.title;badges.append(badge(row.status,row.tone));if(row.phase!=='—')badges.append(badge(row.phase,'phase'));for(const client of row.clients){const tag=badge(aiName(client),'ai');tag.dataset.client=client;badges.append(tag);}if(row.mode!=='—')badges.append(badge(row.mode));
    goalLine.textContent=loadedProject!==$('project').value?(goalsError?'목표 상태를 불러오지 못했습니다.':'목표 확인 중'):(row.item?'목표: '+row.item.goal:'목표 연결');goalLine.title=goalLine.textContent;
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
    const details=el('dl',undefined,'session-info-grid');details.append(el('dt','채팅 이름'),el('dd',row.title),el('dt','현재 상태'),el('dd',row.status),el('dt','상태 설명'),el('dd',row.reason||'—'),el('dt','진행 단계'),el('dd',row.phase),el('dt','실행 방식'),el('dd',row.mode));infoPanel.append(details);
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
  function renderPath(){
    const project=$('workspace-project'),screen=$('workspace-screen'),home=project.parentElement.firstElementChild,route=chatRoute(),hash=location.hash;
    const scoped=hash.startsWith('#dashboard')||hash.startsWith('#work-items')||Boolean(route);
    project.textContent=projectLabel($('project').value);project.title=project.textContent;project.hidden=!scoped||!project.textContent;
    project.previousElementSibling.hidden=project.hidden;
    screen.textContent=route?(currentRow()?.title||groups.find(chat=>chat.id===route[1])?.task||'채팅'):
      hash.startsWith('#settings')?'설정':hash.startsWith('#work-items')?'목표 작업':hash==='#dashboard/summary'?'프로젝트 요약':'';
    screen.title=screen.textContent;screen.hidden=!screen.textContent;screen.previousElementSibling.hidden=screen.hidden;
    for(const node of [home,project,screen])node.removeAttribute('aria-current');
    (screen.hidden?(project.hidden?home:project):screen).setAttribute('aria-current','page');
  }
  function navigate(){
    const hash=location.hash,route=chatRoute(),isDashboard=hash==='#dashboard';
    if(['#dashboard/accounts','#dashboard/environment'].includes(hash)){location.replace('#dashboard/summary');return;}
    if(!hash){location.replace('#dashboard');return;}
    renderPath();
    window.setChatNavigation(Boolean(route));$('workspace').classList.toggle('chat-open',Boolean(route));
    const archiveTarget=route?archiveHome:page;if(archive.parentElement!==archiveTarget)archiveTarget.append(archive);
    page.hidden=!isDashboard;summary.hidden=hash!=='#dashboard/summary';const wasProjects=!projectsPage.hidden;projectsPage.hidden=hash!=='#projects';if(!projectsPage.hidden&&!wasProjects)void refreshProjects();
    navigation.setAttribute('aria-current',isDashboard?'page':'false');
    if(hash.startsWith('#work-items')){window.workItems.attachToChat(null);$('work-items-page').setAttribute('role','main');$('console').hidden=true;return;}
    $('work-items-page').removeAttribute('role');
    $('console').hidden=isDashboard||!summary.hidden||!projectsPage.hidden||!$('settings-page').hidden;
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
    selectProject,decorateTasks,renderPath,
    projectFailed(error){loadStatus.replaceChildren(el('p','프로젝트 조회 실패: '+error.message),button('프로젝트 다시 불러오기',loadProject));},
    overviewChanged(active){allRunning=active;if(!projectsPage.hidden)renderProjects();},
    metricsChanged(values,active){metrics=values;running=active;rebuild();if(!loading)void refreshGoals();},
    conversationChanged(messages,chatId){messageRows=messages;messageChat=chatId;rebuild();renderSelectedContent();},
    chatSelected(task,{navigate:shouldNavigate=true}={}){const id=window.chatState.identity($('project').value,task);if(shouldNavigate){location.hash=id?'#chat/'+id:'#dashboard';}else navigate();},
    projectChanged(){selectedFilter='all';listPage=0;ticket++;routeTicket++;loading=false;goalsError='';items=[];metrics=[];running=[];messageRows=[];messageChat=null;loadedProject='';infoSignature='';historySignature='';window.workItems.attachToChat(null);const changed=observedProject!==null&&observedProject!==$('project').value;observedProject=$('project').value;if(changed&&!location.hash.startsWith('#settings')&&location.hash!=='#projects')location.hash='#dashboard';renderProjectContext();loadStatus.textContent=$('project').value?'세션 확인 중…':'';rebuild();navigate();},
    projectReady(){rebuild();navigate();void refreshGoals();},
  };
  window.addEventListener('hashchange',()=>{window.chatState.save();navigate();});
  window.addEventListener('project-names-changed',()=>{renderProjectContext();renderPath();if(!projectsPage.hidden)void refreshProjects();});
  $('sidebar').addEventListener('click',event=>{if(event.target.closest('#open-dashboard')&&$('sidebar').matches(':popover-open'))$('sidebar').hidePopover();});
  if(!location.hash)location.replace('#dashboard');navigate();
})();
