function workItemRunState(run){
  if(run.status==='completed'&&run.metadata?.question){
    return run.metadata.reply_run_id?'답변 접수됨':run.metadata.superseded_by?'이후 실행으로 이어짐':'답변 대기';
  }
  return ({running:'실행 중',completed:'결과 제출',failed:'실행 실패',interrupted:'중단'})[run.status]||run.status;
}
function workItemElapsed(since,now=Date.now()){
  const stamp=Date.parse(since);if(!Number.isFinite(stamp))return '';
  const minutes=Math.max(0,Math.floor((now-stamp)/60000));
  return minutes<1?'방금':minutes<60?minutes+'분째':minutes<1440?Math.floor(minutes/60)+'시간째':Math.floor(minutes/1440)+'일째';
}
function workItemView(item){
  const latest=item.runs?.find(r=>r.id===item.latest_run_id)||item.runs?.[0]||item.latest_run,running=item.status==='running';
  const verifications=(item.verifications||(item.latest_verification?[item.latest_verification]:[])).filter(v=>latest&&v.run_id===latest.id);
  const question=latest?.metadata?.question,completed=item.status==='done';
  const held=['paused','cancelled'].includes(item.status),baseStatus=item.resume_status||item.status;
  const step=completed?'resolve':baseStatus==='review'?'verify':!latest&&!running?'problem':'execute';
  const aiName=client=>({codex:'Codex',claude:'Claude',mock:'테스트 AI'})[client]||client;
  const active=item.active_runs||(running&&!item.recovery_required&&latest?[{client:latest.adapter}]:[]);
  const ai=active.length?[...new Set(active.map(r=>aiName(r.client)))].join(', '):latest?.adapter?'최근 '+aiName(latest.adapter):'미지정';
  const executionMode=item.recovery_required?'확인 필요':active.length>1?'병렬 '+active.length:active.length===1?'단일':'—';
  let tone='ready',status='준비',reason='첫 지시 필요',actionLabel='작업 지시';
  let nextAction='첫 작업을 적고 실행할 AI를 선택하세요.';
  if(item.recovery_required){tone='unknown';status='상태 미확인';reason='종료 여부 확인 필요';actionLabel='종료 확인';nextAction='실제 AI 실행이 종료됐는지 확인한 뒤 기록을 정리하세요.';}
  else if(held){tone=item.status;status=item.status==='paused'?'보류':'취소';reason=item.hold_reason;actionLabel=item.status==='paused'?'재개':'다시 열기';nextAction='작업을 '+actionLabel+'하면 이전 상태에서 이어갈 수 있습니다. AI는 자동 실행되지 않습니다.';}
  else if(running){tone='running';status='진행 중';reason='AI 실행 중';actionLabel='진행 보기';nextAction='AI가 작업 중입니다. 결과가 도착하면 완료 조건을 확인하세요.';}
  else if(completed){tone='done';status='완료';reason='완료 조건 충족';actionLabel='결과 보기';nextAction='완료 조건 충족을 확인했습니다. 개선할 점이 생기면 새 지시로 이어갈 수 있습니다.';}
  else if(question){tone='attention';status='확인 필요';reason='답변 대기';actionLabel='답변하기';nextAction='AI의 질문에 답변하면 작업을 이어갑니다.';}
  else if(verifications[0]?.verdict==='failed'){tone='attention';status='확인 필요';reason='보완 필요';actionLabel='보완하기';nextAction='확인 근거를 참고해 보완할 내용을 지시하세요.';}
  else if(latest?.status==='failed'||latest?.status==='interrupted'){tone='blocked';status='막힘';reason=latest.status==='failed'?'실행 오류':'실행 중단';actionLabel='다시 지시';nextAction='실행 오류나 중단 이유를 확인하고 다시 지시하세요.';}
  else if(item.status==='review'){tone='attention';status='확인 필요';reason=verifications[0]?.verdict==='inconclusive'?'판단 보류':'결과 확인';actionLabel='결과 확인';nextAction='AI 결과를 완료 조건과 대조하고 확인 근거를 남기세요.';}
  else if(latest){tone='blocked';status='막힘';reason='확인 가능한 결과 없음';actionLabel='다시 지시';nextAction='확인 가능한 결과가 없습니다. 작업 지시를 보완해 다시 실행하세요.';}
  return {
    latest,completed,verifications,question,step,nextAction,status,tone,reason,actionLabel,ai,executionMode,held,
    since:item.hold_since||item.updated_at,waiting:['attention','paused','blocked','unknown'].includes(tone),
    runStatus:latest?workItemRunState(latest):'',needsRecovery:!!item.recovery_required,
    canRun:!running&&!held,
    canVerify:!running&&!held&&!completed&&latest?.status==='completed'&&!!(latest.output?.trim()||latest.has_output)&&!latest.metadata?.question,
    elapsed:latest?.metadata?.elapsed_seconds??null,
    phase:!latest&&!item.latest_run_id?'미시작':!completed&&item.phase==='resolve'?'재작업':({inspect:'검사',hypothesize:'가설 보완',research:'조사',verify:'검증',resolve:'해결'})[item.phase]||'기록 없음',
  };
}
if(typeof module!=='undefined')module.exports={workItemView,workItemElapsed};
if(typeof document!=='undefined')(()=>{
  const page=el('section',undefined,'work-items-page');page.id='work-items-page';page.hidden=true;
  const header=el('header'),back=button('채팅으로',()=>{location.hash='';}),heading=el('h1','목표 작업');
  heading.tabIndex=-1;header.append(back,heading);
  const message=el('p',undefined,'work-item-message'),content=el('div',undefined,'work-items-content');
  message.setAttribute('role','status');message.setAttribute('aria-live','polite');page.append(header,message,content);$('workspace').append(page);
  let ticket=0,timer,signature='',currentRoute='',mutating=false,observedProject=null,embedded=null;
  const drafts=new Map(),pending=new Map();
  function route(){return location.hash.match(/^#work-items(?:\/([a-f0-9]{32}|new))?$/)||(embedded?.hash===location.hash?['',embedded.id]:null);}
  function href(id=''){location.hash='#work-items'+(id?'/'+id:'');}
  function field(form,name,label,tag='textarea',value='',options){
    const wrap=el('div',undefined,'work-item-field'),caption=el('label',label),node=el(tag);node.name=name;node.id='work-item-'+name;caption.htmlFor=node.id;
    if(tag==='select')for(const [v,text] of options)node.append(new Option(text,v));
    else{node.required=true;node.maxLength=name==='title'?120:8000;node.classList.add('form-control');if(tag==='textarea')node.rows=3;}
    node.value=value;wrap.append(caption,node);form.append(wrap);return node;
  }
  function formDraft(form,key){
    const saved=drafts.get(key);
    if(saved)for(const n of form.elements)if(n.name&&Object.hasOwn(saved,n.name)){if(n.type==='checkbox')n.checked=saved[n.name];else n.value=saved[n.name];}
    form.oninput=()=>drafts.set(key,Object.fromEntries([...form.elements].filter(n=>n.name).map(n=>[n.name,n.type==='checkbox'?n.checked:n.value])));
  }
  function remember(key,body){pending.set(key,body);try{sessionStorage.setItem('codast.work-request:'+key,JSON.stringify(body));}catch{}}
  function remembered(key){if(pending.has(key))return pending.get(key);try{return JSON.parse(sessionStorage.getItem('codast.work-request:'+key));}catch{return null;}}
  function forget(key){pending.delete(key);try{sessionStorage.removeItem('codast.work-request:'+key);}catch{}}
  function badge(text,tone='neutral'){
    const node=el('span',text,'work-item-badge');node.dataset.tone=tone;return node;
  }
  function age(view){
    const node=el('time',workItemElapsed(view.since),'work-item-age');node.dataset.since=view.since||'';
    if(view.since){node.dateTime=view.since;node.title='상태 기록: '+new Date(view.since).toLocaleString();}
    return node;
  }
  function resume(item,node){return change(node,()=>api(base()+'/work-items/'+item.id+'/control','POST',{expected_revision:item.revision,action:'resume'}));}
  async function change(form,action){
    if(mutating)return;mutating=true;form.inert=true;content.inert=true;message.textContent='저장 중…';
    ticket++;clearTimeout(timer);
    const b=base(),e=epoch,h=location.hash;
    try{await action();if(valid(b,e)&&location.hash===h){message.textContent='저장했습니다.';signature='';await refresh();}}
    catch(error){if(valid(b,e)&&location.hash===h){message.textContent=error.message;signature='';await refresh();}}
    finally{form.inert=false;content.inert=false;mutating=false;}
  }
  function creation(b){
    content.append(button('목록으로',()=>href()),el('h2','새 목표 등록'),el('p','목표와 완료 조건을 먼저 정하고, 실행 결과를 확인하며 작업을 이어갑니다.','hint'));
    const form=el('form',undefined,'work-item-form');
    field(form,'title','작업 이름','input');field(form,'goal','해결할 문제와 목표');field(form,'done_criteria','완료 조건');
    formDraft(form,b+'/new');const save=el('button','목표 등록');save.type='submit';form.append(save);content.append(form);
    form.onsubmit=event=>{event.preventDefault();void change(form,async()=>{
      const item=await api(b+'/work-items','POST',Object.fromEntries(new FormData(form)));
      drafts.delete(b+'/new');if(valid(b)&&route()?.[1]==='new')href(item.id);
    });};
  }
  function listing(items){
    content.append(el('p',projectLabel($('project').value)+'의 목표, 실행 결과, 완료 확인을 한곳에서 관리합니다.','hint'),button('새 목표 등록',()=>href('new')));
    if(!items.length){content.append(el('h2','아직 등록된 목표가 없습니다.'),el('p','작게 검증할 수 있는 목표 하나부터 시작하세요.'));return;}
    const table=el('table',undefined,'work-items-table'),head=el('tr');
    const columns=['작업 제목','현재 상태','작업 단계','AI','실행 방식'];
    for(const label of columns){const th=el('th',label);th.scope='col';head.append(th);}
    const thead=el('thead'),body=el('tbody');thead.append(head);table.append(thead,body);
    for(const item of items){
      const view=workItemView(item),row=el('tr'),title=el('td'),link=el('a',item.title);link.href='#work-items/'+item.id;title.append(link);
      const state=el('td',undefined,'work-item-list-state'),reason=el('p',view.reason,'work-item-list-reason');reason.title=view.reason;
      state.append(badge(view.status,view.tone),reason);if(view.waiting)state.append(age(view));
      if(view.held){state.append(button(view.actionLabel,()=>resume(item,row),'work-item-list-action'));}
      else{const action=el('a',view.actionLabel,'work-item-list-action');action.href=link.href;state.append(action);}
      const phase=el('td'),ai=el('td'),mode=el('td');phase.append(badge(view.phase));ai.append(badge(view.ai));mode.append(badge(view.executionMode));
      row.append(title,state,phase,ai,mode);[...row.children].forEach((cell,i)=>cell.dataset.label=columns[i]);body.append(row);
    }
    const scroll=el('div',undefined,'work-items-table-scroll');scroll.append(table);content.append(scroll);
  }
  function detail(item,b){
    const view=workItemView(item),key=b+'/'+item.id,latest=view.latest;
    const aiName=run=>({codex:'Codex',claude:'Claude',mock:'테스트 AI'})[run?.adapter]||run?.adapter||'AI';
    const verdictName=v=>({passed:'완료 확인',failed:'보완 필요',inconclusive:'판단 보류'})[v.verdict]||v.verdict;
    const stamp=value=>value?new Date(value).toLocaleString():'시간 기록 없음';
    function section(parent,title,cls){const node=el('section',undefined,cls),h=el('h3',title);node.append(h);parent.append(node);return node;}
    function reviewRecord(parent,v){
      const record=el('div',undefined,'work-item-review');
      record.append(el('strong',verdictName(v)),el('p',v.note,'work-item-prose'),el('p','사용자 확인, '+stamp(v.created_at),'hint'));
      parent.append(record);
    }
    function contextRecord(parent,run){
      const context=el('details');context.dataset.disclosure='context-'+run.id;
      context.append(el('summary','실행에 전달한 범위'));
      context.append(el('p','목표와 완료 조건, 아래 실행 요청을 함께 전달했습니다.','hint'));
      const command=run.command||{},list=el('dl',undefined,'work-item-context');
      for(const [label,value] of [
        ['작업 폴더',command.cwd||'.'],
        ['실행 권한',command.mode==='workspace-write'?'코드 수정 허용':'파일 읽기만 허용'],
        ['지정한 파일',command.context_paths?.join('\n')||'별도 지정 없음'],
        ['연결 자료',command.material_ids?.length?command.material_ids.length+'개':'별도 지정 없음'],
      ])list.append(el('dt',label),el('dd',value,'work-item-prose'));
      context.append(list);parent.append(context);
    }
    if(!embedded)content.append(button('목록으로',()=>href()));
    const title=el('div',undefined,'work-item-title'),status=badge(view.status,view.tone);status.classList.add('work-item-status');status.dataset.state=item.status;
    title.append(el('h2',item.title),status);content.append(title,el('p',item.goal,'work-item-prose work-item-goal'));
    if(embedded){title.querySelector('h2').textContent='작업 기록';content.lastChild.hidden=true;}
    const flow=el('ol',undefined,'work-item-flow');flow.setAttribute('aria-label','작업 진행 단계');
    const steps=[['problem','문제', '목표 등록됨'],['execute','검사, 가설, 조사',item.status==='running'?'AI 실행 중':item.runs.length?item.runs.length+'회 실행':'첫 실행 대기'],['verify','검증',item.verifications.length?item.verifications.length+'건 사용자 확인':'결과 확인 대기'],['resolve','해결',view.completed?'완료 조건 충족':'완료 전']];
    for(const [id,label,description] of steps){const step=el('li');step.dataset.step=id;if(view.step===id)step.setAttribute('aria-current','step');step.append(el('strong',label),el('span',description));flow.append(step);}
    content.append(flow);
    const guidance=el('div',undefined,'work-item-guidance');guidance.append(el('strong','지금, '+view.status),el('span',view.nextAction));if(view.waiting)guidance.append(age(view));content.append(guidance);
    const layout=el('div',undefined,'work-item-layout'),main=el('div',undefined,'work-item-main'),aside=el('aside',undefined,'work-item-next');layout.append(main,aside);content.append(layout);
    const assignment=section(main,'AI가 맡은 일','work-item-assignment');
    if(latest){
      const line=el('div',undefined,'work-item-run-heading');line.append(el('strong',aiName(latest)),el('span',view.needsRecovery?'종료 확인 필요':view.runStatus,'work-item-tag'));assignment.append(line);
      assignment.append(el('p',latest.command?.text||'실행 지시 기록 없음','work-item-prose'));
      const model=latest.metadata?.execution_model||latest.command?.model||'기본 모델';
      assignment.append(el('p',model+', '+(view.elapsed===null?'소요 시간 미수집':view.elapsed+'초')+', '+stamp(latest.started_at),'hint'));
      contextRecord(assignment,latest);
    }else assignment.append(el('p','아직 AI에 맡긴 작업이 없습니다. 첫 지시를 보내면 담당 AI와 작업 내용이 여기에 표시됩니다.','hint'));
    const result=section(main,view.question?'AI의 질문':'현재 결과','work-item-result');result.querySelector('h3').tabIndex=-1;
    if(latest){
      const description=view.question?'답변을 보내면 이 실행에 이어서 전달됩니다.':view.completed?'사용자가 완료 조건 충족을 확인한 결과입니다.':item.status==='running'?'결과를 기다리고 있습니다.':latest.status==='completed'?'AI가 제출한 내용입니다. 완료 조건과 대조해 확인하세요.':'실행이 끝까지 완료되지 않았습니다.';
      result.append(el('p',description,'hint'));
      if(view.question)result.append(el('p',view.question.question,'work-item-prose'));
      if(latest.error)result.append(el('p',latest.error,'work-item-blocked work-item-prose'));
      result.append(consoleOutput(latest.output||'아직 제출된 결과가 없습니다.'));
    }else result.append(el('p','첫 실행이 끝나면 결과를 확인할 수 있습니다.','hint'));
    const evidence=section(main,'이번 결과의 확인 근거','work-item-evidence');
    if(view.verifications.length){
      reviewRecord(evidence,view.verifications[0]);
      evidence.append(button('확인한 결과 보기',()=>{result.scrollIntoView({block:'start'});result.querySelector('h3').focus({preventScroll:true});}));
      if(view.verifications.length>1){const older=el('details');older.dataset.disclosure='reviews-'+latest.id;older.append(el('summary','이 결과의 이전 판단 '+(view.verifications.length-1)+'건'));for(const v of view.verifications.slice(1))reviewRecord(older,v);evidence.append(older);}
    }else evidence.append(el('p',latest?'이번 실행 결과에 대한 사용자 확인이 아직 없습니다. 이전 결과의 확인 기록은 아래 이력에 보관됩니다.':'결과를 확인하며 남긴 근거가 여기에 쌓입니다.','hint'));
    const criteria=section(aside,'완료 조건','work-item-criteria');criteria.append(el('p',item.done_criteria,'work-item-prose'),el('p',view.completed?'모든 조건 충족을 사용자가 확인했습니다.':'각 조건을 확인한 근거를 남긴 뒤 완료로 표시하세요.','hint'));
    const action=section(aside,'다음 행동','work-item-action');action.append(el('p',view.nextAction));
    if(view.held){action.append(el('p',item.hold_reason,'work-item-blocked work-item-prose'),button(view.actionLabel,()=>resume(item,action)));}
    else if(item.blocked_reason)action.append(el('p',item.blocked_reason,'work-item-blocked work-item-prose'));
    if(item.status==='running'){
      const controls=el('div');action.append(controls);
      if(view.needsRecovery){
        controls.append(el('p','서버가 이 실행을 추적하지 못합니다. 실제 AI 프로세스가 끝났는지 확인한 뒤 기록을 정리하세요.'));
        controls.append(button('종료 확인 후 기록 정리',()=>{if(confirm('실제 AI 프로세스의 종료를 확인했나요?'))return change(controls,()=>api(b+'/runs/'+item.latest_run_id+'/reconcile','POST'));}));
      }else controls.append(button('실행 취소',()=>change(controls,()=>api(b+'/runs/'+item.latest_run_id+'/cancel','POST'))));
    }
    if(view.canVerify){
      action.append(el('h3','완료 조건 확인'));
      const form=el('form',undefined,'work-item-form');
      const verdict=field(form,'verdict','판단','select','inconclusive',[['inconclusive','판단 보류'],['failed','보완 필요'],['passed','완료 조건 충족']]);
      const note=field(form,'note','확인 근거');note.maxLength=4000;
      const label=el('label',undefined,'check'),check=el('input');check.type='checkbox';check.name='criteria_met';label.append(check,document.createTextNode('완료 조건을 모두 확인했습니다.'));form.append(label);
      formDraft(form,key+'/verify/'+latest.id);check.required=verdict.value==='passed';verdict.onchange=()=>{check.required=verdict.value==='passed';};
      note.placeholder='어떤 결과를 무엇과 대조했는지 적어주세요.';
      const save=el('button','확인 결과 저장');save.type='submit';form.append(save);action.append(form);
      form.onsubmit=event=>{event.preventDefault();void change(form,()=>api(b+'/work-items/'+item.id+'/verifications','POST',{
        expected_revision:item.revision,run_id:latest.id,verdict:verdict.value,criteria_met:check.checked,note:note.value,
      }));};
    }
    if(view.canRun&&!embedded){
      const form=el('form',undefined,'work-item-form'),saved=remembered(key);
      const runPanel=el('details',undefined,'work-item-run-form');runPanel.open=!latest||item.status==='blocked'||!!saved;
      runPanel.dataset.disclosure='run-form-'+(latest?.id||'first');
      runPanel.append(el('summary',view.question?'질문에 답변하고 계속하기':latest?'개선 지시하고 다시 실행':'첫 작업 지시'));action.append(runPanel);
      const text=field(form,'text','작업 지시 또는 답변');
      text.placeholder=view.question?'AI의 질문에 답변해주세요.':'예: 문제가 발생하는 조건을 조사하고 확인 근거를 정리해줘.';
      const clients=[['codex','Codex'],['claude','Claude']];
      const client=field(form,'client','실행할 AI','select',(latest?.adapter||projectDefaults.client)==='claude'?'claude':'codex',clients);
      const settings=el('details',undefined,'work-item-run-settings');settings.dataset.disclosure='run-settings';settings.append(el('summary','실행 설정'));form.append(settings);
      const mode=field(settings,'mode','실행 권한','select','read-only',[['read-only','파일 읽기만 허용'],['workspace-write','코드 수정 허용']]);
      const model=field(settings,'model','모델, 비워두면 CLI 기본값','input');model.required=false;model.maxLength=200;
      formDraft(form,key+'/run');
      if(saved){for(const n of [text,client,mode,model])n.value=saved[n.name]||'';for(const n of [text,client,mode,model])n.disabled=true;form.append(el('p','이전 요청의 응답을 확인하지 못했습니다. 같은 요청 번호로 결과를 확인합니다.','hint'));}
      const send=el('button',saved?'이전 요청 결과 확인':view.question?'답변 보내기':'AI 실행');send.type='submit';form.append(send);runPanel.append(form);
      form.onsubmit=event=>{event.preventDefault();void change(form,async()=>{
        const body=remembered(key)||{text:text.value,client:client.value,mode:mode.value,model:model.value||null,cwd:projectDefaults.cwd||'.',context_paths:projectDefaults.context_paths||[],expected_revision:item.revision,request_id:crypto.randomUUID()};
        remember(key,body);
        try{await api(b+'/work-items/'+item.id+'/runs','POST',body);forget(key);drafts.delete(key+'/run');}
        catch(error){if(error.status>=400&&error.status<500)forget(key);throw error;}
      });};
    }
    if(!view.held&&!view.completed&&item.status!=='running'){
      const controls=el('details',undefined,'work-item-controls');controls.dataset.disclosure='work-controls';controls.append(el('summary','작업 보류 또는 취소'));
      const form=el('form',undefined,'work-item-form'),choice=field(form,'control_action','작업 처리','select','pause',[['pause','보류'],['cancel','목표 취소']]);
      const reason=field(form,'control_reason','보류 또는 취소 사유');reason.maxLength=1000;reason.placeholder='예: 승인 보류, 원문 대조 후 재개';
      formDraft(form,key+'/control');const save=el('button','작업 상태 저장');save.type='submit';form.append(save);controls.append(form);action.append(controls);
      form.onsubmit=event=>{event.preventDefault();void change(form,async()=>{
        await api(b+'/work-items/'+item.id+'/control','POST',{expected_revision:item.revision,action:choice.value,reason:reason.value});drafts.delete(key+'/control');
      });};
    }
    const history=section(content,'이전 실행','work-item-history'),previous=item.runs.filter(run=>run.id!==latest?.id);
    history.append(el('p','보완과 재실행을 거친 기록입니다. 각 결과에 대한 판단과 근거를 함께 확인할 수 있습니다.','hint'));
    if(!previous.length)history.append(el('p','아직 이전 실행이 없습니다.','hint'));
    for(const [index,run] of previous.entries()){
      const row=el('details');row.dataset.disclosure='history-'+run.id;
      row.append(el('summary',(item.runs.length-index-1)+'차 실행, '+aiName(run)+', '+workItemRunState(run)),el('p',stamp(run.started_at),'hint'),el('h4','맡긴 작업'),el('p',run.command?.text||'실행 지시 기록 없음','work-item-prose'));
      contextRecord(row,run);row.append(el('h4','실행 결과'));
      if(run.error)row.append(el('p',run.error,'work-item-blocked work-item-prose'));
      row.append(consoleOutput(run.output||'결과 없음'));
      const records=item.verifications.filter(v=>v.run_id===run.id);
      row.append(el('h4','이 결과의 확인 근거'));
      if(!records.length)row.append(el('p','사용자 확인 기록 없음','hint'));
      for(const v of records)reviewRecord(row,v);
      history.append(row);
    }
  }
  async function refresh(){
    clearTimeout(timer);const match=route();if(!match)return;
    const id=match[1]||'',b=$('project').value?base():'',e=epoch,t=++ticket;
    if(!projectReady){content.replaceChildren(el('p','프로젝트를 선택하고 불러오기를 완료하세요.'));return;}
    if(id==='new'){if(signature!==b+'/new'){content.replaceChildren();creation(b);signature=b+'/new';}return;}
    try{
      const data=await api(b+'/work-items'+(id?'/'+id:''));if(t!==ticket||!valid(b,e)||route()?.[1]!==match[1])return;
      const next=JSON.stringify(data);
      if(next!==signature){
        const expanded=new Set([...content.querySelectorAll('details[data-disclosure][open]')].map(n=>n.dataset.disclosure));
        content.replaceChildren();if(id)detail(data,b);else listing(data.items);
        for(const n of content.querySelectorAll('details[data-disclosure]'))if(expanded.has(n.dataset.disclosure))n.open=true;
        signature=next;
      }
      for(const node of content.querySelectorAll('time[data-since]'))node.textContent=workItemElapsed(node.dataset.since);
      if(id?data.status==='running':data.items.some(x=>x.status==='running'))timer=setTimeout(()=>void refresh(),1500);
      else if(!id||workItemView(data).waiting)timer=setTimeout(()=>void refresh(),30000);
    }catch(error){if(t===ticket&&valid(b,e)){message.textContent=error.message;content.replaceChildren(button('다시 불러오기',()=>refresh()));}}
  }
  function navigate(){
    const open=!!route();page.hidden=!open;if(!embedded&&!window.sessionWorkspace)$('console').hidden=open;ticket++;clearTimeout(timer);
    if(currentRoute!==location.hash){signature='';message.textContent='';content.replaceChildren();currentRoute=location.hash;if(open)heading.focus();}
    if(open)void refresh();
  }
  window.workItems={attachToChat(id,parent){
    if(id&&embedded?.id===id&&embedded.hash===location.hash&&page.parentNode===parent)return;
    embedded=id?{id,hash:location.hash}:null;page.classList.toggle('work-items-embedded',!!id);header.hidden=!!id;
    if(id)parent.replaceChildren(page);else $('workspace').append(page);signature='';currentRoute='';navigate();
  },projectChanged(){
    ticket++;signature='';clearTimeout(timer);content.replaceChildren();
    const changed=observedProject!==null&&observedProject!==$('project').value;observedProject=$('project').value;
    if(changed&&route()?.[1])href();else navigate();
  },projectReady:navigate};
  window.addEventListener('hashchange',navigate);
  window.addEventListener('load',()=>{
    if(!window.sessionWorkspace){const link=el('a','목표 작업','btn btn-outline-secondary');link.href='#work-items';link.id='open-work-items';
    ($('sidebar').querySelector('.chat-navigation')||$('project-panel')).prepend(link);}
    $('task-list').addEventListener('click',()=>{if(route())location.hash='';});navigate();
    $('sidebar').querySelector('.new-chat')?.addEventListener('click',()=>{if(route())location.hash='';});
  });
})();
