/* Session workspace. Reuse the existing task-to-native-session contract. */
(()=>{
  function queryStatus(panel,label,refresh){
    const retry=button('',refresh);window.actionIcon(retry,'restore',label+' 다시 조회');
    retry.classList.add('query-refresh');
    panel.querySelector('.section-header-actions').append(retry);
    const head=panel.firstElementChild;
    const body=el('div',undefined,'dashboard-body');
    body.tabIndex=0;body.setAttribute('role','region');body.setAttribute('aria-label',label+' 내용');
    while(head.nextSibling)body.append(head.nextSibling);
    panel.append(body);
    return (state,text)=>{retry.dataset.state=state;retry.title=label+' 다시 조회 · '+text;retry.setAttribute('aria-description',text);retry.disabled=state==='loading';};
  }
  const side=$('sidebar').querySelector('.side-content');
  function closeIcon(label,handler){const node=button('',handler,'account-dialog-close');window.actionIcon(node,'close',label);return node;}
  const sectionDialogs=new Map();
  function sectionDialog(node,label){
    const dialog=el('dialog',undefined,'session-drawer menu-dialog');dialog.id=node.id+'-dialog';
    const heading=el('header'),title=el('h2',label);title.id=dialog.id+'-title';dialog.setAttribute('aria-labelledby',title.id);
    heading.append(title,closeIcon(label+' 닫기',async()=>dialog.close()));dialog.append(heading,node);document.body.append(dialog);
    node.classList.add('menu-dialog-content');sectionDialogs.set(node,dialog);return dialog;
  }
  const connectionIntro=el('div',undefined,'client-connection-intro');
  const connectionHint=$('clients-panel').querySelector('.hint');connectionHint.before(connectionIntro);connectionIntro.append(connectionHint,$('probe-clients'));
  const workspaceHeader=el('div',undefined,'account-dialog-header');
  const workspaceTitle=$('workspace-dialog-title');workspaceTitle.before(workspaceHeader);workspaceHeader.append(workspaceTitle,$('cancel-workspace'));
  $('cancel-workspace').textContent='×';$('cancel-workspace').className='account-dialog-close';$('cancel-workspace').setAttribute('aria-label','프로젝트 연결 닫기');$('cancel-workspace').title='닫기';
  function openSection(node){const dialog=sectionDialogs.get(node);node.open=true;dialog.showModal();dialog.scrollTop=0;if(node.id==='rules-panel')act(()=>window.openRulebook?.());}
  const project=$('project-panel');project.querySelector('summary').textContent='프로젝트';
  const chats=el('section',undefined,'chat-navigation');
  const title=el('div',undefined,'side-title');const titleActions=el('div',undefined,'section-header-actions');titleActions.append($('reload'));title.append(el('h2','채팅 세션'),titleActions);chats.append(title);
  const createChat=el('dialog',undefined,'session-drawer'),chatForm=el('form');
  const chatLabel=el('label','새 채팅 이름'),chatInput=el('input');chatInput.id='new-chat-name';chatInput.maxLength=120;chatInput.required=true;chatLabel.htmlFor=chatInput.id;
  const createButton=el('button');createButton.type='submit';window.actionIcon(createButton,'plus','새 채팅 만들기');
  const chatHeader=el('div',undefined,'account-dialog-header');chatHeader.append(el('h2','새 채팅'),closeIcon('새 채팅 닫기',async()=>createChat.close()));
  const chatRow=el('div',undefined,'field-action-row');chatRow.append(chatInput,createButton);
  const chatField=el('div',undefined,'form-field');chatField.append(chatLabel,chatRow);
  chatForm.className='modal-form';chatForm.append(chatHeader,chatField);createChat.append(chatForm);document.body.append(createChat);
  chatForm.onsubmit=event=>{event.preventDefault();act(async()=>{
    const name=chatInput.value.trim();if(!name)throw Error('채팅 이름을 입력하세요.');
    if(groups.some(g=>g.task===name)||window.chatState.drafts($('project').value).includes(name))throw Error('같은 이름의 채팅이 있습니다. 목록에서 선택하세요.');
    await api(base()+'/tasks','POST',{task:name});createChat.close();await switchChat(name);$('text').focus();notice('새 채팅을 저장했습니다. 작성 중인 내용도 이 브라우저에 보관됩니다.');
  });};
  chats.append(button('＋ 새 채팅',async()=>{
    if(!$('project').value)throw Error('프로젝트를 먼저 선택하세요.');
    chatInput.value='';createChat.showModal();chatInput.focus();
  },'new-chat'),$('task-list'),$('chat-archive'));
  project.querySelector('.side-title').remove();
  const projectTools=el('details');projectTools.id='project-tools';projectTools.append(el('summary','프로젝트 관리'),$('project-management'),$('create'));sectionDialog(projectTools,'프로젝트 관리');
  const path=el('p','프로젝트를 선택하세요.','project-location');const projectGit=el('p','Git · 프로젝트 선택 대기','hint');project.append(path,projectGit);
  const menu=el('nav',undefined,'workspace-menu');menu.setAttribute('aria-label','작업실 메뉴');
  for(const [id,label] of [['settings-panel','실행 설정'],['clients-panel','에이전트 연결'],['history-panel','실행 기록'],['rules-panel','작업 룰북'],['setup-guide','시작 도움말']]){
    const node=$(id);sectionDialog(node,label);menu.append(button(label,async()=>id==='clients-panel'&&window.openConnections?window.openConnections():openSection(node)));
  }
  menu.append(button('프로젝트 관리',async()=>openSection(projectTools)));
  const overview=$('overview').closest('details');projectTools.append(overview);
  side.replaceChildren(project,chats,menu);$('setup-guide').open=false;
  const importDialog=el('dialog',undefined,'session-drawer');
  const importHead=el('div',undefined,'account-dialog-header'),importClose=button('',async()=>importDialog.close());
  window.actionIcon(importClose,'close','세션 내용 불러오기 닫기');importHead.append(el('h2','세션 내용 불러오기'),importClose);
  const importList=el('div'),importPreview=el('div'),importStatus=el('p',undefined,'hint');importStatus.setAttribute('role','status');
  const importClient=el('div',undefined,'agent-segment');importClient.setAttribute('role','group');importClient.setAttribute('aria-label','불러올 세션 에이전트');
  let selectedImportClient='codex';
  for(const [value,label] of [['codex','Codex'],['claude','Claude']]){
    const choice=button(label,async()=>{
      if(selectedImportClient===value)return;
      selectedImportClient=value;
      for(const item of importClient.children)item.setAttribute('aria-pressed',String(item===choice));
      importCursor=null;nextThreads.hidden=true;importList.replaceChildren();importPreview.replaceChildren();await loadThreads();
    });choice.setAttribute('aria-pressed',String(value===selectedImportClient));importClient.append(choice);
  }
  const nextThreads=button('다음 목록 ›',async()=>loadThreads(true));nextThreads.title='다음 20개 세션 보기';nextThreads.hidden=true;
  const importScope=el('p',undefined,'hint');
  importDialog.append(importHead,importScope,importClient,el('p','현재 프로젝트와 작업 경로가 같은 세션만 표시합니다. 다른 프로젝트의 대화는 불러오지 않습니다. 세션 내용을 확인한 뒤 연결하세요.','hint'),importStatus,importList,nextThreads,importPreview);document.body.append(importDialog);
  let importProject='',importCursor=null;
  async function loadThreads(more=false){
    const selected=importProject,agent=selectedImportClient;importStatus.textContent='조회 중…';nextThreads.disabled=true;
    try{const data=await api('/projects/'+encodeURIComponent(selected)+'/native-threads/'+agent+(more&&importCursor?'?cursor='+encodeURIComponent(importCursor):''));
      if(selected!==importProject||agent!==selectedImportClient)return;importList.replaceChildren();importPreview.replaceChildren();
      for(const thread of data.threads){const row=el('div',undefined,'native-thread-choice'),label=el('span',thread.name||thread.preview?.slice(0,100)||'이름 없는 세션');
        const view=button('선택',async()=>previewThread(thread,selected,agent));view.title='선택한 세션 내용 미리보기';row.append(label,view);importList.append(row);}
      importCursor=data.next_cursor;nextThreads.hidden=!importCursor;importStatus.textContent=data.threads.length?data.threads.length+'개 세션 · 현재 프로젝트의 저장 기록':'현재 프로젝트에 불러올 '+(agent==='codex'?'Codex':'Claude')+' 세션이 없습니다.';
    }catch(error){importStatus.textContent=error.message;}finally{nextThreads.disabled=false;}
  }
  async function previewThread(thread,selected,agent){
    importStatus.textContent='대화 조회 중…';importPreview.replaceChildren();
    try{const data=await api('/projects/'+encodeURIComponent(selected)+'/native-threads/'+agent+'/'+encodeURIComponent(thread.id));
      if(selected!==importProject||agent!==selectedImportClient)return;importStatus.textContent=data.preview_scope;
      const transcript=el('div',undefined,'native-thread-preview');for(const message of data.messages){transcript.append(el('strong',message.role==='user'?'사용자':agent==='codex'?'Codex':'Claude'),el('pre',message.text));if(message.delivery_details){const details=el('details');details.append(el('summary','전달 내용 상세'+(message.details_truncated?' · 일부 표시':'')),el('pre',message.delivery_details));transcript.append(details);}}
      if(!data.messages.length)transcript.append(el('p','표시할 저장 메시지가 없습니다.'));
      const name=el('input');name.maxLength=120;name.value=(thread.name||'불러온 세션').slice(0,120);name.setAttribute('aria-label','연결할 새 채팅 이름');
      const ack=el('input');ack.type='checkbox';const ackLabel=el('label',undefined,'check');ackLabel.append(ack,document.createTextNode('다른 창이나 CLI에서 이 세션의 실행을 멈췄습니다. 동시 실행하지 않겠습니다.'));
      const attach=button('선택',async()=>{if(!ack.checked)return;attach.disabled=true;
        try{if($('project').value!==selected||agent!==selectedImportClient)throw Error('프로젝트가 변경되었습니다. 다시 열어 주세요.');
          window.chatState.save();
          const linked=await api('/projects/'+encodeURIComponent(selected)+'/native-threads/'+agent+'/'+encodeURIComponent(thread.id)+'/attach','POST',{task:name.value});
          if($('project').value!==selected)throw Error('세션은 원래 프로젝트에 연결됐습니다. 해당 프로젝트에서 채팅을 선택하세요.');window.chatState.seed(selected,linked.task,{client:linked.client,cwd:'.',mode:'read-only',model:null,paths:[],fresh:false,action:'run'});importDialog.close();await switchChat(linked.task);actionHint();notice('세션 연결 완료 · 다음 메시지는 선택한 에이전트에서 이어서 실행합니다.');
        }catch(error){importStatus.textContent=error.message;}finally{attach.disabled=!ack.checked;}});
      attach.title='선택한 세션을 새 채팅에 연결';attach.disabled=true;ack.onchange=()=>attach.disabled=!ack.checked;
      const entry=el('div',undefined,'client-path-row');entry.append(name,attach);importPreview.append(transcript,ackLabel,entry);
    }catch(error){importStatus.textContent=error.message;}
  }
  const findThreads=button('',async()=>{if(!$('project').value)throw Error('프로젝트를 먼저 선택하세요.');importProject=$('project').value;importScope.textContent='조회 범위 · '+importProject+' 프로젝트';importCursor=null;importPreview.replaceChildren();importList.replaceChildren();importDialog.showModal();await loadThreads();});
  window.actionIcon(findThreads,'importDocument','세션 내용 불러오기');titleActions.append(findThreads);
  const top=el('section',undefined,'session-dashboard');top.setAttribute('aria-label','에이전트와 실행 중인 세션');
  const usage=el('section',undefined,'usage-panel');
  const usageHeading=el('div',undefined,'usage-heading');usageHeading.append(el('h2','토큰 사용량 · 누적 합계'));usage.append(usageHeading);
  for(const client of ['codex','claude']){
    const row=el('div',undefined,'usage-row');row.append(el('strong',client==='codex'?'Codex':'Claude'));
    const detail=el('p','현재 프로젝트 기록 없음','hint');detail.id='usage-'+client;row.append(detail);usage.append(row);
  }
  usage.append(el('p','현재 프로젝트 전체 기록 · 계정 한도·컨텍스트 점유율과 별개','hint'));
  const usageDetails=el('section',undefined,'session-usage-details');usageDetails.id='recent-session-usage';usageDetails.hidden=true;
  usageDetails.append(el('p','에이전트별 최근 채팅 3개 · 마지막 실행 순 · 완료 포함','hint'));
  const toggleUsage=button('+',async()=>{usageDetails.hidden=!usageDetails.hidden;toggleUsage.textContent=usageDetails.hidden?'+':'−';toggleUsage.setAttribute('aria-expanded',String(!usageDetails.hidden));toggleUsage.setAttribute('aria-label',usageDetails.hidden?'최근 세션 사용량 펼치기':'최근 세션 사용량 접기');});
  toggleUsage.setAttribute('aria-label','최근 세션 사용량 펼치기');toggleUsage.setAttribute('aria-expanded','false');toggleUsage.setAttribute('aria-controls',usageDetails.id);usageHeading.append(toggleUsage);
  const usageList=el('div');usageList.id='session-usage-list';usageDetails.append(usageList);usage.append(usageDetails);
  const running=el('section',undefined,'running-panel');const rh=el('div',undefined,'side-title');rh.append(el('h2','작업 중인 세션'));
  const alerts=button('알림 0',async()=>{$('session-alerts').hidden=!$('session-alerts').hidden;});alerts.id='session-notifications';rh.append(alerts);running.append(rh);
  const list=el('div');list.id='running-sessions';running.append(list);top.append(usage,running);$('console').prepend(top);
  const account=el('section',undefined,'codex-account-summary');
  const accountLabel=el('h2','계정 사용량');
  const accountDetails=el('dialog',undefined,'session-drawer');
  const accountHeader=el('div',undefined,'account-dialog-header');
  const accountClose=button('×',async()=>accountDetails.close(),'account-dialog-close');
  accountClose.setAttribute('aria-label','조회 정보 닫기');accountClose.title='닫기';
  accountHeader.append(el('h2','Codex 조회 정보'),accountClose);accountDetails.append(accountHeader);
  const accountBody=el('div');accountDetails.append(accountBody);document.body.append(accountDetails);
  const accountHead=el('div',undefined,'compact-panel-head'),accountActions=el('div',undefined,'section-header-actions');
  const accountDetail=button('모델·한도',async()=>accountDetails.showModal());accountDetail.title='모델 · 한도 상세';
  accountActions.append(accountDetail);accountHead.append(accountLabel,accountActions);account.append(accountHead);
  const accountTable=el('table',undefined,'dashboard-table account-table'),accountThead=el('thead'),accountTitles=el('tr');
  for(const name of ['AI','한도 사용률','초기화'])accountTitles.append(el('th',name));
  accountThead.append(accountTitles);const accountRows=el('tbody');accountTable.append(accountThead,accountRows);account.append(accountTable);
  function accountPlaceholder(client,text){const row=el('tr');row.append(el('td',client),el('td',text),el('td','—'));return row;}
  accountRows.append(accountPlaceholder('Codex','조회 중…'),accountPlaceholder('Claude','미수집'));
  const metrics=el('dialog',undefined,'session-drawer');
  const metricsHead=el('div',undefined,'account-dialog-header');
  const metricsClose=button('×',async()=>metrics.close(),'account-dialog-close');metricsClose.setAttribute('aria-label','사용량 닫기');
  metricsHead.append(el('h2','세션 · 사용량 상세'),metricsClose);metrics.append(metricsHead,usage,running);document.body.append(metrics);
  usageDetails.hidden=false;toggleUsage.remove();
  menu.append(button('사용량 대시보드',async()=>metrics.showModal()));
  const sessionsPanel=el('section',undefined,'compact-session-panel');
  const sessionsHead=el('div',undefined,'compact-panel-head'),sessionActions=el('div',undefined,'section-header-actions');
  sessionActions.append(alerts,button('상세',async()=>metrics.showModal()));sessionsHead.append(el('h2','AI 세션'),sessionActions);
  const table=el('table',undefined,'compact-session-table'),thead=el('thead'),tr=el('tr');
  for(const name of ['AI / 채팅','상태','컨텍스트','누적 토큰','실행 모델'])tr.append(el('th',name));
  thead.append(tr);const sessionRows=el('tbody');table.append(thead,sessionRows);sessionsPanel.append(sessionsHead,table);
  const environment=el('section',undefined,'compact-environment'),envHead=el('div',undefined,'compact-panel-head');
  envHead.append(el('h2','실행 환경'),el('div',undefined,'section-header-actions'));environment.append(envHead);
  const envProject=el('span','프로젝트를 선택하세요.','environment-project');envHead.insertBefore(envProject,envHead.lastChild);
  const envValues=el('table',undefined,'dashboard-table environment-table'),envTitles=el('tr'),envThead=el('thead'),envRows=el('tbody'),envFields={},envStates={};
  for(const name of ['항목','상태','값'])envTitles.append(el('th',name));envThead.append(envTitles);envValues.append(envThead,envRows);
  for(const name of ['Git','포트','Docker']){const row=el('tr'),value=el('td','—','environment-value'),state=el('td','● 선택 대기','environment-state');envFields[name]=value;envStates[name]=state;row.append(el('td',name),state,value);envRows.append(row);}environment.append(envValues);
  function environmentState(name,text,kind='idle'){envStates[name].textContent='● '+text;envStates[name].dataset.state=kind;}
  let envBusy=false,envProjectKey=null,envTicket=0;
  const envStatus=queryStatus(environment,'실행 환경',refreshEnvironment);
  async function refreshEnvironment(){
    const projectName=$('project').value;
    if(projectName!==envProjectKey){envProjectKey=projectName;envTicket++;envBusy=false;envProject.textContent=projectName||'프로젝트를 선택하세요.';for(const [name,value] of Object.entries(envFields)){value.textContent='—';value.title='';environmentState(name,projectName?'확인 중':'선택 대기',projectName?'loading':'idle');}}
    projectGit.textContent='Git · '+envFields.Git.textContent;
    if(!projectName){envStatus('idle','프로젝트 선택 대기');return;}if(envBusy)return;envBusy=true;
    envStatus('loading','실행 환경 확인 중');
    const ticket=++envTicket;
    try{
      const data=await api('/projects/'+encodeURIComponent(projectName)+'/environment');
      if($('project').value!==projectName||ticket!==envTicket)return;
      const state={not_installed:'미설치',not_repository:'저장소 아님',error:'조회 실패',unavailable:'엔진 연결 불가'};
      envFields.Git.textContent=data.git.state==='available'?(data.git.branch||'브랜치 미확인')+' · '+(data.git.changed_entries?'변경 '+data.git.changed_entries+'건':'변경 없음'):state[data.git.state]||'확인 불가';
      projectGit.textContent='Git · '+envFields.Git.textContent;
      envFields.Git.title=envFields.Git.textContent;
      envFields.Docker.textContent=data.docker.state==='available'?(data.docker.containers.length?data.docker.containers.filter(c=>c.state==='running').length+'개 실행 / '+data.docker.containers.length+'개 연결':'연결된 Compose 없음'):state[data.docker.state]||'확인 불가';
      envFields.Docker.title='선택 프로젝트 경로와 Compose 작업 경로가 정확히 일치하는 컨테이너만 표시';
      envFields['포트'].textContent=data.ports.values.length?data.ports.values.join(', '):'호스트 미수집';
      envFields['포트'].title='Docker 포트: '+(data.ports.values.join(', ')||'확인된 포트 없음')+' · 일반 개발 서버 포트는 아직 미수집';
      for(const [name,result] of [['Git',data.git],['Docker',data.docker]]){
        const ok=result.state==='available';environmentState(name,ok?'정상':state[result.state]||'미확인',ok?'ready':['error','unavailable'].includes(result.state)?'error':'idle');
        if(!ok)envFields[name].textContent='—';
      }
      environmentState('포트',data.ports.values.length?'Docker':'미수집',data.ports.values.length?'ready':'idle');
      if(!data.ports.values.length)envFields['포트'].textContent='—';
      for(const field of [envFields.Git,envFields['포트']])field.title=field.title||field.textContent;
      const failed=['error','unavailable'].includes(data.git.state)||['error','unavailable'].includes(data.docker.state);
      envStatus(failed?'error':'ready',failed?'일부 조회 실패 · 다시 조회하세요.':'확인 '+new Date().toLocaleTimeString());
    }catch(error){if($('project').value===projectName&&ticket===envTicket){for(const name of Object.keys(envStates))environmentState(name,'조회 실패','error');projectGit.textContent='Git · '+envFields.Git.textContent;envStatus('error','조회 실패 · 다시 조회하세요.');}}finally{if(ticket===envTicket)envBusy=false;}
  }
  setInterval(()=>{if(!document.hidden)refreshEnvironment();},15000);
  top.replaceChildren(sessionsPanel,account,environment);
  let statusBusy=false;
  const accountStatus=queryStatus(account,'계정 정보',refreshAccount);
  async function refreshAccount(){
    if(statusBusy)return;statusBusy=true;
    accountStatus('loading','계정 정보 확인 중');
    try{
      const data=await api('/clients/codex/status');
      if(data.state==='error')throw Error('계정 조회 실패');
      accountBody.replaceChildren();
      accountStatus(data.state==='error'?'error':'ready',data.state==='error'?'조회 실패 · 다시 조회할 수 있습니다.':'확인 '+new Date(data.checked_at).toLocaleTimeString());
      const duration=minutes=>minutes===10080?'주간':minutes===300?'5시간':minutes?minutes+'분':'기간 미제공';
      accountRows.replaceChildren();
      for(const limit of data.limits.filter(row=>row.bucket==='codex')){
        const row=el('tr'),known=typeof limit.usedPercent==='number'&&Number.isFinite(limit.usedPercent);
        const value=el('td',duration(limit.windowDurationMins)+' '+(known?limit.usedPercent+'%':'미수신'));
        const reset=limit.resetsAt?new Date(limit.resetsAt*1000):null;
        row.append(el('td','Codex'),value,el('td',reset&&!Number.isNaN(reset.getTime())?reset.toLocaleString('ko-KR',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}):'미제공'));accountRows.append(row);
      }
      if(!accountRows.children.length)accountRows.append(accountPlaceholder('Codex',data.state==='not_installed'?'CLI 미설치':'한도 미제공'));
      accountRows.append(accountPlaceholder('Claude','미수집'));
      const limits=el('div',undefined,'account-limits');
      for(const row of [...data.limits].sort((a,b)=>(a.bucket==='codex'?0:1)-(b.bucket==='codex'?0:1))){
        const card=el('section',undefined,'account-limit');
        const name=(row.name||(row.bucket==='codex'?'Codex':row.bucket))+' · '+duration(row.windowDurationMins);
        card.append(el('h3',name));
        const meter=el('div',undefined,'account-limit-meter');
        const known=typeof row.usedPercent==='number'&&Number.isFinite(row.usedPercent);
        if(known){const bar=el('progress');bar.max=100;bar.value=Math.max(0,Math.min(100,row.usedPercent));bar.setAttribute('aria-label',name+' 사용률');meter.append(bar);}
        meter.append(el('span',known?row.usedPercent+'% 사용':'사용률 미제공'));card.append(meter);
        const reset=row.resetsAt?new Date(row.resetsAt*1000):null;
        card.append(el('p','초기화 · '+(reset&&!Number.isNaN(reset.getTime())?reset.toLocaleString('ko-KR',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'미제공'),'account-limit-reset'));limits.append(card);
      }
      if(!data.limits.length)limits.append(el('p','한도 정보를 받지 못했습니다.','hint'));
      accountBody.append(limits);
      accountBody.append(el('h3','사용 가능한 모델'));
      for(const model of data.models)accountBody.append(el('p',(model.displayName||model.model)+(model.isDefault?' · 목록 기본값':'')));
      if(!data.models.length)accountBody.append(el('p','모델 목록을 받지 못했습니다.'));
      accountBody.append(el('p','목록 기본값은 실제 실행 모델을 뜻하지 않습니다. 실행 모델·컨텍스트는 아직 미수집입니다.','hint'),el('p','계정 범위 · '+data.source+' · 확인 '+new Date(data.checked_at).toLocaleString()+' · 최대 60초 캐시','hint'));
    }catch(error){if(accountRows.textContent.includes('조회 중…'))accountRows.replaceChildren(accountPlaceholder('Codex','조회 실패'),accountPlaceholder('Claude','미수집'));accountStatus('error','조회 실패 · 다시 조회하세요.');}finally{statusBusy=false;}
  }
  refreshAccount();setInterval(()=>{if(!document.hidden)refreshAccount();},60000);
  const alertBox=el('div',undefined,'session-alerts');alertBox.id='session-alerts';alertBox.hidden=true;alertBox.setAttribute('role','status');alertBox.textContent='이 화면을 연 이후 실행 종료 알림이 표시됩니다.';top.after(alertBox);
  const expand=button('확장',async()=>{const on=$('workspace').classList.toggle('console-expanded');expand.textContent=on?'복원':'확장';expand.setAttribute('aria-pressed',String(on));});expand.setAttribute('aria-pressed','false');$('console').querySelector('header').append(expand);
  const native=el('div',undefined,'native-session');native.id='native-session';$('console').querySelector('header').after(native);
  const composer=$('composer'),picker=el('div',undefined,'agent-picker');const label=el('label','AI 에이전트');label.htmlFor='client';picker.append(label,$('client'));composer.prepend(picker);
  const oldLabel=$('settings-panel').querySelector('label[for="client"]');oldLabel.remove();
  $('action').value='run';$('auto-route').checked=false;
  const options=$('composer').querySelector('.composer-options');const advanced=el('details',undefined,'chat-options');advanced.append(el('summary','메시지 옵션'),options);composer.append(advanced);
  const entry=el('div',undefined,'command-entry');$('text').before(entry);entry.append($('text'),$('send'));
  $('text').placeholder='선택한 에이전트에게 메시지를 보내세요. Ctrl+Enter로 전송';$('text').rows=2;
  $('task-name').placeholder='채팅 이름';$('task-name').parentElement.firstChild.textContent='대상 채팅';
  $('welcome').querySelector('h2').textContent='프로젝트를 연결하고, 대화를 시작하세요.';
  $('welcome').querySelector('p').textContent='채팅 기록과 에이전트 세션을 한곳에서 이어갑니다.';
  // A named chat is required for native resume; no silent topic classification.
  composer.addEventListener('submit',event=>{
    if(!$('task-name').value.trim()){
      event.preventDefault();event.stopImmediatePropagation();notice('새 채팅을 만들거나 기존 채팅을 선택하세요.',true);
    }
  },true);
  let snapshot={sessions:[],running:[]},previous=null,notifications=0,inFlight=false;
  const sessionStatus=queryStatus(sessionsPanel,'세션 현황',refresh);
  async function openChat(projectName,task){
    if(metrics.open)metrics.close();
    if($('project').value!==projectName){$('project').value=projectName;await loadProject();}
    await switchChat(task);
  }
  function renderNative(){
    path.textContent=$('workspace-root').value||'프로젝트를 선택하세요.';
    native.replaceChildren();const rows=snapshot.sessions.filter(s=>s.project===$('project').value&&s.task===filter);
    if(!rows.length){native.textContent=filter?'연결된 네이티브 세션 없음 · Codex/Claude 성공 실행 후 표시됩니다.':'채팅을 선택하면 연결된 에이전트 세션이 표시됩니다.';return;}
    for(const s of rows){const item=el('span',s.client+' · '+s.session_id+' · '+s.mode);item.title=s.cwd;native.append(item);}
  }
  function renderUsage(){
    const rows=(snapshot.usage||[]).filter(row=>row.project===$('project').value);
    envProject.textContent=$('project').value||'프로젝트를 선택하세요.';
    for(const client of ['codex','claude']){
      const agentRows=rows.filter(row=>row.client===client);
      const total=kind=>agentRows.some(r=>r[kind+'_reports']>0)?agentRows.reduce((n,r)=>n+(r[kind+'_tokens']??0),0).toLocaleString():'미수신';
      $('usage-'+client).textContent=agentRows.length?'입력 '+total('input')+' / 출력 '+total('output')+' · '+agentRows.reduce((n,r)=>n+r.runs,0)+'회 실행':'수집된 토큰 정보 없음';
    }
    usageList.replaceChildren();
    const chatsByAgent=new Map();
    for(const row of rows){
      const key=JSON.stringify([row.client,row.task]);
      if(!chatsByAgent.has(key))chatsByAgent.set(key,{...row});
      else{const chat=chatsByAgent.get(key);for(const field of ['runs','running','input_reports','output_reports'])chat[field]+=row[field];
        for(const field of ['input_tokens','output_tokens'])if(row[field]!==null)chat[field]=(chat[field]??0)+row[field];
        if((row.last_started_at||'')>(chat.last_started_at||''))chat.last_started_at=row.last_started_at;
      }
    }
    const counts=new Map();
    const summaries=new Map(chatsByAgent);
    for(const run of snapshot.running.filter(r=>r.project===$('project').value)){
      const client=run.command.client||run.adapter,task=run.command.task||'',key=JSON.stringify([client,task]);
      const row=summaries.get(key)||{client,task,project:run.project,input_tokens:null,output_tokens:null,runs:0,input_reports:0,output_reports:0};
      row.liveState=run.cancellable?'실행 중':'종료 확인 필요';summaries.set(key,row);
    }
    sessionRows.replaceChildren();
    for(const row of [...summaries.values()].sort((a,b)=>Number(Boolean(b.liveState))-Number(Boolean(a.liveState))||(b.last_started_at||'').localeCompare(a.last_started_at||''))){
      const tr=el('tr'),name=el('td');name.append(button(row.client+' · '+(row.task||'미분류'),()=>openChat(row.project,row.task)));tr.append(name,el('td',row.liveState||'실행 없음'),el('td','미수집'));
      const known=row.input_tokens!==null&&row.output_tokens!==null;
      const complete=known&&row.input_reports===row.runs&&row.output_reports===row.runs;
      const token=el('td',known?(row.input_tokens+row.output_tokens).toLocaleString()+(complete?'':' (일부)'):'미수신');
      token.title='현재 프로젝트 · 해당 AI/채팅의 저장된 누적 입력+출력';tr.append(token,el('td','미수집'));sessionRows.append(tr);
    }
    if(!summaries.size){const empty=el('td',$('project').value?'아직 실행 기록이 없습니다.':'프로젝트를 선택하면 세션이 표시됩니다.');empty.colSpan=5;sessionRows.append(el('tr'));sessionRows.lastChild.append(empty);}
    for(const row of [...chatsByAgent.values()].sort((a,b)=>a.client.localeCompare(b.client)||(b.last_started_at||'').localeCompare(a.last_started_at||''))){
      const count=counts.get(row.client)||0;if(count>=3)continue;counts.set(row.client,count+1);
      const item=el('div',undefined,'session-usage-item');
      item.classList.toggle('selected',row.task===filter);
      item.append(button((row.task||'미분류')+' · '+row.client,()=>openChat(row.project,row.task)));
      item.append(el('p','입력 '+(row.input_tokens===null?'미수신':row.input_tokens.toLocaleString())+' / 출력 '+(row.output_tokens===null?'미수신':row.output_tokens.toLocaleString())+' 토큰','usage-count'));
      item.append(el('p',row.runs+'회 실행 · 입력 수신 '+row.input_reports+'/'+row.runs+' · 출력 수신 '+row.output_reports+'/'+row.runs+(row.running?' · 실행 중 '+row.running+'회':''),'hint'));
      item.append(el('p','마지막 실행 '+(row.last_started_at?new Date(row.last_started_at).toLocaleString():'확인 불가'),'hint'));usageList.append(item);
    }
    if(!rows.length)usageList.append(el('p','프로젝트를 선택하고 실행하면 세션별 사용량이 표시됩니다.','hint'));
  }
  window.refreshSessionView=()=>{
    refreshEnvironment();
    renderUsage();
    renderNative();refresh();
  };
  async function refresh(){
    if(inFlight)return;inFlight=true;
    sessionStatus('loading','세션 현황 확인 중');
    try{
      const next=await api('/session-overview');snapshot=next;list.replaceChildren();
      for(const run of next.running){const item=el('div');item.append(button((run.command.client||run.adapter)+' / '+run.project+' / '+(run.command.task||'미분류')+' · '+(run.cancellable?'실행 중':'종료 확인 필요'),()=>openChat(run.project,run.command.task||''),'running-session'),el('p','컨텍스트 윈도우 사용량 · 미수집','hint'));list.append(item);}
      if(!next.running.length)list.append(el('p','실행 중인 세션이 없습니다.','hint'));
      if(previous){for(const run of previous.filter(old=>!next.running.some(r=>r.id===old.id))){notifications++;alertBox.prepend(el('p',run.project+' · '+(run.command.task||'미분류')+' 실행 상태가 변경되었습니다. 기록을 확인하세요.'));}}
      previous=next.running;alerts.textContent='알림 '+notifications;renderNative();renderUsage();
      sessionStatus('ready','확인 '+new Date().toLocaleTimeString());
    }catch(error){sessionStatus('error','조회 실패 · 다시 조회하세요.');}finally{inFlight=false;}
  }
  $('project').addEventListener('change',()=>{refreshEnvironment();for(const c of ['codex','claude'])$('usage-'+c).textContent='수집된 토큰 정보 없음';});
  $('welcome-start').onclick=()=>openSection(projectTools);
  refresh();setInterval(()=>{if(!document.hidden)refresh();},5000);actionHint();
})();
