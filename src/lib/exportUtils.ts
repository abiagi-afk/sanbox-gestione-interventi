import { Article, Assignment, Task, UsedMaterial } from '../types/domain';

function escapeCsvCell(value: string | number | boolean | null | undefined): string {
  const raw = value === null || value === undefined ? '' : String(value);
  if (raw.includes(';') || raw.includes('"') || raw.includes('\n') || raw.includes('\r')) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

function downloadBlob(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function formatDateTimeIt(isoOrMs: string | number): string {
  const d = typeof isoOrMs === 'number' ? new Date(isoOrMs) : new Date(isoOrMs);
  if (Number.isNaN(d.getTime())) return String(isoOrMs);
  return new Intl.DateTimeFormat('it-IT', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

export function formatDateIt(isoOrMs: string | number): string {
  const d = typeof isoOrMs === 'number' ? new Date(isoOrMs) : new Date(isoOrMs);
  if (Number.isNaN(d.getTime())) return String(isoOrMs);
  return new Intl.DateTimeFormat('it-IT', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(d);
}

export function formatTimeIt(isoOrMs: string | number): string {
  const d = typeof isoOrMs === 'number' ? new Date(isoOrMs) : new Date(isoOrMs);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('it-IT', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

/**
 * Formats a full technician name as "Nome C." (e.g. "Marco Rossi" -> "Marco R.", "Gianluca De Santis" -> "Gianluca D.S.")
 */
export function formatShortTechName(fullName: string): string {
  const clean = fullName.trim();
  if (!clean) return '';
  if (clean.includes('@')) {
    return clean.split('@')[0];
  }
  const parts = clean.split(/\s+/).filter(Boolean);
  if (parts.length === 1) {
    return parts[0];
  }
  const firstName = parts[0];
  const surnameInitials = parts
    .slice(1)
    .map((p) => {
      const ch = p.replace(/[^a-zA-ZÀ-ÿ]/g, '').charAt(0);
      return ch ? `${ch.toUpperCase()}.` : '';
    })
    .filter(Boolean)
    .join('');

  return surnameInitials ? `${firstName} ${surnameInitials}` : firstName;
}

/**
 * Concatenates all assigned technicians in "Nome C. & Nome C." format
 */
export function formatSquadShortNames(
  names: string[],
  fallbackEmpty = 'Da assegnare'
): string {
  const formatted = Array.from(
    new Set(names.map(formatShortTechName).filter(Boolean))
  );
  return formatted.length > 0 ? formatted.join(' & ') : fallbackEmpty;
}

export function formatCompactTechNames(names: string[]): string {
  return formatSquadShortNames(names, '');
}

/**
 * Builds the full un-truncated calendar event title:
 * "Marco R. & Luca B. - Descrizione attività" (or "Marco R. - Descrizione attività")
 */
export function formatCalendarEventTitle(
  names: string[],
  descrizione: string,
  fallbackEmpty = 'Da assegnare'
): string {
  const squad = formatSquadShortNames(names, fallbackEmpty);
  const cleanDesc = descrizione.trim();
  return cleanDesc ? `${squad} - ${cleanDesc}` : squad;
}


/**
 * Exports Used Materials report as Italian Excel-compatible CSV (UTF-8 BOM + semicolon delimiter)
 */
export function exportUsedMaterialsCsv(
  materials: UsedMaterial[],
  tasksById: Map<string, Task>,
  filenamePrefix = 'Consuntivo_Materiali_SITE'
): void {
  const headers = [
    'Codice Task',
    'Commessa',
    'Data Intervento',
    'Descrizione Lavoro',
    'Tecnico',
    'Email Tecnico',
    'Categoria',
    'Cod. Articolo',
    'Descrizione Articolo',
    'Quantità',
    'U.M.',
  ];

  const rows = materials.map((m) => {
    const task = tasksById.get(m.taskId);
    const commessaLabel =
      m.commessa ||
      (task?.altroReparto
        ? 'Altro AT'
        : task?.pendingAdminReview
        ? 'Da revisionare'
        : '');
    return [
      task?.taskCode || m.taskId,
      commessaLabel,
      task ? formatDateTimeIt(task.inizioMs) : '',
      task?.descrizione || '',
      m.technicianName,
      m.technicianEmail,
      m.categoria,
      m.codiceArticolo,
      m.descrizioneArticolo,
      String(m.quantita).replace('.', ','),
      m.unitaMisura,
    ]
      .map(escapeCsvCell)
      .join(';');
  });

  const csv = '\uFEFF' + [headers.map(escapeCsvCell).join(';'), ...rows].join('\r\n');
  const stamp = new Date().toISOString().slice(0, 10);
  downloadBlob(csv, `${filenamePrefix}_${stamp}.csv`, 'text/csv;charset=utf-8;');
}

/**
 * Exports Excel-compatible SpreadsheetML (.xls HTML/XML table) for direct formatting in Excel
 */
export function exportUsedMaterialsExcel(
  materials: UsedMaterial[],
  tasksById: Map<string, Task>,
  filenamePrefix = 'Consuntivo_Materiali_SITE'
): void {
  const escapeHtml = (s: string) =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const rowsHtml = materials
    .map((m) => {
      const task = tasksById.get(m.taskId);
      const commessaLabel =
        m.commessa ||
        (task?.altroReparto
          ? 'Altro AT'
          : task?.pendingAdminReview
          ? 'Da revisionare'
          : '');
      return `<tr>
        <td>${escapeHtml(task?.taskCode || m.taskId)}</td>
        <td>${escapeHtml(commessaLabel)}</td>
        <td>${escapeHtml(task ? formatDateTimeIt(task.inizioMs) : '')}</td>
        <td>${escapeHtml(task?.descrizione || '')}</td>
        <td>${escapeHtml(m.technicianName)}</td>
        <td>${escapeHtml(m.categoria)}</td>
        <td>${escapeHtml(m.codiceArticolo)}</td>
        <td>${escapeHtml(m.descrizioneArticolo)}</td>
        <td style="mso-number-format:'0.##'">${m.quantita}</td>
        <td>${escapeHtml(m.unitaMisura)}</td>
      </tr>`;
    })
    .join('');

  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
  <head><meta charset="UTF-8"></head>
  <body>
    <table border="1">
      <thead>
        <tr style="background:#0F172A;color:#FFFFFF;font-weight:bold;">
          <th>Codice Task</th>
          <th>Commessa</th>
          <th>Data Intervento</th>
          <th>Descrizione Lavoro</th>
          <th>Tecnico</th>
          <th>Categoria</th>
          <th>Cod. Articolo</th>
          <th>Descrizione Articolo</th>
          <th>Quantità</th>
          <th>U.M.</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>
  </body></html>`;

  const stamp = new Date().toISOString().slice(0, 10);
  downloadBlob(html, `${filenamePrefix}_${stamp}.xls`, 'application/vnd.ms-excel;charset=utf-8;');
}

export function exportTasksSummaryCsv(
  tasks: Task[],
  assignmentsByTask: Map<string, Assignment[]>,
  materialsByTask: Map<string, UsedMaterial[]>
): void {
  const headers = [
    'Codice Task',
    'Commessa',
    'Inizio',
    'Fine',
    'Stato Prevalente',
    'Squadra Tecnici',
    'Descrizione Lavoro',
    'Note Tecnici',
    'Riepilogo Materiali Utilizzati',
  ];

  const rows = tasks.map((t) => {
    const asgs = assignmentsByTask.get(t.taskId) || [];
    const mats = materialsByTask.get(t.taskId) || [];
    const notes = asgs
      .filter((a) => a.noteTecnico.trim())
      .map((a) => `${a.technicianName}: ${a.noteTecnico.trim()}`)
      .join(' | ');
    const matSummary = mats
      .map((m) => `${m.quantita} ${m.unitaMisura} x ${m.codiceArticolo} (${m.descrizioneArticolo})`)
      .join(' | ');

    const commessaLabel =
      t.commessa ||
      (t.altroReparto
        ? 'Altro AT'
        : t.pendingAdminReview
        ? 'Da revisionare'
        : '');

    return [
      t.taskCode,
      commessaLabel,
      formatDateTimeIt(t.inizioMs),
      formatDateTimeIt(t.fineMs),
      t.statoPrevalente,
      t.assignedNames.join(', '),
      t.descrizione,
      notes,
      matSummary,
    ]
      .map(escapeCsvCell)
      .join(';');
  });

  const csv = '\uFEFF' + [headers.map(escapeCsvCell).join(';'), ...rows].join('\r\n');
  const stamp = new Date().toISOString().slice(0, 10);
  downloadBlob(csv, `Riepilogo_Interventi_SITE_${stamp}.csv`, 'text/csv;charset=utf-8;');
}

export function exportArticlesCsv(articles: Article[]): void {
  const headers = ['Cod. Articolo', 'Descrizione', 'Categoria', 'U.M.', 'Stato'];
  const rows = articles.map((a) =>
    [
      a.codiceArticolo,
      a.descrizione,
      a.categoria,
      a.unitaMisura,
      a.active ? 'Attivo' : 'Archiviato',
    ]
      .map(escapeCsvCell)
      .join(';')
  );
  const csv = '\uFEFF' + [headers.map(escapeCsvCell).join(';'), ...rows].join('\r\n');
  const stamp = new Date().toISOString().slice(0, 10);
  downloadBlob(csv, `Catalogo_Articoli_SITE_${stamp}.csv`, 'text/csv;charset=utf-8;');
}
