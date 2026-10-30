import assert from 'node:assert/strict';
import test from 'node:test';
import { assignmentSchema } from '../shared/schema';
import { library, notificationResourceForAssignment, notificationResourceSchema } from './domain';
import { assignmentNotificationContext } from './notifications';
import { parseCloudEntity } from '../shared/cloud-entities';

test('notification resources retain their metadata and link to a mentioned assignment', () => {
  const resource = notificationResourceSchema.parse({
    id: 'mail-note', subjectId: 'math', topicId: null, title: 'Homework brief', kind: 'notes',
    createdAt: '2026-10-31T00:00:00Z', updatedAt: '2026-10-31T00:00:00Z', content: 'Complete questions 1–4.',
    notification: { itemId: 'assignment-1', attachmentId: 'attachment-1', fileName: 'brief.pdf', contentType: 'application/pdf', downloadPath: '/items/assignment-1/attachments/attachment-1' },
  });
  assert.equal(resource.notification?.fileName, 'brief.pdf');
  const cached = notificationResourceSchema.parse(parseCloudEntity('resource',resource));
  assert.equal(cached.content, 'Complete questions 1–4.');
  assert.equal(cached.notification?.itemId, 'assignment-1');
  const local = library([{ kind: 'resource', id: resource.id, schemaVersion: 1, version: 1, cursor: '1', updatedAt: resource.updatedAt, deleted: false, data: cached }]);
  assert.equal(notificationResourceForAssignment(local.resources, 'assignment-1')[0]?.content, 'Complete questions 1–4.');
  const context = assignmentNotificationContext({
    resources: [resource], assignments: [assignmentSchema.parse({ id: 'assignment-1', title: 'Algebra worksheet', kind: 'work', subjectId: 'math', dueDate: null, status: 'open', version: 1 })],
  }, 'Can you help me understand Algebra worksheet?');
  assert.equal(context?.id, resource.id);
  assert.equal(context?.untrustedContent, 'Complete questions 1–4.');

});

