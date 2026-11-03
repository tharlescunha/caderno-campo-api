import { z, type ZodType } from 'zod';
import * as agenda from '../http/agenda.js';
import * as audios from '../http/audios.js';
import * as auth from '../http/auth.js';
import * as entries from '../http/entries.js';
import * as devices from '../http/devices.js';
import * as events from '../http/events.js';
import * as exportsRoutes from '../http/exports.js';
import * as market from '../http/market.js';
import * as notes from '../http/notes.js';
import * as notifications from '../http/notifications.js';
import * as periods from '../http/periods.js';
import * as photos from '../http/photos.js';
import * as reports from '../http/reports.js';
import * as search from '../http/search.js';
import * as subjects from '../http/subjects.js';
import * as sync from '../http/sync.js';
import * as teachers from '../http/teachers.js';
import * as today from '../http/today.js';
import * as users from '../http/users.js';
import { sendSchema } from '../sync/send.js';
import * as E from './entities.js';

/** A response: a Zod schema, or text for answers that are files or are described in docs/api.md. */
export type ResponseSpec = ZodType | string;

export interface Endpoint {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** with `:id` for path parameters, without the `/api/v1` prefix */
  path: string;
  tag: string;
  summary: string;
  /** false for the few public routes */
  auth?: boolean;
  /** JSON body */
  body?: ZodType;
  /** multipart/form-data: the text fields (the file goes in the `file` field) */
  multipart?: ZodType | true;
  query?: ZodType;
  responses: Record<number, ResponseSpec>;
}

const object = 'JSON object, described in docs/api.md';
const file = 'The file (download)';
const none = 'No content';
const Page = E.page;
const z_items = <T extends ZodType>(item: T) => z.object({ items: z.array(item) }).strict();
const z_int = () => z.number().int();

/** The one list of routes, with what each one receives and answers. A test keeps it equal to the routes that exist. */
export const endpoints: Endpoint[] = [
  // ---- health, OpenAPI and access
  {
    method: 'GET',
    path: '/openapi.json',
    tag: 'Health',
    summary: 'This document (public): the phone and the site generate their types from it',
    auth: false,
    responses: { 200: 'JSON OpenAPI 3.1 document' },
  },
  { method: 'GET', path: '/health', tag: 'Health', summary: 'Server is up (public)', auth: false, responses: { 200: E.Health } },
  {
    method: 'POST',
    path: '/auth/register',
    tag: 'Access',
    summary: 'Create the account (closed after the first user unless ALLOW_SIGNUP)',
    auth: false,
    body: auth.registerBody,
    responses: { 201: E.AuthResult, 403: E.ErrorBody, 409: E.ErrorBody, 422: E.ErrorBody },
  },
  {
    method: 'POST',
    path: '/auth/login',
    tag: 'Access',
    summary: 'Sign in (10 wrong attempts in 15 minutes block)',
    auth: false,
    body: auth.loginBody,
    responses: { 200: E.AuthResult, 401: E.ErrorBody, 429: E.ErrorBody },
  },
  {
    method: 'POST',
    path: '/auth/refresh',
    tag: 'Access',
    summary: 'New token pair (the old refresh token stops working)',
    auth: false,
    body: auth.refreshBody,
    responses: { 200: E.TokenPair, 401: E.ErrorBody },
  },
  {
    method: 'POST',
    path: '/auth/logout',
    tag: 'Access',
    summary: 'Revoke the refresh token',
    auth: false,
    body: auth.refreshBody,
    responses: { 204: none },
  },

  // ---- account
  { method: 'GET', path: '/users/me', tag: 'Account', summary: 'The signed-in user', responses: { 200: E.User } },
  {
    method: 'PATCH',
    path: '/users/me',
    tag: 'Account',
    summary: 'Change profile and preferences',
    body: users.patchBody,
    responses: { 200: E.User, 422: E.ErrorBody },
  },
  {
    method: 'PATCH',
    path: '/users/me/password',
    tag: 'Account',
    summary: 'Change the password (revokes the other sessions)',
    body: users.passwordBody,
    responses: { 204: none, 422: E.ErrorBody },
  },
  {
    method: 'DELETE',
    path: '/users/me/sessions',
    tag: 'Account',
    summary: 'Sign out of every device (revokes all refresh tokens)',
    responses: { 204: none },
  },
  {
    method: 'GET',
    path: '/users/me/export',
    tag: 'Account',
    summary: 'All the data of the account as JSON (download)',
    responses: { 200: 'JSON file with the rows of every table of the account' },
  },
  {
    method: 'DELETE',
    path: '/users/me',
    tag: 'Account',
    summary: 'Delete the account, its data and its files (asks for the password)',
    body: exportsRoutes.deleteBody,
    responses: { 204: none, 422: E.ErrorBody },
  },

  {
    method: 'POST',
    path: '/devices',
    tag: 'Account',
    summary: 'Register the phone for push (the same token again refreshes it)',
    body: devices.createBody,
    responses: { 200: E.Device, 201: E.Device, 422: E.ErrorBody },
  },
  {
    method: 'DELETE',
    path: '/devices/:id',
    tag: 'Account',
    summary: 'Remove a registered device',
    responses: { 204: none, 404: E.ErrorBody },
  },

  // ---- today, agenda, events
  {
    method: 'GET',
    path: '/today',
    tag: 'Today',
    summary: 'Everything the Today screen needs, in one call',
    query: today.query,
    responses: { 200: object },
  },
  {
    method: 'GET',
    path: '/agenda',
    tag: 'Agenda',
    summary: 'Days of a range (at most 42) with the weekly subjects and the events',
    query: agenda.query,
    responses: { 200: object, 422: E.ErrorBody },
  },
  { method: 'GET', path: '/events', tag: 'Events', summary: 'List events', query: events.listQuery, responses: { 200: Page(E.Event) } },
  {
    method: 'POST',
    path: '/events',
    tag: 'Events',
    summary: 'Create an event',
    body: events.createBody,
    responses: { 201: E.Event, 409: E.ErrorBody, 422: E.ErrorBody },
  },
  {
    method: 'GET',
    path: '/events/:id',
    tag: 'Events',
    summary: 'One event, with its photos',
    responses: { 200: E.EventDetail, 404: E.ErrorBody },
  },
  {
    method: 'PATCH',
    path: '/events/:id',
    tag: 'Events',
    summary: 'Change an event',
    body: events.patchBody,
    responses: { 200: E.Event, 404: E.ErrorBody, 409: E.ErrorBody, 422: E.ErrorBody },
  },
  {
    method: 'DELETE',
    path: '/events/:id',
    tag: 'Events',
    summary: 'Delete an event',
    responses: { 204: none, 404: E.ErrorBody, 409: E.ErrorBody },
  },
  {
    method: 'POST',
    path: '/events/:id/photos',
    tag: 'Photos',
    summary: 'Add photos to an event (up to 20)',
    multipart: photos.fieldsSchema,
    responses: { 201: E.PhotoItems, 413: E.ErrorBody, 422: E.ErrorBody },
  },

  // ---- periods
  { method: 'GET', path: '/periods', tag: 'Periods', summary: 'List periods, newest first', responses: { 200: Page(E.Period) } },
  { method: 'GET', path: '/periods/active', tag: 'Periods', summary: 'The active period', responses: { 200: E.Period, 404: E.ErrorBody } },
  {
    method: 'POST',
    path: '/periods',
    tag: 'Periods',
    summary: 'Create and activate a period; closes the current one when confirmed',
    body: periods.createBody,
    responses: { 201: E.Period, 409: E.ErrorBody, 422: E.ErrorBody },
  },
  {
    method: 'GET',
    path: '/periods/:id',
    tag: 'Periods',
    summary: 'One period with its subjects',
    responses: { 200: E.PeriodDetail, 404: E.ErrorBody },
  },
  {
    method: 'PATCH',
    path: '/periods/:id',
    tag: 'Periods',
    summary: 'Change name and dates (active period only)',
    body: periods.patchBody,
    responses: { 200: E.Period, 404: E.ErrorBody, 409: E.ErrorBody, 422: E.ErrorBody },
  },
  {
    method: 'DELETE',
    path: '/periods/:id',
    tag: 'Periods',
    summary: 'Delete a period without subjects',
    responses: { 204: none, 404: E.ErrorBody, 409: E.ErrorBody },
  },
  {
    method: 'GET',
    path: '/periods/:id/closing-preview',
    tag: 'Periods',
    summary: 'What closing the period would do',
    responses: { 200: E.ClosingPreview, 404: E.ErrorBody },
  },
  {
    method: 'POST',
    path: '/periods/:id/close',
    tag: 'Periods',
    summary: 'Close the period without creating another',
    responses: { 200: E.Period, 404: E.ErrorBody, 409: E.ErrorBody },
  },
  {
    method: 'GET',
    path: '/periods/:id/summary',
    tag: 'Periods',
    summary: 'Summary of the period (json, text or csv)',
    query: exportsRoutes.summaryQuery,
    responses: { 200: object, 404: E.ErrorBody },
  },

  // ---- teachers and subjects
  { method: 'GET', path: '/teachers', tag: 'Teachers', summary: 'List teachers', responses: { 200: Page(E.Teacher) } },
  {
    method: 'POST',
    path: '/teachers',
    tag: 'Teachers',
    summary: 'Create a teacher',
    body: teachers.createBody,
    responses: { 201: E.Teacher, 422: E.ErrorBody },
  },
  { method: 'GET', path: '/teachers/:id', tag: 'Teachers', summary: 'One teacher', responses: { 200: E.Teacher, 404: E.ErrorBody } },
  {
    method: 'PATCH',
    path: '/teachers/:id',
    tag: 'Teachers',
    summary: 'Change a teacher',
    body: teachers.patchBody,
    responses: { 200: E.Teacher, 404: E.ErrorBody, 422: E.ErrorBody },
  },
  {
    method: 'DELETE',
    path: '/teachers/:id',
    tag: 'Teachers',
    summary: 'Delete a teacher that is in no subject',
    responses: { 204: none, 404: E.ErrorBody, 409: E.ErrorBody },
  },
  {
    method: 'GET',
    path: '/subjects',
    tag: 'Subjects',
    summary: 'List subjects (active period by default)',
    query: subjects.listQuery,
    responses: { 200: Page(E.Subject) },
  },
  {
    method: 'GET',
    path: '/subjects/weekly-board',
    tag: 'Subjects',
    summary: 'Weekly board of the active period',
    responses: { 200: E.WeeklyBoard },
  },
  {
    method: 'POST',
    path: '/subjects',
    tag: 'Subjects',
    summary: 'Create a subject',
    body: subjects.createBody,
    responses: { 201: E.Subject, 409: E.ErrorBody, 422: E.ErrorBody },
  },
  {
    method: 'GET',
    path: '/subjects/:id',
    tag: 'Subjects',
    summary: 'One subject with upcoming events, reports and notes',
    responses: { 200: E.SubjectDetail, 404: E.ErrorBody },
  },
  {
    method: 'PATCH',
    path: '/subjects/:id',
    tag: 'Subjects',
    summary: 'Change a subject',
    body: subjects.patchBody,
    responses: { 200: E.Subject, 404: E.ErrorBody, 409: E.ErrorBody, 422: E.ErrorBody },
  },
  {
    method: 'POST',
    path: '/subjects/:id/deactivate',
    tag: 'Subjects',
    summary: 'Hide the subject (data stays)',
    responses: { 200: E.Subject, 404: E.ErrorBody, 409: E.ErrorBody },
  },
  {
    method: 'POST',
    path: '/subjects/:id/reactivate',
    tag: 'Subjects',
    summary: 'Show the subject again',
    responses: { 200: E.Subject, 404: E.ErrorBody, 409: E.ErrorBody },
  },
  {
    method: 'POST',
    path: '/subjects/:id/copy',
    tag: 'Subjects',
    summary: 'Copy the subject to another active period',
    body: subjects.copyBody,
    responses: { 201: E.Subject, 404: E.ErrorBody, 409: E.ErrorBody },
  },
  {
    method: 'DELETE',
    path: '/subjects/:id',
    tag: 'Subjects',
    summary: 'Delete a subject with no linked data',
    responses: { 204: none, 404: E.ErrorBody, 409: E.ErrorBody },
  },

  // ---- reports and entries
  {
    method: 'GET',
    path: '/reports',
    tag: 'Reports',
    summary: 'List reports',
    query: reports.listQuery,
    responses: { 200: Page(E.Report) },
  },
  {
    method: 'POST',
    path: '/reports',
    tag: 'Reports',
    summary: 'Create a report (a delivery date creates its event)',
    body: reports.createBody,
    responses: { 201: E.ReportDetail, 409: E.ErrorBody, 422: E.ErrorBody },
  },
  {
    method: 'GET',
    path: '/reports/:id',
    tag: 'Reports',
    summary: 'One report with current situation and open to-do items',
    responses: { 200: E.ReportDetail, 404: E.ErrorBody },
  },
  {
    method: 'PATCH',
    path: '/reports/:id',
    tag: 'Reports',
    summary: 'Change a report',
    body: reports.patchBody,
    responses: { 200: E.ReportDetail, 404: E.ErrorBody, 409: E.ErrorBody, 422: E.ErrorBody },
  },
  {
    method: 'DELETE',
    path: '/reports/:id',
    tag: 'Reports',
    summary: 'Delete a report with its entries, items, files and delivery event',
    responses: { 204: none, 404: E.ErrorBody, 409: E.ErrorBody },
  },
  {
    method: 'POST',
    path: '/reports/:id/finish',
    tag: 'Reports',
    summary: 'Finish a report',
    responses: { 200: object, 404: E.ErrorBody, 409: E.ErrorBody },
  },
  {
    method: 'POST',
    path: '/reports/:id/reopen',
    tag: 'Reports',
    summary: 'Reopen a finished report',
    responses: { 200: E.ReportDetail, 404: E.ErrorBody, 409: E.ErrorBody },
  },
  {
    method: 'GET',
    path: '/reports/:id/export',
    tag: 'Export',
    summary: 'Data of the report as text, CSV or zip (download)',
    query: exportsRoutes.exportQuery,
    responses: { 200: file, 404: E.ErrorBody },
  },
  {
    method: 'POST',
    path: '/reports/:id/area-photo',
    tag: 'Photos',
    summary: 'Photo of the area (replaces the old one)',
    multipart: photos.fieldsSchema,
    responses: { 201: E.Photo, 413: E.ErrorBody, 422: E.ErrorBody },
  },
  {
    method: 'GET',
    path: '/reports/:id/entries',
    tag: 'Entries',
    summary: 'Timeline of the report, newest first',
    responses: { 200: Page(E.Entry), 404: E.ErrorBody },
  },
  {
    method: 'POST',
    path: '/reports/:id/entries',
    tag: 'Entries',
    summary: 'Add an entry (a visit)',
    body: entries.createBody,
    responses: { 201: E.Entry, 404: E.ErrorBody, 409: E.ErrorBody, 422: E.ErrorBody },
  },
  {
    method: 'GET',
    path: '/reports/:id/todos',
    tag: 'Entries',
    summary: 'Open "for the next visit" items, oldest first',
    responses: { 200: z_items(E.Todo), 404: E.ErrorBody },
  },
  { method: 'GET', path: '/entries/:id', tag: 'Entries', summary: 'One entry', responses: { 200: E.Entry, 404: E.ErrorBody } },
  {
    method: 'PATCH',
    path: '/entries/:id',
    tag: 'Entries',
    summary: 'Change an entry (weather and coordinates never change)',
    body: entries.patchBody,
    responses: { 200: E.Entry, 404: E.ErrorBody, 409: E.ErrorBody, 422: E.ErrorBody },
  },
  {
    method: 'DELETE',
    path: '/entries/:id',
    tag: 'Entries',
    summary: 'Delete an entry',
    responses: { 204: none, 404: E.ErrorBody, 409: E.ErrorBody },
  },
  {
    method: 'GET',
    path: '/todos/:id',
    tag: 'Entries',
    summary: 'One "for the next visit" item',
    responses: { 200: E.Todo, 404: E.ErrorBody },
  },
  {
    method: 'PATCH',
    path: '/todos/:id',
    tag: 'Entries',
    summary: 'Mark done or change the text',
    body: entries.todoPatch,
    responses: { 200: E.Todo, 404: E.ErrorBody, 409: E.ErrorBody },
  },
  {
    method: 'DELETE',
    path: '/todos/:id',
    tag: 'Entries',
    summary: 'Delete an item',
    responses: { 204: none, 404: E.ErrorBody, 409: E.ErrorBody },
  },

  // ---- photos and audios
  {
    method: 'POST',
    path: '/entries/:id/photos',
    tag: 'Photos',
    summary: 'Add photos to an entry (up to 20)',
    multipart: photos.fieldsSchema,
    responses: { 201: E.PhotoItems, 413: E.ErrorBody, 422: E.ErrorBody },
  },
  { method: 'GET', path: '/photos/:id', tag: 'Photos', summary: 'The original file', responses: { 200: file, 404: E.ErrorBody } },
  {
    method: 'GET',
    path: '/photos/:id/thumbnail',
    tag: 'Photos',
    summary: 'Thumbnail (JPEG, up to 400 px)',
    responses: { 200: file, 404: E.ErrorBody },
  },
  { method: 'GET', path: '/photos/:id/info', tag: 'Photos', summary: 'Data of the photo', responses: { 200: E.Photo, 404: E.ErrorBody } },
  {
    method: 'PATCH',
    path: '/photos/:id',
    tag: 'Photos',
    summary: 'Change the caption',
    body: photos.patchBody,
    responses: { 200: E.Photo, 404: E.ErrorBody, 409: E.ErrorBody },
  },
  {
    method: 'DELETE',
    path: '/photos/:id',
    tag: 'Photos',
    summary: 'Delete a photo and its files',
    responses: { 204: none, 404: E.ErrorBody, 409: E.ErrorBody },
  },
  {
    method: 'POST',
    path: '/entries/:id/audios',
    tag: 'Audios',
    summary: 'Upload an audio; it is transcribed later',
    multipart: audios.fieldsSchema,
    responses: { 201: E.Audio, 413: E.ErrorBody, 422: E.ErrorBody },
  },
  {
    method: 'POST',
    path: '/notes/:id/audios',
    tag: 'Audios',
    summary: 'Upload an audio of a note',
    multipart: audios.fieldsSchema,
    responses: { 201: E.Audio, 413: E.ErrorBody, 422: E.ErrorBody },
  },
  {
    method: 'GET',
    path: '/audios/:id',
    tag: 'Audios',
    summary: 'An audio and its transcription',
    responses: { 200: E.Audio, 404: E.ErrorBody },
  },
  { method: 'GET', path: '/audios/:id/file', tag: 'Audios', summary: 'The audio file', responses: { 200: file, 404: E.ErrorBody } },
  {
    method: 'PATCH',
    path: '/audios/:id',
    tag: 'Audios',
    summary: 'Save the text the user fixed',
    body: audios.patchBody,
    responses: { 200: E.Audio, 404: E.ErrorBody, 409: E.ErrorBody },
  },
  {
    method: 'POST',
    path: '/audios/:id/retranscribe',
    tag: 'Audios',
    summary: 'Transcribe again',
    responses: { 202: E.Audio, 404: E.ErrorBody, 409: E.ErrorBody },
  },
  {
    method: 'DELETE',
    path: '/audios/:id',
    tag: 'Audios',
    summary: 'Delete an audio',
    responses: { 204: none, 404: E.ErrorBody, 409: E.ErrorBody },
  },

  // ---- notes
  {
    method: 'GET',
    path: '/notes',
    tag: 'Notes',
    summary: 'List notes (pinned first)',
    query: notes.listQuery,
    responses: { 200: Page(E.NoteItem) },
  },
  {
    method: 'POST',
    path: '/notes',
    tag: 'Notes',
    summary: 'Create a note',
    body: notes.createBody,
    responses: { 201: E.Note, 409: E.ErrorBody, 422: E.ErrorBody },
  },
  { method: 'GET', path: '/notes/:id', tag: 'Notes', summary: 'One note', responses: { 200: E.Note, 404: E.ErrorBody } },
  {
    method: 'PATCH',
    path: '/notes/:id',
    tag: 'Notes',
    summary: 'Change a note',
    body: notes.patchBody,
    responses: { 200: E.Note, 404: E.ErrorBody, 409: E.ErrorBody, 422: E.ErrorBody },
  },
  {
    method: 'DELETE',
    path: '/notes/:id',
    tag: 'Notes',
    summary: 'Delete a note with its files',
    responses: { 204: none, 404: E.ErrorBody },
  },
  {
    method: 'POST',
    path: '/notes/:id/attachments',
    tag: 'Notes',
    summary: 'Attach photos or PDF files (up to 20)',
    multipart: true,
    responses: { 201: z_items(E.Attachment), 413: E.ErrorBody, 422: E.ErrorBody },
  },
  { method: 'GET', path: '/attachments/:id', tag: 'Notes', summary: 'The attachment file', responses: { 200: file, 404: E.ErrorBody } },
  {
    method: 'GET',
    path: '/attachments/:id/thumbnail',
    tag: 'Notes',
    summary: 'Thumbnail of a photo attachment',
    responses: { 200: file, 404: E.ErrorBody },
  },
  { method: 'DELETE', path: '/attachments/:id', tag: 'Notes', summary: 'Delete an attachment', responses: { 204: none, 404: E.ErrorBody } },

  // ---- search and notifications
  {
    method: 'GET',
    path: '/search',
    tag: 'Search',
    summary: 'Search notes, reports, entries, subjects and events',
    query: search.query,
    responses: { 200: object, 422: E.ErrorBody },
  },
  {
    method: 'GET',
    path: '/notifications',
    tag: 'Notifications',
    summary: 'Inbox (delivered reminders), newest first',
    query: notifications.listQuery,
    responses: { 200: Page(E.Notification).extend({ unread_count: z_int() }) },
  },
  {
    method: 'PATCH',
    path: '/notifications/:id/read',
    tag: 'Notifications',
    summary: 'Mark as read',
    responses: { 200: E.Notification, 404: E.ErrorBody },
  },
  { method: 'POST', path: '/notifications/read-all', tag: 'Notifications', summary: 'Mark all as read', responses: { 200: object } },

  // ---- market
  {
    method: 'GET',
    path: '/market/summary',
    tag: 'Market',
    summary: 'Quotes, dollar, weather and news in one call',
    query: market.summaryQuery,
    responses: { 200: object },
  },
  {
    method: 'GET',
    path: '/market/history',
    tag: 'Market',
    summary: 'Quote history kept by the server',
    query: market.historyQuery,
    responses: { 200: object },
  },
  {
    method: 'GET',
    path: '/market/news',
    tag: 'Market',
    summary: 'News list',
    query: market.newsQuery,
    responses: { 200: object, 502: E.ErrorBody },
  },
  {
    method: 'GET',
    path: '/market/news/:id',
    tag: 'Market',
    summary: 'A full news article',
    responses: { 200: object, 404: E.ErrorBody, 502: E.ErrorBody },
  },
  {
    method: 'GET',
    path: '/weather',
    tag: 'Market',
    summary: 'Weather of a place',
    query: market.weatherQuery,
    responses: { 200: object, 502: E.ErrorBody },
  },

  // ---- sync
  {
    method: 'POST',
    path: '/sync/send',
    tag: 'Sync',
    summary: 'Send a batch (up to 50) of operations made offline',
    body: sendSchema,
    responses: { 200: object, 401: E.ErrorBody, 422: E.ErrorBody },
  },
  {
    method: 'GET',
    path: '/sync/changes',
    tag: 'Sync',
    summary: 'What changed on the server since the cursor',
    query: sync.changesQuery,
    responses: { 200: object },
  },
  {
    method: 'POST',
    path: '/sync/media',
    tag: 'Sync',
    summary: 'Send one photo, attachment or audio',
    multipart: sync.mediaFields,
    responses: { 200: object, 201: object, 413: E.ErrorBody, 422: E.ErrorBody },
  },
  {
    method: 'GET',
    path: '/sync/state',
    tag: 'Sync',
    summary: 'Current cursor, server time, minimum app version',
    responses: { 200: object },
  },
];
