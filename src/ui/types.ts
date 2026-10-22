import type { PageContext, ResourceKind, Snapshot } from '../../shared/schema';

export type Route =
  | { kind: 'home' }
  | { kind: 'chat'; chatId: string }
  | { kind: 'resources' }
  | { kind: 'subject'; subjectId: string }
  | { kind: 'topic'; subjectId: string; topicId: string }
  | { kind: 'resource'; resourceId: string }
  | { kind: 'calendar' }
  | { kind: 'log' }
  | { kind: 'review' }
  | { kind: 'settings' };

export type Navigate = (route: Route) => void;

export type CreateKind = ResourceKind | 'plan';

export interface GenerateRequest {
  kind: CreateKind;
  subjectId?: string|null;
  topicId?: string|null;
  instructions?: string;
  attachmentIds?: string[];
}

export type ToastTone = 'info' | 'success' | 'error';

export interface ToastInput {
  tone: ToastTone;
  message: string;
  action?: { label: string; run: () => void };
}

export function routeContext(route: Route, state: Snapshot | null): PageContext {
  switch (route.kind) {
    case 'subject':
      return { page: 'subject', subjectId: route.subjectId };
    case 'topic':
      return { page: 'topic', subjectId: route.subjectId, topicId: route.topicId };
    case 'resource': {
      const resource = state?.resources.find((item) => item.id === route.resourceId);
      return resource
        ? { page: 'resource', subjectId: resource.subjectId ?? undefined, topicId: resource.topicId ?? undefined, resourceId: resource.id }
        : { page: 'resource', resourceId: route.resourceId };
    }
    case 'home':
    case 'chat':
    case 'resources':
    case 'log':
    case 'calendar':
    case 'review':
    case 'settings':
      return { page: route.kind };
    default: {
      const exhaustive: never = route;
      return exhaustive;
    }
  }
}

export function sameRoute(a: Route, b: Route): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
