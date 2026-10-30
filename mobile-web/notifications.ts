import { assignmentNotificationContext as sharedContext } from '../shared/notification-context';
import type { Snapshot } from '../shared/schema';
export function assignmentNotificationContext(state:Pick<Snapshot,'resources'|'assignments'> & Partial<Pick<Snapshot,'subjects'>>,text:string,subjectId?:string,resourceId?:string) {
  return sharedContext({...state,subjects:state.subjects ?? []},text,subjectId,resourceId)[0] ?? null;
}
