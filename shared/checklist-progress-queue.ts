export type ChecklistProgressScope = {resourceId:string;documentRevision:string};
export type ChecklistSaveStatus = 'idle'|'saving'|'saved'|'error';
export type ChecklistProgressEvent =
  | {type:'status';status:ChecklistSaveStatus}
  | {type:'change';itemId:string;checked:boolean};
type Listener = (event:ChecklistProgressEvent) => void;
type Queue = {scope:ChecklistProgressScope;pending:Map<string,boolean>;status:ChecklistSaveStatus;work:Promise<void>|null;listeners:Set<Listener>};

/** Queued user edits outlive a rendered frame, including navigation during a save. */
export class ChecklistProgressQueue {
  private readonly queues = new Map<string,Queue>();
  private readonly sequences = new Map<string,number>();
  constructor(private readonly persist:(scope:ChecklistProgressScope,itemId:string,checked:boolean) => Promise<unknown>) {}

  private key(scope:ChecklistProgressScope) { return JSON.stringify([scope.resourceId,scope.documentRevision]); }
  private queue(scope:ChecklistProgressScope) {
    const key = this.key(scope);
    let queue = this.queues.get(key);
    if (!queue) {
      queue = {scope,pending:new Map(),status:'idle',work:null,listeners:new Set()};
      this.queues.set(key,queue);
    }
    return queue;
  }
  private status(queue:Queue,status:ChecklistSaveStatus) {
    queue.status = status;
    for (const listener of queue.listeners) listener({type:'status',status});
  }
  private cleanup(queue:Queue) {
    if (!queue.work && !queue.pending.size && !queue.listeners.size) this.queues.delete(this.key(queue.scope));
  }
  private start(queue:Queue) {
    if (queue.work || !queue.pending.size) return;
    this.status(queue,'saving');
    queue.work = Promise.resolve().then(async () => {
      try {
        while (queue.pending.size) {
          const entry = queue.pending.entries().next();
          if (entry.done) break;
          const [itemId,checked] = entry.value;
          await this.persist(queue.scope,itemId,checked);
          if (queue.pending.get(itemId) === checked) queue.pending.delete(itemId);
        }
        this.status(queue,'saved');
      } catch {
        this.status(queue,'error');
      } finally {
        queue.work = null;
        this.cleanup(queue);
      }
    });
  }
  enqueue(scope:ChecklistProgressScope,itemId:string,checked:boolean) {
    const queue = this.queue(scope);
    queue.pending.set(itemId,checked);
    this.sequences.set(scope.resourceId,(this.sequences.get(scope.resourceId) ?? 0) + 1);
    for (const listener of queue.listeners) listener({type:'change',itemId,checked});
    this.start(queue);
  }
  retry(scope:ChecklistProgressScope) { this.start(this.queue(scope)); }
  pending(scope:ChecklistProgressScope):ReadonlyMap<string,boolean> { return new Map(this.queues.get(this.key(scope))?.pending); }
  subscribe(scope:ChecklistProgressScope,listener:Listener) {
    const queue = this.queue(scope);
    queue.listeners.add(listener);
    listener({type:'status',status:queue.status});
    return () => { queue.listeners.delete(listener);this.cleanup(queue); };
  }
  async read<T>(resourceId:string,load:() => Promise<T>):Promise<T> {
    for (;;) {
      const pending = [...this.queues.values()].filter(queue => queue.scope.resourceId === resourceId && queue.work).map(queue => queue.work);
      if (pending.length) { await Promise.all(pending);continue; }
      const sequence = this.sequences.get(resourceId) ?? 0;
      const result = await load();
      if ((this.sequences.get(resourceId) ?? 0) === sequence) return result;
    }
  }
}
