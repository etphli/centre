import { type ReactNode, useState } from 'react';
import { ChevronLeft, LoaderCircle } from 'lucide-react';
import { z } from 'zod';
import { MobileRequestError } from './data/store';
export function friendlyError(error:unknown):string {
  if (error instanceof MobileRequestError) {
    if (error.status===401) return 'Your connection expired. Reconnect with a new account code. Your saved work stays on this device.';
    if (error.status===429) return 'Centre Cloud has reached its current limit. Your work is saved here. Try again later.';
    if (error.status>=500) return 'Centre Cloud is unavailable right now. Your work is saved here. Try again later.';
  }
  if(error instanceof TypeError)return 'Centre Cloud could not be reached. Your saved work stays on this device.';
  if(error instanceof z.ZodError)return error.issues[0]?.message??'Check the entered details and try again.';
  if(error instanceof DOMException&&error.name==='QuotaExceededError')return 'Browser storage is full. Keep this page open and free some space before trying to save again.';
  return error instanceof Error ? error.message : 'This could not be completed. Please try again.';
}
export function useAction() {
  const [busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  const run=async<T,>(work:()=>Promise<T>):Promise<T|undefined>=>{
    if(busy)return;setBusy(true);setError(null);
    try{return await work();}catch(failure){setError(friendlyError(failure));}finally{setBusy(false);}
  };
  return {busy,error,setError,run};
}
export function ErrorLine({error}:{error:string|null}) {return error?<p className="error" role="alert">{error}</p>:null;}
export function Empty({title,children}:{title:string;children:ReactNode}) {return <div className="empty"><h2>{title}</h2><p>{children}</p></div>;}
export function Back({onClick,children='Back'}:{onClick:()=>void;children?:ReactNode}) {return <button className="text-button back" onClick={onClick}><ChevronLeft size={18}/>{children}</button>;}
export function Busy({label='Working'}:{label?:string}) {return <span className="busy"><LoaderCircle size={16} aria-hidden/>{label}</span>;}
