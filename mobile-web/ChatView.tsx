import { Markdown } from './Markdown';
import { useEffect, useMemo, useState } from 'react';
import { z } from 'zod';
import { ChevronRight, MessageSquare, Plus, Send } from 'lucide-react';
import { syncedChatSchema, syncedMessageSchema } from '../shared/chat-sync';
import { projectConversation } from '../shared/conversation';
import { library, dateLabel } from './domain';
import type { OrganatoSnapshot } from './domain';
import { assignmentNotificationContext } from './notifications';
import { MobileRequestError, type MobileState } from './data/store';
import type { MobileModel } from './model';
import { Back, Empty, ErrorLine, useAction } from './ui';
const journalSchema=z.object({id:z.uuid(),chatId:z.string(),messageId:z.string()});
const replySchema=z.object({run:z.object({status:z.enum(['queued','running','completed','failed','interrupted']),errorCode:z.string().nullable()})});
export function ChatView({state,model,selected,onSelect,snapshot,onOpenResource}:{state:MobileState;model:MobileModel;selected:string|null;onSelect:(id:string|null)=>void;snapshot:OrganatoSnapshot|null;onOpenResource:(id:string)=>void}) {
  const data=useMemo(()=>library(state.entities),[state.entities]),action=useAction();
  const chat=data.chats.find(item=>item.id===selected);
  if(chat)return <Conversation key={`${state.session?.workspaceId}:${chat.id}`} state={state} model={model} chatId={chat.id} snapshot={snapshot} onOpenResource={onOpenResource} onBack={()=>onSelect(null)}/>;
  return <><div className="page-title"><div><p className="muted">A place to think it through</p><h1>Chat</h1></div><button className="icon-button" aria-label="New chat" disabled={action.busy} onClick={()=>void action.run(async()=>{const stamp=new Date().toISOString();const next=syncedChatSchema.parse({id:crypto.randomUUID(),title:'New chat',createdAt:stamp,updatedAt:stamp,deletedAt:null,pinnedAt:null,folderId:null,sortOrder:0,modelSelection:null,lineage:{schemaVersion:1,kind:'root'}});await model.store.save('chat',next.id,next);onSelect(next.id);})}><Plus/></button></div>
    {!data.chats.length?<Empty title="Pick up a thought">Create a chat here or sync conversations from your Mac. Replies on this phone use Centre Cloud AI.</Empty>:<div className="list">{data.chats.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).map(item=><button className="list-row" key={item.id} onClick={()=>onSelect(item.id)}><MessageSquare size={18}/><div><h2>{item.title}</h2><p>{dateLabel(item.updatedAt)}</p></div><ChevronRight size={18}/></button>)}</div>}<ErrorLine error={action.error}/>
  </>;
}
function Conversation({state,model,chatId,snapshot,onBack,onOpenResource}:{state:MobileState;model:MobileModel;chatId:string;snapshot:OrganatoSnapshot|null;onBack:()=>void;onOpenResource:(id:string)=>void}) {
  const data=useMemo(()=>library(state.entities),[state.entities]),chat=data.chats.find(item=>item.id===chatId);
  const messages=data.messages.filter(item=>item.chatId===chatId).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));
  const conversation=projectConversation(messages);
  const [text,setText]=useState(''),[journal,setJournal]=useState<z.infer<typeof journalSchema>|null>(null),[consent,setConsent]=useState(false),[loaded,setLoaded]=useState(false),[draftError,setDraftError]=useState<string|null>(null),[restoreError,setRestoreError]=useState(false),[loadVersion,setLoadVersion]=useState(0);
  const action=useAction();
  useEffect(()=>{let live=true;setLoaded(false);setRestoreError(false);void model.serial(async()=>Promise.all([model.store.getLocal(`compose:${chatId}`),model.store.getLocal(`run:${chatId}`),model.store.getLocal('cloud-ai-consent')])).then(([saved,run,agreed])=>{if(!live)return;setText(typeof saved==='string'?saved:'');const parsed=journalSchema.safeParse(run);setJournal(parsed.success?parsed.data:null);setConsent(agreed===true);setLoaded(true);}).catch(()=>{if(live)setRestoreError(true);});return()=>{live=false;};},[model,chatId,loadVersion]);
  async function runAi(input:z.infer<typeof journalSchema>) {
    await model.store.sync();
    const snapshot=model.store.getSnapshot();
    if(snapshot.pending||snapshot.conflicts.length)throw new Error('Connect and finish syncing this chat before requesting a reply.');
    let value:unknown;
    try {
      try{value=await model.store.request(`/v1/ai/runs/${input.id}`);}catch(error){if(!(error instanceof MobileRequestError)||error.status!==404)throw error;value=await model.store.request('/v1/ai/runs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});}
    } catch(error) {
      if(error instanceof MobileRequestError&&[400,409,413,415,422].includes(error.status)){await model.store.saveLocal(`run:${chatId}`,null);setJournal(null);throw new Error('This reply request was rejected. Your message is saved. Try a shorter message or start a new chat.');}
      throw error;
    }
    const reply=replySchema.parse(value).run;
    if(reply.status==='queued'||reply.status==='running')throw new Error('Your reply is in progress. Tap Check reply in a moment.');
    await model.store.sync();await model.store.saveLocal(`run:${chatId}`,null);setJournal(null);
    if(reply.status!=='completed')throw new Error('Centre Cloud could not finish this reply. Your message is saved. You can send another message when you are ready.');
  }
  async function send() {
    if(!chat||!loaded)return;
    if(journal){await runAi(journal);return;}
    if(!text.trim())throw new Error('Write a message first.');
    if(!consent)throw new Error('Choose Use Centre Cloud AI before sending.');
    const stamp=new Date().toISOString(),messageText=text.trim();
    const noticeState={resources:data.resources,assignments:snapshot?.assignments??[],subjects:snapshot?.subjects??[]};
    const notification=assignmentNotificationContext(noticeState,messageText) ?? messages.filter(message=>message.role==='user').slice(-6).reverse().map(message=>assignmentNotificationContext(noticeState,message.content)).find(context=>context!==null) ?? null;
    const message=syncedMessageSchema.parse({id:crypto.randomUUID(),chatId,role:'user',content:messageText,createdAt:stamp,responseDurationMs:null,resourceIds:notification?[notification.id]:[],attachmentIds:[],requestContext:{page:'chat',...(notification?{resourceId:notification.id}:{})}});
    const input={id:crypto.randomUUID(),chatId,messageId:message.id};
    await model.serial(()=>model.store.saveBatch([{kind:'chat',id:chatId,data:{...chat,title:chat.title==='New chat'?text.trim().slice(0,80):chat.title,updatedAt:stamp}},{kind:'message',id:message.id,data:message}],{[`run:${chatId}`]:input,[`compose:${chatId}`]:''}));
    setText('');setJournal(input);await runAi(input);
  }
  return <><Back onClick={onBack}>Chats</Back><div className="page-title"><h1>{chat?.title??'Chat'}</h1></div><p className="detail">Replies use Centre Cloud AI. Your laptop can stay closed. Daily limits apply.</p>
    {!messages.length?<Empty title="What are you working on?">Ask a question, plan a study session or work through a difficult idea.</Empty>:<div className="messages">{conversation.visible.map(({message:item,questionAnswers})=><article className={`message message--${item.role}`} key={item.id}>{questionAnswers.length?<QuestionAnswers messages={questionAnswers}/>:null}<p className="message-role">{item.role==='user'?'You':'Centre'}</p><Markdown text={item.content}/>{item.resourceIds.map(id=>data.resources.find(resource=>resource.id===id)).filter(resource=>resource!==undefined).map(resource=><button type="button" className="button" key={resource.id} onClick={()=>onOpenResource(resource.id)}>{resource.title}</button>)}{item.attachmentIds.length?<p className="detail">{item.attachmentIds.length} saved {item.attachmentIds.length===1?'attachment':'attachments'}. Open this conversation on your Mac to view them.</p>:null}</article>)}{conversation.trailingQuestionAnswers.length?<QuestionAnswers messages={conversation.trailingQuestionAnswers}/>:null}</div>}
    {<label className="choice consent"><input type="checkbox" disabled={!loaded||action.busy} checked={consent} onChange={event=>{const checked=event.target.checked;setConsent(checked);void model.serial(()=>model.store.saveLocal('cloud-ai-consent',checked)).catch(()=>{setConsent(!checked);setDraftError('Your AI preference could not be saved. Please try again.');});}}/><span>Use Centre Cloud AI. My messages will be sent to Cloudflare for a reply.</span></label>}
    {restoreError?<div className="notice" role="alert"><p>Your saved draft could not be opened. Retry before writing a new message.</p><button className="button" onClick={()=>setLoadVersion(value=>value+1)}>Retry opening draft</button></div>:null}
    {journal?<div className="notice"><p>A reply request is saved. Checking it uses the same request.</p><button className="button" disabled={action.busy} onClick={()=>void action.run(()=>runAi(journal))}>{action.busy?'Checking…':'Check reply'}</button></div>:<form className="composer" onSubmit={event=>{event.preventDefault();void action.run(send);}}><label className="sr-only" htmlFor="message-input">Message Centre</label><textarea id="message-input" rows={3} maxLength={8000} value={text} disabled={!loaded||action.busy} onChange={event=>{const value=event.target.value;setText(value);setDraftError(null);void model.serial(()=>model.store.saveLocal(`compose:${chatId}`,value)).catch(()=>setDraftError('This draft could not be saved. Keep this page open.'));}} placeholder={loaded?'Message Centre':'Opening your saved draft…'}/><button className="icon-button primary" aria-label="Send message" disabled={!loaded||action.busy||!text.trim()||!consent}><Send size={19}/></button></form>}
    <ErrorLine error={draftError??action.error}/>
  </>;
}

function QuestionAnswers({messages}:{messages:{id:string;content:string}[]}) {
  return <details className="clarification-reasoning"><summary>Reasoning</summary>{messages.map(message=><p key={message.id} style={{whiteSpace:'pre-wrap'}}>{message.content}</p>)}</details>;
}
