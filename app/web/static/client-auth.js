/* Login checks are automatic; opening a native login window requires a click. */
(()=>{
  const panel=el('section',undefined,'client-auth-notice');panel.id='client-auth-notice';panel.hidden=true;
  panel.setAttribute('aria-label','에이전트 로그인');
  const message=el('p',undefined,'hint');message.setAttribute('role','status');
  const list=el('div',undefined,'client-auth-list');
  const refresh=button('다시 확인',()=>check());refresh.setAttribute('aria-label','로그인 상태 다시 확인');
  panel.append(message,list,refresh);document.querySelector('.workspace-status-body').prepend(panel);
  const pending=new Set(),active=state=>['checking','waiting','verifying'].includes(state);
  let rows=[],busy=false,checkAgain=false,timer=null,error='';
  function render(){
    const focusId=list.contains(document.activeElement)?document.activeElement.id:null;
    list.replaceChildren();
    for(const row of rows){
      const signing=pending.has(row.client)||active(row.login?.state);
      if(row.auth==='ready'&&!signing)continue;
      const name=row.client==='claude'?'Claude':'Codex',line=el('div',undefined,'client-auth-row');
      const feedback=pending.has(row.client)?'로그인을 요청하고 있습니다.':row.login?.state!=='ready'?row.login?.message:'';
      const text=feedback||
        (row.state==='missing'?'CLI 설치 또는 경로 확인이 필요합니다.':row.state!=='installed'?'CLI 상태를 확인하지 못했습니다.':row.auth==='check_required'?'로그인이 필요합니다.':'로그인 상태를 확인하지 못했습니다.');
      line.append(el('span',name+': '+text));
      const login=button(signing?'로그인 진행 중':'로그인',()=>start(row.client));
      login.id='login-'+row.client;login.disabled=signing;login.setAttribute('aria-label',name+' 로그인');
      if(row.state==='installed'&&(row.auth==='check_required'||signing))line.append(login);
      else line.append(button('연결 설정',()=>window.openConnections(row.client)));
      list.append(line);
    }
    panel.hidden=!error&&!list.children.length;
    message.hidden=!error;message.textContent=error;refresh.disabled=busy;
    if(focusId)document.getElementById(focusId)?.focus({preventScroll:true});
  }
  async function check(){
    if(busy){checkAgain=true;return;}busy=true;checkAgain=false;refresh.disabled=true;clearTimeout(timer);
    try{
      const data=await api('/clients'),next=data.clients||[];
      const connected=next.some(row=>{const old=rows.find(previous=>previous.client===row.client);return old&&row.auth==='ready'&&(old.auth!=='ready'||row.login?.state==='ready'&&old.login?.state!=='ready');});
      rows=next;error='';
      if(connected)void window.refreshAccountStatus?.();
      window.refreshConnectionsAuth?.(rows);
    }catch{error='로그인 상태를 확인하지 못했습니다. 서버에 다시 연결되면 자동으로 확인합니다.';}
    finally{
      busy=false;render();
      const waiting=pending.size||rows.some(row=>active(row.login?.state));
      timer=setTimeout(check,checkAgain?0:waiting?2000:30000);
    }
  }
  async function start(client){
    if(pending.has(client)||active(rows.find(row=>row.client===client)?.login?.state))return;
    pending.add(client);error='';render();
    try{
      const login=await api('/clients/'+client+'/login','POST',{});
      const row=rows.find(row=>row.client===client);if(row)row.login=login;
    }catch{error='로그인 요청을 보내지 못했습니다. 서버 연결을 확인한 뒤 다시 시도하세요.';}
    finally{pending.delete(client);render();}
    if(!error)await check();
  }
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)void check();});
  window.clientAuth={check,start};
})();
