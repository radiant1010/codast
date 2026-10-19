/* Per-chat choices; Ultracode is off unless explicitly enabled. */
(()=>{
  const model=el('select');model.id='execution-model';model.setAttribute('aria-label','실행 모델');
  const modelLabel=el('label','모델');modelLabel.htmlFor=model.id;
  const hint=el('p',undefined,'hint');hint.id='execution-hint';hint.setAttribute('role','status');
  $('execution-menu').append(modelLabel,model,hint);
  const effort=el('select');effort.id='reasoning-effort';effort.setAttribute('aria-label','추론 강도');
  const ultra=el('input',undefined,'form-check-input');ultra.type='checkbox';ultra.id='ultracode';ultra.setAttribute('role','switch');ultra.setAttribute('aria-label','Ultracode');
  const ultraLabel=el('label',undefined,'form-check form-switch ultracode-toggle');ultraLabel.htmlFor=ultra.id;
  const ultraState=el('span','꺼짐','ultracode-state');ultraState.setAttribute('aria-hidden','true');
  ultraLabel.append(ultra,el('span','Ultracode'),ultraState);
  $('model-picker').after(effort,ultraLabel);
  const labels={none:'None',minimal:'Minimal',low:'Low',medium:'Medium',high:'High',xhigh:'Extra high',max:'Max',ultra:'Ultra'};
  let modelClient='',ticket=0,rows=[],capabilities={},loading=false;
  const currentRow=()=>rows.find(row=>row.model===model.value);
  const supported=()=>currentRow()?.available===false?[]:(currentRow()?.supportedReasoningEfforts||[]).map(row=>row.reasoningEffort).filter(value=>value in labels);
  const ultraSupported=()=>modelClient==='claude'&&capabilities.ultracode&&supported().includes('xhigh');
  function renderEffort(selected=null,ultracode=null){
    if(modelClient!=='claude')ultracode=null;
    effort.replaceChildren(new Option('추론: CLI 기본',''));
    for(const value of supported())effort.add(new Option(labels[value],value));
    if(selected&&!supported().includes(selected)){
      const option=new Option((labels[selected]||selected)+' (지원 확인 필요)',selected);option.disabled=true;effort.add(option);
    }
    effort.value=selected||'';effort.disabled=loading;
    ultraLabel.hidden=modelClient!=='claude';ultra.checked=ultracode===true;
    ultra.disabled=loading||(!ultraSupported()&&!ultra.checked);
    ultraState.textContent=ultra.checked?'켜짐':'꺼짐';
    ultraLabel.title=ultraSupported()?'추론 강도와 별도로 설정합니다. 기본은 꺼짐입니다.':'Ultracode를 켜려면 Claude Code 2.1.284 이상, Extra high 지원 모델이 필요합니다.';
    const name=model.selectedOptions[0]?.textContent||'CLI 기본 모델';
    $('execution-summary').textContent=(modelClient==='claude'?'Claude':'Codex')+' / '+name;
    hint.textContent=modelClient==='claude'
      ?'Claude Code '+(capabilities.version||'버전 확인 중')+'. 모델은 계정과 연결 환경에 따라 제공됩니다. '+(!capabilities.ultracode?'Ultracode 켜기는 2.1.284 이상에서 지원합니다.':'Ultracode는 추론 강도와 별도 설정이며 기본은 꺼짐입니다.')
      :'모델을 선택하면 지원하는 추론 강도가 표시됩니다. CLI 기본은 기존 설정을 따릅니다.';
  }
  window.loadModelChoices=async(selected=null,reasoning=null,ultracode=null)=>{
    const client=$('client').value,request=++ticket;
    modelClient=client;rows=[];capabilities={};loading=true;
    model.replaceChildren(new Option('CLI 기본 모델',''));
    if(selected){model.add(new Option(selected+' (저장됨, 확인 중)',selected));model.value=selected;}
    model.disabled=true;renderEffort(reasoning,ultracode);
    try{
      const data=await api(client==='codex'?'/clients/codex/status':'/clients/claude/options');
      if(request!==ticket||client!==$('client').value)return;
      capabilities=data;rows=data.models||[];
      model.replaceChildren(new Option('CLI 기본 모델',''));
      for(const row of rows)if(row.model){
        const option=new Option((row.displayName||row.model)+(row.available===false?' ('+row.minimumVersion+' 이상 필요)':''),row.model);
        option.disabled=row.available===false;model.add(option);
      }
      if(selected&&!Array.from(model.options).some(option=>option.value===selected))model.add(new Option(selected+' (저장됨, 지원 미확인)',selected));
      model.value=selected||'';
    }catch(error){if(request===ticket)notice('모델 목록 조회 실패: '+error.message,true);}
    finally{if(request===ticket){loading=false;model.disabled=false;renderEffort(reasoning,ultracode);}}
  };
  const matchesRoute=()=>{
    const explicit=$('text').value.trim().match(/^\/(codex|claude)(?:\s|$)/)?.[1];
    return (!explicit||explicit===modelClient)&&modelClient===$('client').value;
  };
  window.selectedConfiguredModel=()=>modelClient===$('client').value?model.value||null:null;
  window.selectedExecutionModel=()=>matchesRoute()?model.value||null:null;
  window.selectedReasoningSettings=(execution=false)=>({
    reasoning_effort:(!execution||matchesRoute())?effort.value||null:null,
    ultracode:modelClient==='claude'&&(!execution||matchesRoute())?ultra.checked:null
  });
  window.validateExecutionSettings=()=>{
    if(!matchesRoute())return;
    if(currentRow()?.available===false)throw Error('선택한 모델을 사용하려면 Claude Code '+currentRow().minimumVersion+' 이상이 필요합니다.');
    if(effort.value&&(loading||!supported().includes(effort.value)))throw Error('선택한 추론 강도의 지원 여부를 확인할 수 없습니다. 모델을 선택하거나 추론을 CLI 기본으로 바꾸세요.');
    if(ultra.checked&&(loading||!ultraSupported()))throw Error('Ultracode를 켜려면 Claude Code 2.1.284 이상과 지원 모델이 필요합니다. 토글을 끄면 실행할 수 있습니다.');
  };
  $('client').addEventListener('change',()=>act(()=>window.loadModelChoices()));
  model.addEventListener('change',()=>{
    const ultracode=ultra.checked&&ultraSupported();
    renderEffort(supported().includes(effort.value)?effort.value:null,ultracode);
    $('model-picker').open=false;$('execution-summary').focus();window.chatState.save();
  });
  ultra.addEventListener('change',()=>renderEffort(effort.value,ultra.checked));
  document.addEventListener('click',event=>{if(!$('model-picker').contains(event.target))$('model-picker').open=false;});
  $('model-picker').addEventListener('keydown',event=>{if(event.key==='Escape'){$('model-picker').open=false;$('execution-summary').focus();}});
})();
