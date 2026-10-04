/* Navigation uses rendered requests only; no model or extra history requests. */
(()=>{
  const messages=document.getElementById('messages');
  const pane=document.createElement('div');pane.className='conversation-pane';
  messages.before(pane);pane.append(messages);
  const nav=document.createElement('nav');nav.className='chat-outline';nav.setAttribute('aria-label','현재 페이지 대화 목차');pane.prepend(nav);
  let entries=[],frame=0;
  function highlight(){
    frame=0;if(!entries.length)return;
    const top=messages.getBoundingClientRect().top+24;
    let current=entries[0];
    for(const entry of entries){if(entry.card.getBoundingClientRect().top<=top)current=entry;else break;}
    if(messages.scrollHeight>messages.clientHeight&&messages.scrollTop+messages.clientHeight>=messages.scrollHeight-2)current=entries.at(-1);
    for(const entry of entries){if(entry===current)entry.button.setAttribute('aria-current','location');else entry.button.removeAttribute('aria-current');}
  }
  function schedule(){if(!frame)frame=requestAnimationFrame(highlight);}
  function rebuild(){
    pane.hidden=messages.hidden;
    entries=[...messages.querySelectorAll(':scope > .message')].map((card,index)=>{
      const label=(card.querySelector('.user')?.textContent||'요청').replace(/\s+/g,' ').trim();
      const button=document.createElement('button');button.type='button';button.className='outline-item';
      button.setAttribute('aria-label',(index+1)+'. '+label.slice(0,120));
      const mark=document.createElement('span');mark.className='outline-mark';mark.setAttribute('aria-hidden','true');
      const preview=document.createElement('span');preview.className='outline-preview';preview.textContent=label.slice(0,120);preview.setAttribute('aria-hidden','true');
      button.append(mark,preview);
      button.onclick=()=>{messages.scrollTo({top:messages.scrollTop+card.getBoundingClientRect().top-messages.getBoundingClientRect().top-8,behavior:'instant'});schedule();};
      return {card,button};
    });
    nav.replaceChildren(...entries.map(e=>e.button));nav.hidden=!entries.length;schedule();
  }
  new MutationObserver(rebuild).observe(messages,{childList:true,attributes:true,attributeFilter:['hidden']});
  new ResizeObserver(schedule).observe(messages);
  messages.addEventListener('scroll',schedule,{passive:true});rebuild();
})();
