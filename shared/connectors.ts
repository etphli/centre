import { z } from 'zod';

export const googleConnectorIdSchema = z.enum(['google-drive', 'google-docs', 'google-sheets', 'google-slides', 'google-calendar', 'google-contacts', 'google-tasks', 'google-classroom', 'google-forms', 'google-meet', 'google-chat', 'google-youtube', 'google-analytics', 'google-search-console']);
export const connectorIdSchema = z.enum([...googleConnectorIdSchema.options, 'notion']);
export type GoogleConnectorId = z.infer<typeof googleConnectorIdSchema>;
export type ConnectorId = z.infer<typeof connectorIdSchema>;
const scope = (name: string) => `https://www.googleapis.com/auth/${name}`;
export const googleConnectors = [
  { id: 'google-drive', name: 'Google Drive', description: 'Find files and read their metadata.', scopes: [scope('drive.readonly')], color: '#34a853' },
  { id: 'google-docs', name: 'Google Docs', description: 'Find documents and read your notes.', scopes: [scope('drive.metadata.readonly'), scope('documents.readonly')], color: '#4285f4' },
  { id: 'google-sheets', name: 'Google Sheets', description: 'Find spreadsheets and read cell values.', scopes: [scope('drive.metadata.readonly'), scope('spreadsheets.readonly')], color: '#34a853' },
  { id: 'google-slides', name: 'Google Slides', description: 'Find presentations and read slides.', scopes: [scope('drive.metadata.readonly'), scope('presentations.readonly')], color: '#fbbc04' },
  { id: 'google-calendar', name: 'Google Calendar', description: 'Read calendars, events and upcoming dates.', scopes: [scope('calendar.readonly')], color: '#4285f4' },
  { id: 'google-contacts', name: 'Google Contacts', description: 'Find people in your saved contacts.', scopes: [scope('contacts.readonly')], color: '#4285f4' },
  { id: 'google-tasks', name: 'Google Tasks', description: 'Read task lists and their to-dos.', scopes: [scope('tasks.readonly')], color: '#4285f4' },
  { id: 'google-classroom', name: 'Google Classroom', description: 'Read classes, coursework and materials.', scopes: [scope('classroom.courses.readonly'), scope('classroom.coursework.me.readonly'), scope('classroom.courseworkmaterials.readonly')], color: '#34a853' },
  { id: 'google-forms', name: 'Google Forms', description: 'Find forms and read their questions.', scopes: [scope('drive.metadata.readonly'), scope('forms.body.readonly')], color: '#a142f4' },
  { id: 'google-meet', name: 'Google Meet', description: 'Read conference records and meeting details.', scopes: [scope('meetings.space.readonly')], color: '#34a853' },
  { id: 'google-chat', name: 'Google Chat', description: 'Read spaces and their messages.', scopes: [scope('chat.spaces.readonly'), scope('chat.messages.readonly')], color: '#34a853' },
  { id: 'google-youtube', name: 'YouTube', description: 'Find videos and read your subscriptions.', scopes: [scope('youtube.readonly')], color: '#ea4335' },
  { id: 'google-analytics', name: 'Google Analytics', description: 'Find properties and read traffic reports.', scopes: [scope('analytics.readonly')], color: '#e37400' },
  { id: 'google-search-console', name: 'Google Search Console', description: 'Read sites and search performance.', scopes: [scope('webmasters.readonly')], color: '#4285f4' },
] satisfies Array<{ id: GoogleConnectorId; name: string; description: string; scopes: string[]; color: string }>;
export const connectorCatalog = [...googleConnectors, { id: 'notion', name: 'Notion', description: 'Search shared pages and read their content.', color: '#a8a7a1' }] satisfies Array<{ id: ConnectorId; name: string; description: string; color: string }>;
export const connectorStatusSchema = z.object({ id: connectorIdSchema, connected: z.boolean(), canEdit: z.boolean().default(false), account: z.string().nullable(), connectedAt: z.string().nullable() });
export const connectorsResponseSchema = z.object({ connectors: z.array(connectorStatusSchema), googleConfigured: z.boolean() });
export const connectorReadSchema = z.object({ connector: connectorIdSchema, action: z.enum(['list', 'read']), query: z.string().max(300).default(''), resourceId: z.string().min(1).max(300).optional(), cursor: z.string().max(2000).optional() }).strict();
export type ConnectorRead = z.infer<typeof connectorReadSchema>;

export function googleScopes(id: GoogleConnectorId, editable = false) {
  const scopes = googleConnectors.find(item => item.id === id)?.scopes ?? [];
  return scopes.map(scope => editable && ['google-docs', 'google-sheets', 'google-slides'].includes(id) && !scope.includes('drive.metadata') ? scope.replace(/\.readonly$/, '') : scope);
}
