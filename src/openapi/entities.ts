import { z } from 'zod';

// What the API answers, written as Zod schemas so the OpenAPI document (and the types of the phone and the
// site) come from here. Tests parse real answers with them in strict mode: if a route changes its answer
// and this file is not updated, the test fails.

const iso = z.string().describe('ISO 8601, UTC');
const date = z.string().describe('YYYY-MM-DD');
const id = z.uuid();
const nullableText = z.string().nullable();

export const ErrorBody = z
  .object({
    error: z.object({
      code: z.string().describe('stable code, e.g. validation, not_found, period_finished'),
      message: z.string(),
      fields: z.array(z.object({ field: z.string(), message: z.string() })).optional(),
      details: z.unknown().optional().describe('extra data, e.g. the closing preview of a period'),
    }),
  })
  .strict();

export const page = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), page: z.number().int(), limit: z.number().int(), total: z.number().int() }).strict();

export const User = z
  .object({
    id,
    name: z.string(),
    email: z.string(),
    course: nullableText,
    institution: nullableText,
    timezone: z.string(),
    theme: z.enum(['light', 'dark', 'system']),
    quotes_city: z.string(),
    default_location: z.object({ latitude: z.number(), longitude: z.number() }).nullable(),
    notify_exams_and_deadlines: z.boolean(),
    notify_field_class_eve: z.boolean(),
    notify_report_deadline: z.boolean(),
    remind_record_after_field: z.boolean(),
    remind_record_time: z.string(),
    delete_audio_after_transcription: z.boolean(),
    send_photos_on_wifi_only: z.boolean(),
    first_access_completed_at: iso.nullable(),
    created_at: iso,
    updated_at: iso,
    version: z.number().int(),
  })
  .strict();

export const TokenPair = z
  .object({ access_token: z.string(), expires_in: z.number().int().describe('seconds'), refresh_token: z.string() })
  .strict();
export const AuthResult = TokenPair.extend({ user: User }).strict();

export const Period = z
  .object({
    id,
    name: z.string(),
    start_date: date,
    end_date: date.nullable(),
    status: z.enum(['active', 'finished']),
    finished_at: iso.nullable(),
    created_at: iso,
    updated_at: iso,
    version: z.number().int(),
    totals: z.object({ subjects: z.number().int(), reports: z.number().int(), notes: z.number().int() }).strict(),
  })
  .strict();
export const PeriodDetail = Period.extend({
  subjects: z.array(z.object({ id, name: z.string(), deactivated: z.boolean() }).strict()),
}).strict();

export const ClosingPreview = z
  .object({
    period: z.object({ id, name: z.string() }).strict(),
    will_close: z.object({ subjects: z.number().int(), reports_in_progress: z.number().int(), future_events: z.number().int() }).strict(),
    will_keep: z
      .object({ reports: z.number().int(), entries: z.number().int(), photos: z.number().int(), notes: z.number().int() })
      .strict(),
    warnings: z.array(z.string()),
  })
  .strict();

export const Teacher = z
  .object({
    id,
    name: z.string(),
    email: nullableText,
    notes: nullableText,
    subjects: z.array(z.object({ id, name: z.string() }).strict()),
    created_at: iso,
    updated_at: iso,
    version: z.number().int(),
  })
  .strict();

const classType = z.enum(['classroom', 'field', 'classroom_and_field']);
const color = z.enum(['blue', 'green', 'earth', 'purple', 'red']);
const eventType = z.enum(['exam', 'assignment', 'report_delivery', 'activity', 'college_event', 'other']);
const reminder = z.enum(['none', 'on_the_day', '1_day', '3_days', '1_week']);
const deliveryFormat = z.enum(['pdf', 'printed', 'slides', 'other']);

export const Subject = z
  .object({
    id,
    period_id: id,
    name: z.string(),
    class_type: classType,
    color,
    weekdays: z.array(z.number().int().min(1).max(7)),
    remind_eve: z.boolean(),
    deactivated: z.boolean(),
    teacher: z.object({ id, name: z.string() }).strict().nullable(),
    totals: z.object({ reports: z.number().int(), notes: z.number().int() }).strict(),
    next_date: z.object({ type: eventType, date, title: z.string() }).strict().nullable(),
    created_at: iso,
    updated_at: iso,
    version: z.number().int(),
  })
  .strict();

export const WeeklyBoard = z
  .object({
    days: z.array(
      z
        .object({
          weekday: z.number().int(),
          subjects: z.array(z.object({ id, name: z.string(), color, class_type: classType, teacher: nullableText }).strict()),
        })
        .strict(),
    ),
  })
  .strict();

export const Event = z
  .object({
    id,
    type: eventType,
    type_description: nullableText,
    title: z.string(),
    subject_id: id.nullable(),
    report_id: id.nullable(),
    date,
    reminder,
    notes: nullableText,
    completed: z.boolean(),
    closed_with_period: z.boolean(),
    created_at: iso,
    updated_at: iso,
    version: z.number().int(),
  })
  .strict();

export const Photo = z
  .object({
    id,
    entry_id: id.nullable(),
    report_id: id.nullable(),
    event_id: id.nullable(),
    caption: nullableText,
    taken_at: iso.nullable(),
    latitude: z.number().nullable(),
    longitude: z.number().nullable(),
    mime_type: z.string(),
    size_bytes: z.number().int(),
    url: z.string(),
    thumbnail_url: z.string().nullable(),
    created_at: iso,
    updated_at: iso,
    version: z.number().int(),
  })
  .strict();

export const EventDetail = Event.extend({ photos: z.array(Photo) }).strict();

export const Audio = z
  .object({
    id,
    entry_id: id.nullable(),
    note_id: id.nullable(),
    duration_s: z.number().int(),
    recorded_at: iso,
    status: z.enum(['transcribing', 'ready', 'error']),
    language: z.string(),
    confidence: z.number().nullable(),
    transcription: nullableText,
    edited_transcription: nullableText,
    attempts: z.number().int(),
    error: nullableText,
    transcribed_at: iso.nullable(),
    mime_type: z.string(),
    size_bytes: z.number().int(),
    url: z.string().nullable(),
    created_at: iso,
    updated_at: iso,
    version: z.number().int(),
  })
  .strict();

export const Todo = z
  .object({
    id,
    entry_id: id,
    text: z.string(),
    order: z.number().int(),
    done: z.boolean(),
    done_in_entry_id: id.nullable(),
    done_at: iso.nullable(),
    version: z.number().int(),
  })
  .strict();

const TextHistory = z.array(z.object({ field: z.string(), text: z.string(), replaced_at: iso.nullable() }).strict());

export const Entry = z
  .object({
    id,
    report_id: id,
    recorded_at: iso,
    status: z.enum(['draft', 'completed']),
    activities: z.array(z.enum(['fertilization', 'cleaning', 'inspection', 'application', 'irrigation', 'planting', 'harvest', 'other'])),
    application: z.object({ product: nullableText, dose: nullableText, target: nullableText }).strict().nullable(),
    irrigation: z.enum(['working', 'faulty', 'none', 'to_install']).nullable(),
    measurements: z.object({ plant_height_cm: z.number().nullable(), measured_area_m2: z.number().nullable() }).strict(),
    crop_condition: z.enum(['excellent', 'good', 'fair', 'poor']).nullable(),
    stage: nullableText,
    pest: z.object({ found: z.boolean(), name: nullableText, level: z.enum(['low', 'medium', 'high']).nullable() }).strict(),
    notes: nullableText,
    latitude: z.number().nullable(),
    longitude: z.number().nullable(),
    weather_origin: z.enum(['gps', 'manual', 'pending', 'gps_late']).nullable(),
    weather: z
      .object({
        description: nullableText,
        temperature_c: z.number().nullable(),
        feels_like_c: z.number().nullable(),
        humidity_pct: z.number().nullable(),
        wind_kmh: z.number().nullable(),
        rain_1h_mm: z.number().nullable(),
        measured_at: iso.nullable(),
      })
      .strict()
      .nullable(),
    text_history: TextHistory,
    photos: z.array(Photo),
    audios: z.array(Audio),
    todos: z.array(Todo),
    tags: z.array(z.string()),
    created_at: iso,
    updated_at: iso,
    version: z.number().int(),
  })
  .strict();

export const Report = z
  .object({
    id,
    title: z.string(),
    type: z.enum(['continuous', 'one_off']),
    status: z.enum(['in_progress', 'finished']),
    finished_at: iso.nullable(),
    finished_by: z.enum(['user', 'period']).nullable(),
    subject: z.object({ id, name: z.string(), color }).strict(),
    period_id: id,
    area: z
      .object({
        crop: nullableText,
        place: nullableText,
        length_m: z.number().nullable(),
        width_m: z.number().nullable(),
        area_m2: z.number().nullable(),
      })
      .strict()
      .nullable(),
    delivery_date: date.nullable(),
    delivery_reminder: reminder,
    delivery_format: deliveryFormat.nullable(),
    delivery_event_id: id.nullable(),
    cover_photo: z.object({ id, thumbnail_url: z.string() }).strict().nullable(),
    area_photo_id: id.nullable(),
    chosen_cover_photo_id: id.nullable(),
    notes: nullableText,
    tags: z.array(z.string()),
    totals: z.object({ entries: z.number().int() }).strict(),
    last_entry_at: iso.nullable(),
    created_at: iso,
    updated_at: iso,
    version: z.number().int(),
  })
  .strict();

export const ReportDetail = Report.extend({
  current_situation: z
    .object({
      crop_condition: z.enum(['excellent', 'good', 'fair', 'poor']).nullable(),
      stage: nullableText,
      irrigation: z.enum(['working', 'faulty', 'none', 'to_install']).nullable(),
      pest: z
        .object({ name: z.string(), level: z.enum(['low', 'medium', 'high']).nullable() })
        .strict()
        .nullable(),
    })
    .strict()
    .nullable(),
  open_todos: z.array(z.object({ id, text: z.string(), entry_id: id }).strict()),
}).strict();

export const SubjectDetail = Subject.extend({
  upcoming_events: z.array(z.object({ id, type: eventType, title: z.string(), date }).strict()),
  reports: z.array(
    z.object({ id, title: z.string(), type: z.enum(['continuous', 'one_off']), status: z.enum(['in_progress', 'finished']) }).strict(),
  ),
  notes: z.array(z.object({ id, title: z.string(), pinned: z.boolean() }).strict()),
}).strict();

export const Attachment = z
  .object({
    id,
    note_id: id,
    mime_type: z.string(),
    size_bytes: z.number().int(),
    url: z.string(),
    thumbnail_url: z.string().nullable(),
    created_at: iso,
  })
  .strict();

const noteBase = {
  id,
  title: z.string(),
  excerpt: nullableText,
  subject: z.object({ id, name: z.string(), color }).strict().nullable(),
  period_id: id.nullable(),
  tags: z.array(z.string()),
  pinned: z.boolean(),
  link: nullableText,
  updated_at: iso,
};
export const NoteItem = z.object(noteBase).strict();
export const Note = z
  .object({
    ...noteBase,
    text: nullableText,
    attachments: z.array(Attachment),
    audios: z.array(Audio),
    text_history: TextHistory,
    created_at: iso,
    version: z.number().int(),
  })
  .strict();

export const Notification = z
  .object({
    id,
    type: z.enum(['event_reminder', 'field_class_reminder', 'delivery_reminder', 'post_field_record_reminder']),
    title: z.string(),
    text: nullableText,
    reference: z
      .object({ type: z.enum(['event', 'report', 'subject']), id })
      .strict()
      .nullable(),
    scheduled_for: iso,
    delivered_at: iso.nullable(),
    read_at: iso.nullable(),
    created_at: iso,
  })
  .strict();

export const Device = z
  .object({
    id,
    name: nullableText,
    platform: z.enum(['android', 'ios', 'web']),
    active: z.boolean(),
    last_seen_at: iso.nullable(),
    created_at: iso,
  })
  .strict();

export const PhotoItems = z.object({ items: z.array(Photo) }).strict();

export const Health = z.object({ status: z.literal('ok'), version: z.string(), server_time: iso }).strict();

// Names in the OpenAPI document: the generated types of the phone and the site use them.
for (const [name, schema] of Object.entries({
  Error: ErrorBody,
  User,
  AuthResult,
  TokenPair,
  Period,
  PeriodDetail,
  ClosingPreview,
  Teacher,
  Subject,
  SubjectDetail,
  WeeklyBoard,
  Event,
  EventDetail,
  Photo,
  Audio,
  Todo,
  Entry,
  Report,
  ReportDetail,
  Attachment,
  Note,
  NoteItem,
  Notification,
  Device,
  Health,
})) {
  z.globalRegistry.add(schema, { id: name });
}
