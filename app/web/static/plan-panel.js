(()=>{
  const panel=el('section');panel.id='plan-panel';panel.hidden=true;panel.setAttribute('aria-label','작업 계획');
  $('composer').before(panel);
  const heading=el('div',undefined,'plan-heading'),title=el('h2','작업 계획 (Claude)'),count=el('span',undefined,'plan-count');
  const summary=el('span',undefined,'plan-summary'),header=el('div',undefined,'plan-header');
  const body=el('div',undefined,'plan-body'),list=el('ol'),earlierList=el('ol'),notice=el('p',undefined,'plan-notice');
  body.id='plan-panel-body';earlierList.id='plan-panel-earlier';earlierList.hidden=true;
  const narrow=matchMedia('(width < 760px)'),storageKey='codast.plan-panel.collapsed';
  let collapsed=narrow.matches,chat=null,project='',generation=0,requestNumber=0,timer;
  try{if(!narrow.matches)collapsed=localStorage.getItem(storageKey)==='true';}catch{}
  const toggle=button('',()=>{
    collapsed=!collapsed;
    try{localStorage.setItem(storageKey,String(collapsed));}catch{}
    fold();
  });
  toggle.setAttribute('aria-controls',body.id);
  const earlier=button('',()=>{
    earlierList.hidden=!earlierList.hidden;
    earlier.setAttribute('aria-expanded',String(!earlierList.hidden));
  });
  earlier.setAttribute('aria-controls',earlierList.id);earlier.setAttribute('aria-expanded','false');
  heading.append(title,count);header.append(heading,summary,toggle);body.append(list,earlier,earlierList);panel.append(header,notice,body);
  function fold(){
    panel.classList.toggle('is-collapsed',collapsed);body.hidden=collapsed;
    toggle.textContent=collapsed?'펼치기':'접기';toggle.setAttribute('aria-expanded',String(!collapsed));
  }
  function row(item){
    const status=item.status||'completed',labels={pending:'대기',in_progress:'진행 중',completed:'완료'},marks={pending:'○',in_progress:'●',completed:'✓'};
    const li=el('li',undefined,'plan-'+status),mark=el('span',marks[status],'plan-mark');mark.setAttribute('aria-hidden','true');
    li.append(mark,el('span',labels[status]+': ','visually-hidden'),el('span',status==='in_progress'?(item.activeForm||item.subject):item.subject));return li;
  }
  function render(data){
    const items=data.items||[],previous=data.earlierCompleted||[],status=data.run?.status;
    const codex=data.agent==='codex'&&status==='running';
    panel.hidden=!codex&&!items.length;header.hidden=codex;
    list.replaceChildren(...items.map(row));earlierList.replaceChildren(...previous.map(row));
    earlier.hidden=!previous.length;earlier.textContent='이전 완료 '+previous.length+'개';
    const completed=items.filter(item=>item.status==='completed').length,active=items.find(item=>item.status==='in_progress');
    count.textContent='완료 '+completed+' / 전체 '+items.length;
    summary.textContent='작업 계획 '+completed+'/'+items.length+(active?', 진행 중: '+(active.activeForm||active.subject):'');
    summary.title=summary.textContent;
    notice.textContent=codex?'Codex는 작업 계획을 보내지 않습니다.':
      ['failed','interrupted'].includes(status)?'실행이 중단되었습니다. Claude가 마지막으로 보고한 상태입니다.':
      status==='completed'&&data.endedWithOpenItems?'실행이 끝났지만 Claude가 완료로 표시하지 않은 항목이 있습니다.':'';
    notice.hidden=!notice.textContent;fold();if(codex)body.hidden=true;
  }
  async function refresh(){
    const ticket=++requestNumber,name=project,id=chat,e=generation;
    const current=()=>ticket===requestNumber&&name===$('project').value&&e===epoch&&id===window.chatState.identity(name,filter);
    if(!name||!id)return;
    try{
      const data=await api('/projects/'+encodeURIComponent(name)+'/plan?chat_id='+encodeURIComponent(id));
      if(current())render(data);
    }catch{if(current())panel.hidden=true;}
  }
  window.planPanel={
    chatChanged(chatId){
      const name=$('project').value,id=chatId||window.chatState.identity(name,filter);
      clearTimeout(timer);timer=null;
      if(chat!==id||project!==name||generation!==epoch){
        panel.hidden=true;earlierList.hidden=true;earlier.setAttribute('aria-expanded','false');
      }
      chat=id;project=name;generation=epoch;
      void refresh();
    },
    planEvent(){
      if(timer)return;
      timer=setTimeout(()=>{timer=null;void refresh();},300);
    }
  };
  fold();
})();
