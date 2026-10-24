/* Only sanitized Markdown reaches the DOM; source text stays on consoleSource. */
(()=>{
  if(!window.marked||!window.DOMPurify)return;
  const escape=text=>String(text).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const markdown=new marked.Marked({gfm:true,breaks:true,renderer:{
    html:({text})=>escape(text),
    // Remote images must not send requests merely because an answer is displayed.
    image:({href,text})=>'<a href="'+escape(href)+'">'+escape(text||'이미지')+' (이미지)</a>',
  }});
  window.renderMarkdown=(node,source)=>{
    try{
      const fragment=DOMPurify.sanitize(markdown.parse(source),{
        RETURN_DOM_FRAGMENT:true,ALLOW_DATA_ATTR:false,ALLOW_ARIA_ATTR:false,
        ALLOWED_TAGS:['p','br','strong','em','del','ul','ol','li','blockquote','hr','table','thead','tbody','tr','th','td','h1','h2','h3','h4','h5','h6','pre','code','a','input'],
        ALLOWED_ATTR:['href','title','class','start','style','type','checked','disabled'],
      });
      for(const link of fragment.querySelectorAll('a[href]')){
        let url;try{url=new URL(link.getAttribute('href'),location.href);}catch{}
        if(!url||!['http:','https:','mailto:'].includes(url.protocol)){link.removeAttribute('href');continue;}
        link.target='_blank';link.rel='noopener noreferrer';
      }
      for(const table of fragment.querySelectorAll('table')){
        const scroll=el('div',undefined,'markdown-table');scroll.tabIndex=0;scroll.setAttribute('role','region');scroll.setAttribute('aria-label','표, 내용이 길면 좌우로 스크롤');
        table.before(scroll);scroll.append(table);
      }
      for(const pre of fragment.querySelectorAll('pre')){
        const code=pre.querySelector('code');if(!code)continue;
        const block=el('div',undefined,'markdown-code'),header=el('div',undefined,'markdown-code-header');
        const language=Array.from(code.classList).find(name=>name.startsWith('language-'))?.slice(9)||'코드';
        const copy=button('복사',async()=>{
          try{await navigator.clipboard.writeText(code.textContent);}
          catch{throw Error('코드를 복사하지 못했습니다. 코드 내용을 선택해 복사하세요.');}
          copy.textContent='복사됨';setTimeout(()=>{copy.textContent='복사';},2000);
        });
        copy.setAttribute('aria-label','코드 복사');header.append(el('span',language),copy);
        pre.tabIndex=0;pre.setAttribute('aria-label','코드');pre.before(block);block.append(header,pre);
      }
      node.replaceChildren(fragment);node.classList.remove('plain-output');node.classList.add('markdown-output');return true;
    }catch{
      node.classList.remove('markdown-output');node.classList.add('plain-output');return false;
    }
  };
})();
