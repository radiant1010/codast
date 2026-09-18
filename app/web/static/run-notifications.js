/* Only cursors and compact notices are stored locally; output remains in SQLite. */
(()=>{
  const key='codast.run-notifications.v1';let state={cursor:0,unread:0,events:[]},busy=false;
  try{const saved=JSON.parse(localStorage.getItem(key));if(Number.isSafeInteger(saved?.cursor)&&saved.cursor>=0&&Number.isSafeInteger(saved.unread)&&saved.unread>=0&&Array.isArray(saved.events))state=saved;}catch{}
  const persist=()=>{try{localStorage.setItem(key,JSON.stringify(state));}catch{}};
  window.runNotifications={
    snapshot:()=>state,
    read(){state.unread=0;persist();},
    async refresh(){
      if(busy)return;busy=true;
      try{
        // Bounded catch-up. Further pages are fetched on the next refresh.
        for(let page=0;page<4;page++){
          const data=await api('/notifications?after='+state.cursor),events=(data.events||[]).filter(row=>row.seq>state.cursor);
          for(const row of events){if(!state.events.some(old=>old.run_id===row.run_id)){state.events.push(row);state.unread++;}}
          state.events=state.events.slice(-100);state.cursor=Math.max(state.cursor,data.cursor||0);persist();
          if(!data.has_more||!events.length)break;
        }
        return state;
      }finally{busy=false;}
    }
  };
})();
