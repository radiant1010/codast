/* Installation is explicit; reading status never starts a login flow. */
(()=>{
  const panel=el('section');panel.id='toolchain-panel';
  const status=el('p','','hint');status.id='tool-status';status.setAttribute('role','status');
  const accounts=el('div',undefined,'tool-accounts'),summary=el('p',undefined,'tool-summary');
  const search=el('input',undefined,'form-control');search.id='tool-search';search.type='search';search.placeholder='이름이나 용도로 검색';search.setAttribute('aria-label','기본 도구 검색');
  const filter=el('select',undefined,'form-select');filter.id='tool-filter';filter.setAttribute('aria-label','도구 범위');
  for(const [value,label] of [['default','기본 도구'],['attention','확인할 항목'],['optional','선택 도구'],['all','전체']]){const option=el('option',label);option.value=value;filter.append(option);}filter.value='default';
  const list=el('div',undefined,'tool-list');list.id='tool-list';
  const empty=el('p','조건에 맞는 도구가 없습니다.','hint');empty.hidden=true;
  const help=el('section',undefined,'tool-help');help.id='tool-help';help.hidden=true;help.tabIndex=-1;help.setAttribute('aria-label','선택한 도구의 연결 안내');
  const errors=el('div',undefined,'tool-errors');errors.id='tool-errors';errors.setAttribute('role','status');
  let busy=false,rows=[];
  const labels={installed:'설치됨',configured:'연결 설정됨',disabled:'설치됨, 꺼짐',partial:'일부 설치됨',missing:'설치 필요',unknown:'설치 미확인',not_initialized:'초기 설치 필요',repair_required:'복구 필요'};
  const names={codex:'Codex',claude:'Claude'};
  const prepared=state=>['installed','configured'].includes(state);
  const install=button('누락된 기본 도구 설치',()=>load(true));install.id='tool-install';
  const refresh=button('상태 새로고침',()=>load());refresh.id='tool-refresh';
  const connections=button('에이전트 연결',()=>window.openConnections());
  const toolbar=el('div',undefined,'tool-toolbar');toolbar.append(install,refresh,connections);
  const filters=el('div',undefined,'tool-toolbar');filters.append(search,filter);
  function applyFilter(){
    let count=0;const query=search.value.trim().toLowerCase();
    for(const {item,card} of rows){
      const attention=Object.values(item.clients).some(c=>!prepared(c.state)||c.connection==='not_verified');
      const included=filter.value==='all'||filter.value==='default'&&item.default||filter.value==='optional'&&!item.default||filter.value==='attention'&&attention;
      card.hidden=!included||!`${item.name} ${item.description}`.toLowerCase().includes(query);if(!card.hidden)count++;
    }
    empty.hidden=count!==0;
  }
  function showHelp(item,client,origin){
    const value=item.clients[client];
    const link=el('a','공식 안내 보기');link.href=item.url;link.target='_blank';link.rel='noopener noreferrer';
    help.replaceChildren(el('h2',item.name+' / '+names[client]),el('p',value.guide),
      el('p','이 화면은 연결 절차만 안내하며 로그인이나 설치를 시작하지 않습니다. 해당 도구에서 연결과 인증을 마친 뒤 상태 새로고침으로 설치 상태를 확인할 수 있습니다. 실제 도구 실행은 해당 도구에서 별도로 확인합니다.','hint'),
      link,button('안내 닫기',()=>{help.hidden=true;origin.focus();}));
    help.hidden=false;help.focus();
  }
  function render(data){
    accounts.replaceChildren();list.replaceChildren();rows=[];
    for(const [client,value] of Object.entries(data.clients)){
      const label=value.state!=='installed'?'CLI 연결 필요':value.auth==='ready'?'CLI 인증 확인':value.auth==='check_required'?'로그인 필요':'CLI 인증 미확인';
      accounts.append(el('span',names[client]+': '+label,'tool-account'));
    }
    let ready=0,total=0;
    for(const item of data.tools){
      const card=el('article',undefined,'tool-card');card.id='tool-card-'+item.id;
      const title=el('div',undefined,'tool-title');title.append(el('h2',item.name),el('span',item.default?'기본':'선택','plugin-scope'));
      card.append(title,el('p',item.description,'hint'));
      const clients=el('div',undefined,'tool-clients');
      for(const [client,value] of Object.entries(item.clients)){
        if(item.default){total++;if(prepared(value.state))ready++;}
        const row=el('div',undefined,'tool-client'),detail=el('div');
        detail.append(el('strong',names[client]),el('span',labels[value.state]||'확인 필요','tool-state'));
        if(value.versions?.length)detail.append(el('span','버전 '+[...new Set(value.versions)].join(', '),'tool-version'));
        if(value.connection==='not_verified')detail.append(el('span',item.kind==='mcp'?'실제 MCP 연결 미검증':'서비스 인증 미확인','tool-version'));
        const guide=button('연결 안내',()=>showHelp(item,client,guide));guide.id='tool-guide-'+item.id+'-'+client;guide.setAttribute('aria-label',item.name+' '+names[client]+' 연결 안내');
        row.append(detail,guide);clients.append(row);
      }
      card.append(clients);list.append(card);rows.push({item,card});
    }
    summary.textContent='기본 도구 준비 '+ready+' / '+total+'개, 양쪽 CLI 기준';
    errors.replaceChildren(...(data.errors||[]).map(e=>el('p',(names[e.client]||'공통')+' / '+e.tool+': '+e.message)));
    applyFilter();
  }
  async function load(mutate=false){
    if(busy)return;busy=true;panel.setAttribute('aria-busy','true');install.disabled=refresh.disabled=true;
    status.textContent=mutate?'누락된 기본 도구를 설치하고 있습니다. 네트워크에 따라 몇 분 걸릴 수 있습니다. 로그인 창은 열지 않습니다.':'양쪽 CLI의 설치 상태를 확인하고 있습니다.';
    try{
      const data=await (mutate?api('/toolchain/install','POST',{}):api('/toolchain'));
      render(data);
      status.textContent=data.installing?'다른 요청에서 설치가 진행 중입니다. 설치가 끝난 뒤 상태 새로고침으로 결과를 확인할 수 있습니다.':data.errors?.length?'일부 도구를 준비하지 못했습니다. 아래 안내를 확인한 뒤 다시 설치할 수 있습니다.':'설치 상태를 확인했습니다. 실제 작업 실행은 별도 확인이 필요합니다.';
    }catch(error){status.textContent=error.message+' 상태 새로고침으로 다시 확인할 수 있습니다.';}
    finally{busy=false;panel.setAttribute('aria-busy','false');install.disabled=refresh.disabled=false;}
  }
  search.oninput=filter.onchange=applyFilter;
  panel.append(el('p','공통 개발 도구를 Codex와 Claude CLI에 준비하며, 이미 설치한 버전과 비활성 상태는 유지합니다. 새 플러그인은 이 컴퓨터의 사용자 범위에 설치됩니다.','hint'),
    accounts,toolbar,status,summary,errors,filters,help,list,empty,
    el('p','선택 도구는 필요에 따라 개별적으로 연결하며, 서비스 로그인과 실제 실행 여부는 설치 상태와 별도로 확인합니다. 프로젝트별로 적용된 플러그인은 플러그인 화면에 표시됩니다.','hint'),
    button('설치된 전체 플러그인 관리',()=>window.settingsPage.open('plugins')));
  panel.addEventListener('settings-open',()=>load());
  window.settingsPage.register('tools','기본 도구',panel);
})();
