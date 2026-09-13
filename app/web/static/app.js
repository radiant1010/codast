const $ = id => document.getElementById(id);
let terminal;
if (window.Terminal) { terminal = new Terminal({rows:17,cols:80,convertEol:true,disableStdin:true,theme:{background:'#0b1017',foreground:'#d7e3f2'},fontSize:13}); terminal.open($('terminal')); }
else { $('fallback').hidden = false; $('terminal').hidden = true; }
function output(text) {
  const safe = String(text).replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, '');
  if (terminal) terminal.writeln(safe); else $('fallback').textContent += safe + '\n';
}
async function api(path, method='GET', body) {
  const response = await fetch('/api'+path,{method,headers:{'Content-Type':'application/json'},body:body === undefined ? undefined : JSON.stringify(body)});
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail));
  return data;
}
function base(){ if (!$('project').value) throw new Error('Workspace를 선택하세요.'); return '/projects/'+encodeURIComponent($('project').value); }
async function act(fn){try {await fn();}catch(e){$('status').textContent=e.message;output('ERROR: '+e.message);}}
async function projects(selected=''){
  const data=await api('/projects'); $('project').replaceChildren(new Option('선택하세요',''));
  data.projects.forEach(p=>$('project').add(new Option(p,p))); $('project').value=selected;
}
async function refresh(){
  const b=base(); const data=await api(b+'/rules?cwd='+encodeURIComponent($('cwd').value));
  $('rules').textContent=data.rules.map(r=>'# '+r.path+'\n'+r.content).join('\n') || 'RULES.md 없음';
  const listing=await api(b+'/files'); $('files').replaceChildren();
  listing.files.forEach(path=>{const label=document.createElement('label'), box=document.createElement('input');box.type='checkbox';box.value=path;label.append(box,document.createTextNode(path));$('files').append(label);});
  $('status').textContent=$('project').value+' 준비 완료 · Rule '+data.rules.length+'개';
}
$('create').onsubmit=e=>{e.preventDefault();act(async()=>{const name=$('name').value;await api('/projects','POST',{name});await projects(name);await refresh();});};
$('project').onchange=()=>act(async()=>{if(!$('project').value){$('rules').textContent='Workspace 선택 대기';$('files').replaceChildren();return;}$('cwd').value='.';await refresh();});
$('reload').onclick=()=>act(refresh);
$('command').onsubmit=e=>{e.preventDefault();act(async()=>{
  $('run').disabled=true;
  try {const b=base(), text=$('text').value; $('status').textContent='실행 중…';output('> '+text);
    const result=await api(b+'/commands','POST',{text,cwd:$('cwd').value,context_paths:[...$('files').querySelectorAll('input:checked')].map(n=>n.value)});
    output(result.output);$('status').textContent='완료 · '+result.adapter; $('text').value='';
  }finally{$('run').disabled=false;}
});};
$('read').onclick=()=>act(async()=>{const data=await api(base()+'/file?path='+encodeURIComponent($('path').value));$('content').value=data.content;$('status').textContent='파일 읽기 완료';});
$('write').onclick=()=>act(async()=>{await api(base()+'/file','PUT',{path:$('path').value,content:$('content').value});await refresh();$('status').textContent='파일 저장 완료';});
output('AI Coding Harness / Phase 1\nMock Agent 준비 완료. Workspace를 선택하세요.');
act(()=>projects());
