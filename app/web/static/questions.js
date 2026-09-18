/* Durable server questions with browser-local answer drafts and retry keys. */
window.questionCard=(message,b,refresh)=>{
  const info=metadata(message.metadata),question=info.question;if(!question)return null;
  const section=el('section',undefined,'user-question');section.append(el('h3',info.reply_run_id?'답변 접수됨':info.superseded_by?'이후 대화에서 계속됨':'사용자 답변 대기'),el('p',question.question));
  if(info.reply_run_id||info.superseded_by){section.append(el('p',info.reply_run_id?'답변을 전달했습니다. 이어진 실행의 결과를 확인하세요.':'새 요청으로 이어졌습니다. 현재 대화에서 계속해 주세요.','hint'));return section;}
  const key='codast.question.'+b+'.'+message.run_id;let draft={answer:'',request_id:null};
  try{draft={...draft,...JSON.parse(localStorage.getItem(key)||'{}')};}catch{}
  const save=()=>{try{localStorage.setItem(key,JSON.stringify(draft));}catch{}};
  const input=el('textarea');input.rows=2;input.maxLength=4000;input.value=draft.answer;input.setAttribute('aria-label','질문에 대한 답변');
  input.oninput=()=>{draft.answer=input.value;draft.request_id=null;save();};
  const choices=el('div',undefined,'question-choices');
  for(const choice of question.choices||[])choices.append(button(choice,()=>{input.value=choice;input.oninput();input.focus();}));
  const status=el('p',undefined,'hint'),send=button('답변하고 계속',async()=>{
    const answer=input.value.trim();if(!answer){status.textContent='답변을 입력하세요.';input.focus();return;}
    const generation=epoch;send.disabled=true;input.disabled=true;for(const node of choices.children)node.disabled=true;
    try{
      draft.request_id??=crypto.randomUUID();save();status.textContent='답변 전달 중…';
      await api(b+'/runs/'+message.run_id+'/reply','POST',{answer,request_id:draft.request_id});
      try{localStorage.removeItem(key);}catch{}
      if(valid(b,generation)){await refresh(b);notice('답변을 전달했습니다. 같은 에이전트와 권한으로 이어갑니다.');}
    }catch(error){status.textContent=error.message;}
    finally{send.disabled=false;input.disabled=false;for(const node of choices.children)node.disabled=false;}
  });
  section.append(choices,input,send,status);return section;
};
