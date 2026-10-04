(()=>{
  const $=id=>document.getElementById(id),node=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
  const roles=['요구사항','화면','테스트 케이스','기타 파일'];
  const prompt1='화면 SCR-001의 요소를 REQ-001~003에 연결하라. 제공한 자료만 사용하고, 연결표와 확인이 필요한 항목을 제출하라. 구현과 테스트 작성은 하지 마라.';
  const prompt2='승인된 연결표 v2를 기준으로 기존 테스트를 검토하라. 정상·오류·경계 조건의 누락을 보완하고 기존/신규, 요구사항 ID, 절차, 기대 결과를 표로 제출하라.';
  const seed=()=>({phase:'empty',materials:roles.map(()=>[]),prompt:'',agent:'Codex',first:'Codex',second:'Claude',goal:'',mapVersion:1,testVersion:1,approved:false,includeMap:true,includeTests:true,messages:[],actions:0,ms:0,started:false,finished:false,feedback:''});
  const variants={A:seed(),B:seed()},records=[];let active='B',clockStart=null,setupFiles=null,revisionContext=null;
  const state=()=>variants[active];
  function icon(id,kind,label,fn){const n=typeof id==='string'?$(id):id;window.actionIcon(n,kind,label);n.type='button';if(fn)n.onclick=fn;return n;}
  function tick(){if(clockStart!==null)state().ms+=performance.now()-clockStart;clockStart=null;}
  function resume(){if(state().started&&!state().finished&&!document.hidden)clockStart=performance.now();}
  function count(){if(!state().started){state().started=true;resume();}state().actions++;}
  document.addEventListener('visibilitychange',()=>{tick();resume();});
  function feedback(text){state().feedback=text;$('feedback').textContent=text;}
  function switchTo(key){tick();state().prompt=$('prompt').value;state().agent=$('agent').value;active=key;resume();render();}
  $('variant-a').onclick=()=>switchTo('A');$('variant-b').onclick=()=>switchTo('B');
  const iconButton=(kind,label,fn)=>{const b=node('button');icon(b,kind,label,fn);return b;};
  icon('reset','restore','현재 안 처음부터 다시 체험',()=>{if(!confirm('현재 안의 진행을 초기화할까요? 완료한 체험 기록은 유지됩니다.'))return;tick();variants[active]=seed();render();});
  function sampleFiles(){return [{name:'로그인_요구사항.docx',role:0,sample:true},{name:'로그인_화면.png',role:1,sample:true},{name:'기존_테스트.xlsx',role:2,sample:true},{name:'추가_설명.md',role:3,sample:true}];}
  function openSetup(){
    if(['processing','review','handoff','done'].includes(state().phase)){feedback('이미 제출한 입력입니다. 자료를 바꾸려면 현재 안을 처음부터 다시 체험하세요.');return;}
    count();setupFiles=state().materials.map(rows=>rows.slice());$('setup-title').textContent=active==='A'?'작업 자료와 순서 설정':'작업 자료 등록';$('setup-kicker').textContent=active==='A'?'A · 시작 전에 전체 흐름 지정':'B · 자료를 준비하고 입력창에서 지시';
    $('preset').hidden=active!=='A';$('goal').value=state().goal||$('prompt').value;$('first-agent').value=state().first;$('second-agent').value=state().second;
    $('setup-submit-label').textContent=active==='A'?'설정한 첫 분석 시작 (예시)':'자료를 입력창에 적용';$('setup-error').textContent='';drawUploads();$('setup-dialog').showModal();
  }
  icon('materials-open','paperclip','작업 자료 등록',openSetup);icon('start-modal','route','작업 시작 모달 열기',openSetup);
  icon('setup-close','close','작업 자료 등록 닫기',()=>{count();$('setup-dialog').close();});
  icon('use-samples','importDocument','예시 자료 채우기',()=>{count();setupFiles=roles.map(()=>[]);for(const f of sampleFiles())setupFiles[f.role].push(f);if(!$('goal').value)$('goal').value='로그인 화면과 요구사항을 연결한 후 테스트 케이스를 도출한다.';drawUploads();});
  icon('setup-submit','check','자료 적용 또는 첫 분석 시작');$('setup-submit').type='submit';
  function drawUploads(){
    $('upload-rows').replaceChildren();roles.forEach((role,index)=>{
      const row=node('div',undefined,'upload-row'),files=node('div',undefined,'upload-files'),input=node('input');input.type='file';input.multiple=true;input.hidden=true;
      input.onchange=()=>{count();for(const file of input.files){if(setupFiles[index].length>=8)break;setupFiles[index].push({name:file.name,role:index,file,sample:false});}drawUploads();};
      if(!setupFiles[index].length)files.append(node('span',index<2?'파일 또는 이미지 선택':'선택 사항','upload-empty'));
      setupFiles[index].forEach((file,at)=>{const b=node('button',file.name,'file-choice');b.type='button';b.title='선택 해제: '+file.name;b.setAttribute('aria-label',file.name+' 선택 해제');b.onclick=()=>{count();setupFiles[index].splice(at,1);drawUploads();};files.append(b);});
      row.append(node('strong',role),files,iconButton('paperclip',role+' 파일 추가',()=>input.click()),input);$('upload-rows').append(row);
    });
  }
  $('setup-form').onsubmit=e=>{e.preventDefault();count();if(!setupFiles[0].length||!setupFiles[1].length){$('setup-error').textContent='이 체험에는 요구사항과 화면 자료가 필요합니다. 예시 자료를 사용해도 됩니다.';return;}
    if(!$('goal').value.trim()){$('setup-error').textContent='작업 목표를 입력하세요.';return;}
    const s=state();s.materials=setupFiles;s.includeTests=setupFiles[2].length>0;s.goal=$('goal').value;s.first=$('first-agent').value;s.second=$('second-agent').value;$('setup-dialog').close();
    if(active==='A'){s.agent=s.first;s.prompt=prompt1;execute(1);}else{s.phase='ready';s.prompt=s.goal;render();feedback('자료를 적용했습니다. 담당 AI와 지시를 확인하고 전송하세요.');$('prompt').focus();}
  };
  $('first-agent').onchange=$('second-agent').onchange=()=>count();
  $('agent').onchange=()=>{count();state().agent=$('agent').value;};$('prompt').oninput=()=>state().prompt=$('prompt').value;
  icon('fill-prompt','edit','이번 단계의 예시 지시 입력',()=>{count();state().prompt=state().phase==='handoff'?prompt2.replace('v2','v'+state().mapVersion):prompt1;$('prompt').value=state().prompt;feedback('예시 지시를 넣었습니다. 수정한 뒤 전송할 수 있습니다.');});
  function instruction(step){const s=state(),second=step===2;return ['작업: '+(second?'테스트 케이스 도출':'화면과 요구사항 연결'),'담당: '+s.agent+' / CLI 기본 모델 (데모)','', '사용자 지시:',s.prompt||'(아직 입력하지 않음)','', '입력 자료:',...(second?[s.includeMap?'연결표 v'+s.mapVersion+' (사용자 승인)':'연결표 제외',s.includeTests?'기존 테스트 자료':'기존 테스트 제외']:s.materials.flat().map(f=>roles[f.role]+': '+f.name)), '', '작업 범위: 선택한 자료만 분석. 코드 구현과 테스트 실행은 제외.','불명확한 내용: 추측해 확정하지 않고 확인 필요로 표시.','제출물: '+(second?'TC ID / 요구사항 ID / 절차 / 기대 결과 / 기존·신규 / 근거':'화면 ID / 화면 요소 / 요구사항 ID / 근거 / 확인 사항'),'종료 조건: 결과 제출 후 사용자 검토 대기. 다음 에이전트 직접 호출 금지.','', '※ 이 지시서는 UI 예시이며 외부 전송되지 않습니다.'].join('\n');}
  icon('instruction-open','file','전달할 지시서 미리보기',()=>{count();$('instruction-text').textContent=instruction(state().phase==='handoff'?2:1);$('instruction-dialog').showModal();});
  icon('instruction-close','close','작업 지시서 닫기',()=>$('instruction-dialog').close());
  icon('source-close','close','자료 확인 닫기',()=>$('source-dialog').close());
  function showSource(file){count();$('source-title').textContent=file.name;$('source-content').replaceChildren();
    if(file.sample&&file.role===1){const demo=node('div',undefined,'source-screen');demo.append(node('strong','로그인'),node('span','아이디'),node('span','비밀번호'),node('span','로그인','fake-button'));$('source-content').append(node('p','SCR-001 · 로그인 화면 예시','hint'),demo);}
    else if(file.sample){const text=file.role===0?'REQ-001: 아이디와 비밀번호를 입력한다.\nREQ-002: 인증 실패 시 오류를 표시한다.\nREQ-003: 필수 입력이 비어 있으면 제출하지 않는다.':file.role===2?'TC-001: 올바른 계정으로 로그인하면 홈 화면으로 이동한다.':'실패 횟수에 따른 계정 잠금은 이번 작업 범위에 포함하지 않는다.';$('source-content').append(node('pre',text));}
    else if(file.file?.type.startsWith('image/')){const image=node('img');image.alt=file.name;const url=URL.createObjectURL(file.file);image.src=url;image.onload=image.onerror=()=>URL.revokeObjectURL(url);$('source-content').append(node('p','이 브라우저에서만 미리 봅니다. 분석하거나 전송하지 않습니다.','hint'),image);}
    else $('source-content').append(node('p','파일 이름만 등록한 UI 예시입니다. 이 파일을 읽거나 분석하지 않았습니다.','hint'));
    $('source-dialog').showModal();
  }
  function table(headers,rows){const wrap=node('div',undefined,'table-wrap'),t=node('table'),head=node('thead'),tr=node('tr');for(const h of headers)tr.append(node('th',h));head.append(tr);t.append(head);const body=node('tbody');for(const row of rows){const r=node('tr');for(const value of row)r.append(node('td',value));body.append(r);}t.append(body);wrap.append(t);return wrap;}
  function revisionInstruction(){const c=revisionContext;if(!c)return '';return [
    '작업: 결과 수정', '담당: '+$('revision-agent').value,
    '기준: '+(c.message.type==='mapping'?'ART-MAP-001':'ART-TC-001')+' v'+c.message.version,
    '수정 대상: '+$('revision-target').value,'수정 의견:', $('revision-note').value,
    '입력: 아래 이전 결과와 누적 수정 의견', JSON.stringify(c.message,null,2),
    '종료 조건: 새 버전과 변경 요약 제출 후 사용자 재검토 대기. 다음 AI 직접 호출 금지.',
    '※ 데모 지시서이며 실제 전송·본문 수정은 하지 않습니다.'
  ].join('\n');}
  function openRevision(message){
    if(!['review','results'].includes(state().phase))return;
    count();revisionContext={key:active,state:state(),message};
    $('revision-base').textContent=(message.type==='mapping'?'ART-MAP-001':'ART-TC-001')+' · v'+message.version+' 기준';
    $('revision-target').replaceChildren();
    for(const value of ['전체 결과',...message.rows.map(r=>message.type==='mapping'?r[1]:r[0])]){const option=node('option',value);option.value=value;$('revision-target').append(option);}
    $('revision-note').value='';$('revision-agent').value=message.agent;$('revision-error').textContent='';
    $('revision-instruction').textContent=revisionInstruction();$('revision-dialog').showModal();
  }
  for(const id of ['revision-target','revision-note','revision-agent'])$(id).addEventListener('input',()=>{$('revision-instruction').textContent=revisionInstruction();});
  icon('revision-close','close','수정 요청 닫기',()=>$('revision-dialog').close());
  icon('revision-submit','send','수정 요청 전송');$('revision-submit').type='submit';
  $('revision-form').onsubmit=e=>{
    e.preventDefault();const c=revisionContext;if(!c||c.key!==active||c.state!==state()||!['review','results'].includes(state().phase))return;
    const note=$('revision-note').value.trim();if(!note){$('revision-error').textContent='수정 의견을 입력하세요.';return;}
    count();const s=c.state,m=c.message,agent=$('revision-agent').value,target=$('revision-target').value;
    s.messages.push({type:'user',text:(m.type==='mapping'?'연결표':'테스트 결과')+' v'+m.version+' 수정 요청 → '+agent+'\n대상: '+target+'\n'+note});s.phase='processing';s.revising=m.type;
    $('revision-dialog').close();render();
    setTimeout(()=>{if(variants[c.key]!==s)return;
      const next={...m,version:m.version+1,agent,notes:[...(m.notes||[]),{target,note}]};
      s.messages.push(next);if(m.type==='mapping')s.mapVersion=next.version;else s.testVersion=next.version;
      s.phase=m.type==='mapping'?'review':'results';s.revising=null;
      if(active===c.key){render();feedback('새 버전에 수정 의견을 기록했습니다. 본문은 고정 예시입니다. 변경 요청을 확인하고 다시 승인하세요.');}
    },650);
  };
  function revisionHistory(card,m){if(!m.notes?.length)return;const details=node('details');details.append(node('summary','수정 요청 이력 · '+m.notes.length+'건 (본문 변경은 미실행)'));for(const n of m.notes)details.append(node('p',n.target+' — '+n.note,'fix-note'));card.append(details);}
  function renderMessages(){const s=state();$('messages').replaceChildren();if(!s.messages.length){const empty=node('div',undefined,'empty');empty.append(node('p',active==='A'?'PLAN → REVIEW → NEXT':'INSTRUCT → REVIEW → HAND OFF','eyebrow'),node('h2',active==='A'?'순서를 정하고 시작합니다.':'결과를 보고 다음을 지시합니다.'),node('p',active==='A'?'입력창 아래 작업 시작 아이콘에서 자료와 단계별 AI를 설정하세요.':'입력창 아래 작업 시작 아이콘으로 자료를 준비하세요. 결과를 확인한 뒤 같은 입력창에서 다음 AI를 고릅니다.'));$('messages').append(empty);}
    for(const m of s.messages){const box=node('article',undefined,'message');if(m.type==='user'){box.append(node('div',m.text,'user-message'));}
      else if(m.type==='mapping'){
        box.append(node('p',m.agent+' · 완료 · 예시 결과','run-meta'));const card=node('section',undefined,'result-card');card.append(node('div','ART-MAP-001 · v'+m.version+(m.version!==s.mapVersion?' · 이전 버전':s.approved?' · 승인됨':' · 검토 대기'),'version'),node('h3','SCR-001 · 로그인 화면'),node('p','이 화면에 연결된 요구사항은 다음과 같습니다. 샘플 자료의 고정된 예시이며 선택한 실제 파일의 분석 결과는 아닙니다.'));
        card.append(table(['화면 요소','요구사항','근거'],m.rows));
        card.append(node('p','확인 필요: 실패 횟수에 따른 잠금 정책은 화면만으로 확인할 수 없습니다.','fix-note'));revisionHistory(card,m);
        const actions=node('div',undefined,'result-actions');actions.append(node('p',s.approved?'승인한 버전이 다음 작업의 입력으로 연결됩니다.':'근거와 연결 내용을 확인한 후 승인하세요.'));
        actions.append(iconButton('file','화면 자료 예시 보기',()=>showSource(sampleFiles()[1])));
        if(!s.approved&&s.phase==='review'&&m.version===s.mapVersion){actions.append(iconButton('edit','연결 결과 수정 요청',()=>openRevision(m)),iconButton('check','연결 결과 승인',approveMapping));}card.append(actions);box.append(card);
      }else if(m.type==='tests'){
        box.append(node('p',m.agent+' · 완료 · 예시 결과','run-meta'));const card=node('section',undefined,'result-card');card.append(node('div','ART-TC-001 · v'+m.version+' · 연결표 v'+m.mapVersion+' 기준'+(m.version!==s.testVersion?' · 이전 버전':s.finished?' · 확인 완료':' · 검토 대기'),'version'),node('h3','테스트 케이스 도출 결과'),node('p','예시 입력과 승인된 연결을 사용한 결과 화면입니다. 실제 테스트 실행 결과가 아닙니다.'));
        const rows=m.rows;revisionHistory(card,m);
        card.append(table(['테스트','구분','요구사항','절차 → 기대 결과'],rows),node('p',s.includeTests?'기존 1개 연결, 신규 3개 제안. 길이 제한은 요구사항이 없어 확인 필요로 남깁니다.':'기존 테스트를 제외한 체험입니다. 신규 3개 제안. 기존/누락 비교는 수행하지 않았습니다.'));
        const actions=node('div',undefined,'result-actions');actions.append(node('p','결과를 확인하면 이번 안의 체험이 완료됩니다.'));if(!s.finished&&s.phase==='results'&&m.version===s.testVersion)actions.append(iconButton('edit','테스트 결과 수정 요청',()=>openRevision(m)),iconButton('check','테스트 결과 확인 완료',finish));else if(s.finished&&m.version===s.testVersion)actions.append(node('span','확인 완료','badge'));card.append(actions);box.append(card);
      }$('messages').append(box);
    }
    if(s.phase==='processing'){$('messages').append(node('p','● 처리 중… 예시 결과를 준비하고 있습니다.','run-meta'));}
    $('messages').scrollTop=$('messages').scrollHeight;
  }
  function approveMapping(){count();const s=state();s.approved=true;s.phase='handoff';s.prompt='';if(active==='A'){s.agent=s.second;s.prompt='승인된 연결표 v'+s.mapVersion+'를 기준으로 기존 테스트를 검토하고 신규 케이스를 도출하라.';}render();feedback(active==='A'?'미리 설정한 다음 담당과 지시를 준비했습니다. 지시서를 확인하고 전송하세요.':'연결표를 다음 입력에 포함했습니다. AI를 선택하고 다음 작업을 지시하세요.');$('prompt').focus();}
  function execute(step){const key=active,s=state();s.messages.push({type:'user',text:s.prompt});s.phase='processing';const agent=s.agent;s.prompt='';render();setTimeout(()=>{if(variants[key]!==s)return;const rows=step===1?[['아이디·비밀번호','REQ-001 · 계정 정보 입력','요구사항 예시 §1'],['오류 안내','REQ-002 · 인증 실패 안내','요구사항 예시 §2'],['로그인 버튼','REQ-003 · 필수 입력 확인','요구사항 예시 §3']]:[['TC-002','신규','REQ-002','잘못된 비밀번호 → 오류 안내'],['TC-003','신규','REQ-003','아이디 비움 → 제출 차단'],['TC-004','신규','REQ-003','비밀번호 비움 → 제출 차단']];if(step===2&&s.includeTests)rows.unshift(['TC-001','기존','REQ-001','정상 계정 → 홈 화면 이동']);s.messages.push({type:step===1?'mapping':'tests',agent,version:1,mapVersion:s.mapVersion,rows,notes:[]});s.phase=step===1?'review':'results';if(key===active){render();feedback(step===1?'연결 결과를 검토해 주세요.':'테스트 초안을 확인해 주세요.');}},650);}
  icon('send','send','작업 지시 전송');$('send').type='submit';
  $('composer').onsubmit=e=>{e.preventDefault();const s=state();if(!['ready','handoff'].includes(s.phase))return;count();if(!s.prompt.trim()){feedback('수행할 작업을 입력하세요. 연필 아이콘으로 예시 지시를 넣을 수도 있습니다.');return;}if(s.phase==='handoff'&&!s.includeMap){feedback('이 체험의 테스트 도출에는 승인된 연결표가 필요합니다. 입력 자료에서 다시 선택하세요.');return;}execute(s.phase==='handoff'?2:1);};
  function finish(){if(state().phase!=='results')return;count();tick();const s=state();s.finished=true;s.phase='done';records.push({variant:active,seconds:Math.round(s.ms/100)/10,actions:s.actions});render();feedback('체험 완료. 다른 안도 사용한 뒤 상단의 체험 기록에서 비교해 보세요.');}
  function render(){const s=state();$('variant-a').setAttribute('aria-pressed',String(active==='A'));$('variant-b').setAttribute('aria-pressed',String(active==='B'));$('variant-description').textContent=active==='A'?'자료와 두 단계의 담당을 먼저 정합니다. 검토 후 다음 지시가 준비됩니다.':'자료를 한 번 등록합니다. 결과를 보고 AI와 다음 지시를 직접 정합니다.';
    const stages=['자료 준비','연결 분석','연결 검토','테스트 도출','결과 확인'],positions={empty:0,ready:0,processing:s.revising?(s.revising==='mapping'?2:4):s.messages.some(m=>m.type==='mapping')?3:1,review:2,handoff:3,results:4,done:5},at=positions[s.phase];$('steps').replaceChildren();stages.forEach((text,i)=>$('steps').append(node('li',(i<at?'✓ ':i===at?'● ':'○ ')+(i+1)+'. '+text,i<at?'done':i===at?'current':'')));
    $('phase').textContent={empty:'자료 등록 전',ready:'첫 지시 준비',processing:'처리 중',review:'사용자 검토 대기',handoff:'다음 지시 준비',results:'결과 확인 대기',done:'체험 완료'}[s.phase];
    $('material-summary').replaceChildren();const files=s.materials.flat();if(!files.length)$('material-summary').append(node('p','등록된 자료가 없습니다.','hint'));for(const f of files){const item=node('div',undefined,'material-mini'),b=node('button',f.name,'file-choice');b.onclick=()=>showSource(f);item.append(b,node('small',roles[f.role]+(f.sample?' · 예시':' · 이름만 등록')));$('material-summary').append(item);}
    $('input-artifacts').replaceChildren();if(s.phase==='handoff'){for(const [key,label] of [['includeMap','연결표 v'+s.mapVersion+' · 승인'],['includeTests','기존 테스트 자료']]){const chip=node('label',undefined,'chip'),input=node('input');input.type='checkbox';input.checked=s[key];input.disabled=key==='includeTests'&&!s.materials[2].length;input.onchange=()=>{count();s[key]=input.checked;feedback('다음 작업에 포함할 자료를 변경했습니다. 지시서에서 확인하세요.');};chip.append(input,node('span',label));$('input-artifacts').append(chip);}}else if(s.phase==='ready')$('input-artifacts').append(node('span',files.length+'개 자료를 첫 작업에 포함','chip'));
    $('prompt').value=s.prompt;$('agent').value=s.agent;const enabled=['ready','handoff'].includes(s.phase);$('send').disabled=!enabled;$('prompt').disabled=!enabled;$('agent').disabled=!enabled||(active==='A');$('model').disabled=!enabled;$('fill-prompt').disabled=!enabled;$('instruction-open').disabled=!enabled;
    $('start-modal').disabled=!['empty','ready'].includes(s.phase);$('materials-open').disabled=$('start-modal').disabled;$('composer-hint').textContent=s.phase==='empty'?'왼쪽 작업 시작 아이콘에서 자료를 등록하세요.':s.phase==='review'?'결과 승인 후 다음 지시를 준비합니다.':'전송 전에 입력 자료와 지시서를 확인하세요.';
    $('feedback').textContent=s.feedback;renderMessages();
  }
  function compare(){const root=$('comparison');root.replaceChildren();const rows=['A','B'].map(v=>{const r=records.filter(x=>x.variant===v);return [v==='A'?'A · 순서 먼저 설정':'B · 결과 보고 지시',String(r.length),r.length?(r.reduce((a,x)=>a+x.seconds,0)/r.length).toFixed(1)+'초':'—',r.length?(r.reduce((a,x)=>a+x.actions,0)/r.length).toFixed(1)+'회':'—'];});root.append(table(['방식','완료 체험','평균 시간','평균 조작'],rows),node('p','첫 시도는 학습 시간이 포함됩니다. A→B와 B→A 순서를 번갈아 체험하고, 수치와 함께 전달 자료가 명확했는지 판단해 주세요.','hint'));}
  $('compare-open').onclick=()=>{compare();$('compare-dialog').showModal();};icon('compare-close','close','체험 기록 닫기',()=>$('compare-dialog').close());
  icon('download','save','체험 수치 내려받기',()=>{const blob=new Blob([JSON.stringify({kind:'UI simulation only',records,preference:$('preference').value},null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=node('a');a.href=url;a.download='codast-workflow-demo-metrics.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
  render();
})();
