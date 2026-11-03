import type { RowDataPacket } from 'mysql2/promise';

// DATETIME(3) arrives as 'YYYY-MM-DD HH:MM:SS.mmm' (UTC); the API speaks ISO 8601 with Z.
export function isoDate(value: string | null): string | null {
  return value ? new Date(`${value.replace(' ', 'T')}Z`).toISOString() : null;
}

const THEME_OUT: Record<string, string> = { claro: 'light', escuro: 'dark', sistema: 'system' };
export const THEME_IN: Record<string, string> = { light: 'claro', dark: 'escuro', system: 'sistema' };

export const USER_COLUMNS =
  'id, nome, email, senha_hash, curso, instituicao, fuso_horario, tema, cidade_cotacoes, latitude_padrao, longitude_padrao, ' +
  'lembrar_registro_pos_campo, hora_lembrete_pos_campo, apagar_audio_apos_transcricao, enviar_fotos_so_wifi, ' +
  'aviso_provas_entregas, aviso_vespera_campo, aviso_entrega_relatorio, ' +
  'primeiro_acesso_concluido_em, criado_em, atualizado_em, versao';

/** Public shape of a user (docs/api.md): English snake_case, never the password hash. */
export function serializeUser(r: RowDataPacket) {
  return {
    id: r.id as string,
    name: r.nome as string,
    email: r.email as string,
    course: (r.curso as string | null) ?? null,
    institution: (r.instituicao as string | null) ?? null,
    timezone: r.fuso_horario as string,
    theme: THEME_OUT[r.tema as string] ?? 'system',
    quotes_city: r.cidade_cotacoes as string,
    default_location:
      r.latitude_padrao == null || r.longitude_padrao == null
        ? null
        : { latitude: Number(r.latitude_padrao), longitude: Number(r.longitude_padrao) },
    notify_exams_and_deadlines: r.aviso_provas_entregas === 1,
    notify_field_class_eve: r.aviso_vespera_campo === 1,
    notify_report_deadline: r.aviso_entrega_relatorio === 1,
    remind_record_after_field: r.lembrar_registro_pos_campo === 1,
    remind_record_time: r.hora_lembrete_pos_campo as string,
    delete_audio_after_transcription: r.apagar_audio_apos_transcricao === 1,
    send_photos_on_wifi_only: r.enviar_fotos_so_wifi === 1,
    first_access_completed_at: isoDate(r.primeiro_acesso_concluido_em as string | null),
    created_at: isoDate(r.criado_em as string),
    updated_at: isoDate(r.atualizado_em as string),
    version: r.versao as number,
  };
}
