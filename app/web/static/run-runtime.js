/* Runtime snapshots report server activity; reconnecting never starts an execution. */
(()=>{
  function parseTimeout(value,unlimited){
    if(unlimited)return null;
    const seconds=Number(value);
    if(!String(value).trim()||!Number.isSafeInteger(seconds)||seconds<1)throw Error('실행 제한 시간은 1초 이상의 정수로 입력하거나 제한 없음을 선택하세요.');
    return seconds;
  }
  function duration(seconds){
    seconds=Math.max(0,Math.floor(seconds));
    const hours=Math.floor(seconds/3600),minutes=Math.floor(seconds%3600/60);
    return (hours?hours+'시간 ':'')+(minutes?minutes+'분 ':'')+seconds%60+'초';
  }
  function describe(row,clock,connection){
    const state=connection==='disconnected'?'연결 끊김, 실행 상태 확인 중':connection==='detached'?'종료 확인 필요':
      row.termination_reason==='timeout'?'시간 초과':({running:'실행 중',completed:'완료',failed:'실패',interrupted:'취소 또는 중단'}[row.status]||'실행 상태 확인 중');
    const start=Date.parse(row.started_at),end=row.status==='running'?clock:Date.parse(row.finished_at);
    const elapsed=Number.isFinite(start)&&Number.isFinite(end)?'경과 '+duration((end-start)/1000):'경과 시간 확인 중';
    const last=Date.parse(row.last_progress_at),reference=Number.isFinite(end)?end:clock;
    const progress=Number.isFinite(last)?'마지막 진행 '+new Date(last).toLocaleString()+' ('+duration((reference-last)/1000)+' 전)':'진행 이벤트 아직 없음';
    const limit=row.timeout_seconds===null?'제한 없음':row.timeout_seconds+'초 제한';
    const silent=row.status==='running'&&connection==='connected'&&Number.isFinite(start)&&clock-(Number.isFinite(last)?last:start)>=120000;
    return state+' / '+elapsed+' / '+limit+'\n'+progress+
      (connection==='disconnected'?'\n마지막으로 확인한 상태입니다. 연결되면 같은 실행을 다시 확인합니다.':'')+
      (silent?'\n새 진행 이벤트가 2분 이상 없습니다. 추론이나 도구 실행 중일 수 있습니다.':'');
  }
  function create(runId){
    const node=document.createElement('p');node.className='run-runtime hint';node.style.whiteSpace='pre-line';
    node.textContent='실행 시간 확인 중';
    let row=null,received=0,connection='connecting',timer=null;
    function render(){
      if(!row)return;
      const clock=Date.parse(row.server_time)+(connection==='connected'?Math.max(0,Date.now()-received):0);
      node.textContent=describe(row,clock,connection);
    }
    const stop=()=>{clearInterval(timer);timer=null;};
    return {node,stop,
      update(value){
        if(value.run_id!==runId||!Number.isFinite(Date.parse(value.server_time)))return;
        row=value;received=Date.now();connection='connected';render();
        if(row.status==='running'&&timer===null)timer=setInterval(render,1000);
        else if(row.status!=='running')stop();
      },
      connection(value){connection=value;render();if(value==='detached')stop();}
    };
  }
  const api={parseTimeout,describe,create,
    loadSettings(settings){
      const value=settings.timeout_seconds===undefined?600:settings.timeout_seconds;
      document.getElementById('execution-unlimited').checked=value===null;
      const input=document.getElementById('execution-timeout');input.value=value??600;input.disabled=value===null;
    },
    settings(){return {timeout_seconds:parseTimeout(document.getElementById('execution-timeout').value,
                                                   document.getElementById('execution-unlimited').checked)};}
  };
  if(typeof module!=='undefined')module.exports=api;
  if(typeof window!=='undefined'){
    window.runRuntime=api;
    document.getElementById('execution-unlimited').addEventListener('change',event=>{
      document.getElementById('execution-timeout').disabled=event.target.checked;
    });
  }
})();
