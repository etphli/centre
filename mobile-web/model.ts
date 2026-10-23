import { studySessionSchema, type StudySession } from '../shared/study-log';
import { freshDraft, library, newTimer, timerChange } from './domain';
import { quizDraftSchema } from '../shared/practice';
import type { Resource } from '../shared/schema';
import { MobileStore } from './data/store';

export class MobileModel {
  private queue: Promise<unknown> = Promise.resolve();
  private ownedTimer: string | null = null;
  private releaseTimer: (()=>void) | null = null;
  private activityAt = Date.now();
  constructor(readonly store: MobileStore) {}
  serial<T>(work: ()=>Promise<T>): Promise<T> {
    const next = this.queue.then(work);
    this.queue = next.catch(()=>undefined);
    return next;
  }
  activity() { this.activityAt = Date.now(); }
  async startTimer(title: string, subjectId: string | null, timeZone: string, resumeId?: string) {
    if (!navigator.locks) throw new Error('This browser cannot safely own a study timer. You can still log completed study manually.');
    if (this.ownedTimer) throw new Error('Pause or finish your current timer first.');
    const session = this.store.getSnapshot().session;
    if (!session) throw new Error('Reconnect your account before starting a timer.');
    await new Promise<void>((resolve,reject)=>{
      void navigator.locks.request(`centre-study-timer:${session.workspaceId}`,{ifAvailable:true}, async lock=>{
        if (!lock) { reject(new Error('A study timer is open in another Centre tab. Pause it there first.')); return; }
        const held = new Promise<void>(release=>{this.releaseTimer=release;});
        try {
          await this.serial(async()=>{
            const current=library(this.store.getSnapshot().entities).sessions;
            if (current.some(item=>item.state.kind==='running')) throw new Error('Pause the existing timer before starting another.');
            const prior=current.find(item=>item.id===resumeId);
            const timer=prior ? timerChange(prior,'resume',Date.now()) : newTimer(title,subjectId,timeZone,Date.now());
            await this.store.save('studySession',timer.id,timer);
            this.ownedTimer=timer.id;this.activityAt=Date.now();
          });
          resolve();
          await held;
        } catch(error) { this.releaseTimer=null;reject(error); }
      }).catch(reject);
    });
  }
  async timer(action:'heartbeat'|'pause'|'finish'|'confirm',id?:string) {
    return this.serial(async()=>{
      const target=id ?? this.ownedTimer;
      if (!target) return;
      const current=library(this.store.getSnapshot().entities).sessions.find(item=>item.id===target);
      if (!current) {this.release();return;}
      if (action==='heartbeat' && this.ownedTimer!==target) return;
      const next=timerChange(current,action,Date.now(),this.activityAt);
      if (next!==current) await this.store.save('studySession',next.id,next);
      if (next.state.kind!=='running') this.release();
    });
  }
  async background() { if (this.ownedTimer) await this.timer('pause'); }
  private release() {this.ownedTimer=null;this.releaseTimer?.();this.releaseTimer=null;}
  async saveSession(session:StudySession) {await this.serial(()=>this.store.save('studySession',session.id,studySessionSchema.parse(session)));}
  async draft(resource:Resource) {
    return this.serial(async()=>{
      const current=library(this.store.getSnapshot().entities).drafts.find(item=>item.resourceId===resource.id);
      if (current) return current;
      const draft=freshDraft(resource,Date.now());
      await this.store.save('practice.draft',draft.id,draft);
      return draft;
    });
  }
  async answer(resource:Resource,questionId:string,answer:string) {
    return this.serial(async()=>{
      const current=library(this.store.getSnapshot().entities).drafts.find(item=>item.resourceId===resource.id) ?? freshDraft(resource,Date.now());
      const next=quizDraftSchema.parse({...current,revision:current.revision+1,answers:{...current.answers,[questionId]:answer},updatedAt:new Date().toISOString()});
      await this.store.save('practice.draft',next.id,next);
    });
  }
}
