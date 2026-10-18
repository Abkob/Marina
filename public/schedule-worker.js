/* Notifications only: never cache authenticated application data or API reads. */
self.addEventListener('push',event=>{
  let data={};try{data=event.data?.json()??{};}catch{}
  const title=typeof data.title==='string'?data.title:'Marina check-in';
  event.waitUntil(self.registration.showNotification(title,{body:typeof data.body==='string'?data.body:'Open your schedule to check in.',tag:data.tag||'marina-checkin',icon:'/icons/icon-192.png',badge:'/icons/icon-192.png',data:{url:data.url||'/?view=schedule&checkin=1'}}));
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  event.waitUntil((async()=>{
    const url=new URL(event.notification.data?.url||'/?view=schedule&checkin=1',self.location.origin);
    if(url.origin!==self.location.origin)return;
    const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    for(const client of windows)if(new URL(client.url).origin===url.origin){await client.navigate(url.href);await client.focus();return;}
    await self.clients.openWindow(url.href);
  })());
});
