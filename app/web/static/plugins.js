/* Installed plugin settings use native state, with independent provider views. */
(()=>{
  const panel=el('section');panel.id='plugins-panel';
  panel.append(button('CODAST 기본 도구 설치와 연결',()=>window.settingsPage.open('tools')));
  const tabs=el('div',undefined,'plugin-tabs');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','플러그인 에이전트');
  panel.append(el('p','현재 프로젝트에서 CLI가 사용하는 플러그인을 관리합니다. 데스크톱 앱의 연결 목록과 다를 수 있습니다.','hint'),tabs);
  const states={},scopes={user:'모든 프로젝트, 나',project:'현재 프로젝트, 모든 사용자',local:'현재 프로젝트, 나',managed:'관리자 지정',cli:'CLI 사용자 설치',unknown:'범위 확인 필요'};
  let selected='codex';
  const endpoint=(project,client)=>'/projects/'+encodeURIComponent(project)+'/plugins/'+client;
  function filter(state){
    const query=state.search.value.trim().toLowerCase();let visible=0;
    for(const [node,text] of state.cards){node.hidden=!text.includes(query);if(!node.hidden)visible++;}
    state.count.textContent=visible+' / '+state.cards.length+'개';state.empty.hidden=visible>0;
    state.empty.textContent=query?'검색 결과가 없습니다.':'설치된 플러그인이 없습니다.';
  }
  function busy(state,value){
    state.busy=value;state.refresh.disabled=value;state.root.setAttribute('aria-busy',String(value));
    for(const [control,supported] of state.controls)control.disabled=value||!supported;
  }
  function render(state,rows){
    const top=state.list.scrollTop;state.list.replaceChildren();state.cards=[];state.controls=[];
    for(const item of rows){
      const card=el('article',undefined,'plugin-card'),detail=el('details',undefined,'plugin-detail'),summary=el('summary');
      const title=el('span',undefined,'plugin-title');title.append(el('strong',item.name),el('span',item.version,'plugin-version'));
      summary.append(title,el('span',item.description||'등록된 설명이 없습니다.','plugin-description'),el('span',scopes[item.scope]||item.scope,'plugin-scope'));
      detail.append(summary);
      detail.append(el('p','설치 출처: '+(item.marketplace||'확인 불가'),'hint'));
      const names={skills:'스킬',agents:'에이전트',commands:'명령',mcp:'MCP',hooks:'훅'};
      for(const [kind,label] of Object.entries(names)){
        const values=item.components?.[kind]||[];
        if(values.length)detail.append(el('p',label+': '+values.join(', '),'plugin-components'));
      }
      detail.append(el('p','설치 폴더에서 확인된 구성입니다. 별도로 지정한 구성 경로는 표시되지 않을 수 있습니다.','hint'));
      if(item.reason)detail.append(el('p',item.reason,'hint'));
      const controls=el('div',undefined,'plugin-controls'),label=el('label',undefined,'form-check form-switch plugin-switch');
      const toggle=el('input',undefined,'form-check-input');toggle.type='checkbox';toggle.setAttribute('role','switch');toggle.setAttribute('aria-label',item.name+' 사용');
      toggle.checked=item.enabled===true;toggle.title=item.reason||scopes[item.scope];
      const canToggle=!!(item.actions?.enable&&item.actions?.disable);toggle.disabled=!canToggle;
      state.controls.push([toggle,canToggle]);
      toggle.onchange=()=>{const action=toggle.checked?'enable':'disable';toggle.checked=item.enabled===true;return change(state,item,action);};
      label.append(toggle,el('span',item.enabled===null?'확인 필요':item.enabled?'켜짐':'꺼짐'));
      const more=el('details',undefined,'plugin-more'),moreTitle=el('summary','더보기');moreTitle.setAttribute('aria-label',item.name+' 관리');
      const menu=el('div',undefined,'plugin-menu');
      for(const [action,text] of [['update','업데이트'],['remove','제거']]){
        const control=button(text,()=>change(state,item,action));control.disabled=!item.actions?.[action];control.title=item.actions?.[action]?text:item.reason;
        state.controls.push([control,!!item.actions?.[action]]);menu.append(control);
      }
      more.append(moreTitle,menu);controls.append(label,more);card.append(detail,controls);state.list.append(card);
      state.cards.push([card,[item.name,item.id,item.description].join(' ').toLowerCase()]);
    }
    filter(state);state.list.scrollTop=top;busy(state,state.busy);
  }
  async function load(state,message=''){
    if(state.mutating)return;
    const project=$('project').value,ticket=++state.ticket;
    if(state.project!==project){state.project=project;render(state,[]);state.loaded=false;}
    if(!project){state.status.textContent='프로젝트를 먼저 선택하세요.';state.empty.hidden=true;busy(state,false);return;}
    busy(state,true);state.empty.hidden=true;state.status.textContent='설치 목록을 확인하고 있습니다.';
    try{
      const data=await api(endpoint(project,state.client));
      if(ticket!==state.ticket||project!==$('project').value)return;
      render(state,data.plugins);state.loaded=true;
      state.status.textContent=message||'설치된 플러그인 '+data.plugins.length+'개를 확인했습니다.';
    }catch(error){
      if(ticket!==state.ticket||project!==$('project').value)return;
      state.loaded=false;state.status.textContent=(message?message+' ':'')+error.message+' 새로고침으로 다시 확인하세요.';
      state.empty.hidden=true;
    }finally{if(ticket===state.ticket){busy(state,false);if(!state.loaded)for(const [control] of state.controls)control.disabled=true;}}
  }
  async function change(state,item,action){
    const project=$('project').value;
    if(state.busy||!state.loaded||project!==state.project||!item.actions?.[action])return;
    if(action==='remove'&&!window.confirm(item.name+' 플러그인을 제거할까요?\n적용 범위: '+(scopes[item.scope]||item.scope)+'\n'+(state.client==='claude'?'플러그인이 저장한 데이터는 보존합니다.':'플러그인 설치와 로컬 캐시가 제거됩니다.')))return;
    const ticket=++state.ticket;state.mutating=true;busy(state,true);state.status.textContent='변경 후 실제 설치 상태를 다시 확인합니다.';
    let failure='';
    try{
      const data=await api(endpoint(project,state.client),'POST',{id:item.id,scope:item.scope,revision:item.revision,action});
      if(ticket!==state.ticket||project!==$('project').value)return;
      render(state,data.plugins);state.status.textContent=data.message;
    }catch(error){if(ticket===state.ticket&&project===$('project').value)failure=error.message;}
    finally{
      state.mutating=false;
      if(ticket===state.ticket){busy(state,false);if(failure)await load(state,failure);}
      else if(!panel.hidden)await load(state);
    }
  }
  async function select(client){
    selected=client;
    for(const [key,state] of Object.entries(states)){
      const active=key===client;state.root.hidden=!active;state.tab.setAttribute('aria-selected',String(active));state.tab.tabIndex=active?0:-1;
    }
    const state=states[client];if(!state.loaded||state.project!==$('project').value)await load(state);
  }
  for(const [client,name] of [['codex','Codex'],['claude','Claude']]){
    const root=el('section',undefined,'plugin-pane');root.id='plugin-pane-'+client;root.setAttribute('role','tabpanel');root.setAttribute('aria-labelledby','plugin-tab-'+client);root.hidden=client!==selected;
    const tab=button(name,()=>select(client));tab.id='plugin-tab-'+client;tab.setAttribute('role','tab');tab.setAttribute('aria-controls',root.id);tab.setAttribute('aria-selected',String(client===selected));tab.tabIndex=client===selected?0:-1;
    tab.onkeydown=event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const next=event.key==='Home'?'codex':event.key==='End'?'claude':client==='codex'?'claude':'codex';states[next].tab.focus();select(next);}};
    tabs.append(tab);
    const search=el('input',undefined,'form-control');search.id='plugin-search-'+client;search.type='search';search.placeholder='설치된 플러그인 검색';search.setAttribute('aria-label',name+' 플러그인 검색');
    const count=el('span','0개','plugin-count'),status=el('p',undefined,'hint plugin-status');status.id='plugin-status-'+client;status.setAttribute('role','status');
    const list=el('div',undefined,'plugin-list');list.id='plugin-list-'+client;list.tabIndex=0;list.setAttribute('aria-label',name+' 설치된 플러그인');
    const empty=el('p',undefined,'plugin-empty');empty.hidden=true;
    const state={client,root,tab,search,count,status,list,empty,controls:[],cards:[],ticket:0,loaded:false,busy:false,project:''};states[client]=state;
    const refresh=button('새로고침',()=>load(state));state.refresh=refresh;
    const toolbar=el('div',undefined,'plugin-toolbar');toolbar.append(search,count,refresh);
    root.append(toolbar,el('p',client==='codex'?'Codex 플러그인은 이 화면에서 설치 상태 조회와 제거를 지원하며, 활성화, 비활성화와 업데이트는 Codex의 플러그인 관리 화면에서 확인할 수 있습니다.':'모든 프로젝트 범위의 변경은 다른 프로젝트에도 적용됩니다. 실행 중인 작업은 현재 로드된 플러그인을 유지합니다.','hint'),status,list,empty);
    search.oninput=()=>filter(state);panel.append(root);
  }
  panel.addEventListener('settings-open',()=>load(states[selected]));
  $('project').addEventListener('change',()=>{
    for(const state of Object.values(states)){state.ticket++;state.loaded=false;state.project='';render(state,[]);}
    if(!panel.hidden)return load(states[selected]);
  });
  window.settingsPage.register('plugins','플러그인',panel);
})();
