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
  const labels={none:'없음',minimal:'최소',low:'낮음',medium:'보통',high:'높음',xhigh:'매우 높음',max:'최대',ultra:'울트라'};
  let modelClient='',ticket=0,rows=[],capabilities={},loading=false,measured=[];
  const currentRow=()=>rows.find(row=>row.model===(model.value||capabilities.default_model));
  const supported=()=>currentRow()?.available===false?[]:(currentRow()?.supportedReasoningEfforts||[]).map(row=>row.reasoningEffort).filter(value=>value in labels);
  const ultraSupported=()=>modelClient==='claude'&&capabilities.ultracode&&supported().includes('xhigh');
  function renderModel(){
    const recent=!$('fresh').checked&&measured.find(row=>row.project===$('project').value&&row.task===$('task-name').value&&row.client===modelClient)?.execution_model;
    const defaultLabel=loading?'모델 확인 중':capabilities.default_model?capabilities.default_model+' (기본)':recent?recent+' (최근 실행)':'모델 확인 필요';
    model.options[0].textContent=defaultLabel;
    const name=model.selectedOptions[0]?.textContent||defaultLabel;
    $('execution-summary').textContent=(modelClient==='claude'?'Claude':'Codex')+' / '+name;
    $('execution-summary').title=model.value||defaultLabel;
    const modelHint=model.value?'':capabilities.default_model?'기본 설정의 모델입니다. 이어진 대화는 기존 세션의 모델을 따를 수 있습니다. '
      :recent?'이 대화에서 마지막으로 확인된 모델입니다. 다음 실행의 모델은 설정에 따라 달라질 수 있습니다. '
      :loading?'모델명을 확인하고 있습니다. ':'기본 모델을 확인하지 못했습니다. 목록에서 모델을 선택하면 사용할 모델을 지정할 수 있습니다. ';
    hint.textContent=modelHint+(modelClient==='claude'
      ?'Claude Code '+(capabilities.version||'버전 확인 중')+'. 모델은 계정과 연결 환경에 따라 제공됩니다. '+(!capabilities.ultracode?'Ultracode 켜기는 2.1.284 이상에서 지원합니다.':'Ultracode는 추론 강도와 별도 설정이며 기본은 꺼짐입니다.')
      :'모델을 선택하면 지원하는 추론 강도가 표시됩니다.');
  }
  window.updateExecutionModels=values=>{measured=values;if(model.options.length)renderModel();};
  function renderEffort(selected=null,ultracode=null){
    if(modelClient!=='claude')ultracode=null;
    const available=supported(),defaultEffort=currentRow()?.effectiveReasoningEffort;
    const knownDefault=available.includes(defaultEffort)?defaultEffort:null;
    effort.replaceChildren(new Option(loading?'추론: 확인 중':knownDefault?'추론: '+labels[knownDefault]+' (기본)':'추론: 자동 (미확인)',''));
    const grades=Object.keys(labels).filter(value=>modelClient!=='claude'||!['none','minimal','ultra'].includes(value));
    for(const value of grades){
      const option=new Option('추론: '+labels[value]+(!available.includes(value)?' (지원 확인 필요)':''),value);
      option.disabled=!available.includes(value);effort.add(option);
    }
    if(selected&&!grades.includes(selected)){
      const option=new Option('추론: '+(labels[selected]||selected)+' (지원 확인 필요)',selected);option.disabled=true;effort.add(option);
    }
    effort.value=selected||'';effort.disabled=loading;
    effort.title=selected?(labels[selected]||selected)+' ('+selected+')':knownDefault?'기본 설정: '+labels[knownDefault]+' ('+knownDefault+')'
      :'기본 추론 등급을 확인하지 못했습니다. 모델을 선택한 뒤 지원하는 등급을 지정할 수 있습니다.';
    ultraLabel.hidden=modelClient!=='claude';ultra.checked=ultracode===true;
    ultra.disabled=loading||(!ultraSupported()&&!ultra.checked);
    ultraState.textContent=ultra.checked?'켜짐':'꺼짐';
    ultraLabel.title=ultraSupported()?'추론 강도와 별도로 설정합니다. 기본은 꺼짐입니다.':'Ultracode를 켜려면 Claude Code 2.1.284 이상, 매우 높음(xhigh) 지원 모델이 필요합니다.';
    renderModel();
  }
  window.loadModelChoices=async(selected=null,reasoning=null,ultracode=null)=>{
    const client=$('client').value,request=++ticket;
    modelClient=client;rows=[];capabilities={};loading=true;
    model.replaceChildren(new Option('모델 확인 중',''));
    if(selected){model.add(new Option(selected+' (저장됨, 확인 중)',selected));model.value=selected;}
    model.disabled=true;renderEffort(reasoning,ultracode);
    try{
      const scope=$('project').value?'?project='+encodeURIComponent($('project').value)+'&cwd='+encodeURIComponent($('cwd').value||'.'):'';
      const data=await api(client==='codex'?'/clients/codex/status'+scope:'/clients/claude/options');
      if(request!==ticket||client!==$('client').value)return;
      capabilities=data;rows=data.models||[];
      model.replaceChildren(new Option('모델 확인 중',''));
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
    if(effort.value&&(loading||!supported().includes(effort.value)))throw Error('선택한 추론 등급의 지원 여부를 확인할 수 없습니다. 모델을 다시 선택하거나 추론을 자동으로 설정해야 합니다.');
    if(ultra.checked&&(loading||!ultraSupported()))throw Error('Ultracode를 켜려면 Claude Code 2.1.284 이상과 지원 모델이 필요합니다. 토글을 끄면 실행할 수 있습니다.');
  };
  $('client').addEventListener('change',()=>act(()=>window.loadModelChoices()));
  $('cwd').addEventListener('change',()=>act(()=>window.loadModelChoices(model.value,effort.value,ultra.checked)));
  $('fresh').addEventListener('change',()=>{if(model.options.length)renderModel();});
  model.addEventListener('change',()=>{
    const ultracode=ultra.checked&&ultraSupported();
    renderEffort(supported().includes(effort.value)?effort.value:null,ultracode);
    $('model-picker').open=false;$('execution-summary').focus();window.chatState.save();
  });
  ultra.addEventListener('change',()=>renderEffort(effort.value,ultra.checked));
  effort.addEventListener('change',()=>renderEffort(effort.value,ultra.checked));
  document.addEventListener('click',event=>{if(!$('model-picker').contains(event.target))$('model-picker').open=false;});
  $('model-picker').addEventListener('keydown',event=>{if(event.key==='Escape'){$('model-picker').open=false;$('execution-summary').focus();}});
})();
