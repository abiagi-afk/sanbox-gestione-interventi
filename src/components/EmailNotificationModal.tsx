import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Mail, Send, X } from 'lucide-react';
import {
  formatEmailChannelLabel,
  sendServerSmtpEmail,
  SmtpNotConfiguredError,
  UnconfiguredIdTechInfo,
} from '../lib/workspaceApi';
import { isLoginOnlyIdEmail, VALIDATION_LIMITS } from '../types/domain';
import { useApp } from '../context/AppContext';

export interface EmailDraftConfig {
  to: string;
  cc?: string;
  requiredCcCount?: number;
  unconfiguredIdMembers?: UnconfiguredIdTechInfo[];
  subject: string;
  bodyText: string;
  contextTitle: string;
  replyTo?: string;
  senderDisplayName?: string;
  modalTitle?: string;
  bannerText?: string;
  submitLabel?: string;
  onBeforeSend?: () => Promise<void>;
  onSentSuccess?: () => void;
}

interface EmailNotificationModalProps {
  draft: EmailDraftConfig | null;
  onClose: () => void;
}

function parseEmailList(raw: string): string[] {
  return raw
    .split(/[,;]+/)
    .map((addr) => addr.trim().toLowerCase())
    .filter(Boolean);
}

export const EmailNotificationModal: React.FC<EmailNotificationModalProps> = ({
  draft,
  onClose,
}) => {
  const { profile, currentUserReplyToEmail, showToast } = useApp();
  const [to, setTo] = useState('');
  const [cc, setCc] = useState('');
  const [replyTo, setReplyTo] = useState('');
  const [subject, setSubject] = useState('');
  const [bodyText, setBodyText] = useState('');
  const [sending, setSending] = useState(false);
  const beforeSendDoneRef = useRef(false);

  useEffect(() => {
    if (draft) {
      setTo(draft.to);
      setCc(draft.cc ?? '');
      const candidateReply = (draft.replyTo ?? currentUserReplyToEmail ?? '')
        .trim()
        .toLowerCase();
      setReplyTo(
        candidateReply && !isLoginOnlyIdEmail(candidateReply)
          ? candidateReply
          : ''
      );
      setSubject(draft.subject);
      setBodyText(draft.bodyText);
      beforeSendDoneRef.current = false;
    }
  }, [draft, currentUserReplyToEmail]);

  const validationState = useMemo(() => {
    if (!draft) {
      return {
        error: null as string | null,
        hasCcIssue: false,
        hasToIssue: false,
        hasReplyIssue: false,
      };
    }

    const toTokens = parseEmailList(to);
    const ccTokens = parseEmailList(cc);
    const cleanReply = replyTo.trim().toLowerCase();

    const blockedInTo = toTokens.filter((addr) => isLoginOnlyIdEmail(addr));
    const blockedInCc = ccTokens.filter((addr) => isLoginOnlyIdEmail(addr));
    const blockedRecipientSet = Array.from(
      new Set([...blockedInTo, ...blockedInCc])
    );

    if (blockedRecipientSet.length > 0) {
      const namedLabels = blockedRecipientSet.map((addr) => {
        const match = (draft.unconfiguredIdMembers || []).find(
          (m) => m.loginEmail.trim().toLowerCase() === addr
        );
        return match && match.name && match.name.toLowerCase() !== addr
          ? `${match.name} (${addr})`
          : addr;
      });

      const errorText =
        namedLabels.length === 1
          ? `Invio bloccato: il tecnico assegnato ${namedLabels[0]} ha solo l’utenza di login .id@sitespa.it senza email secondaria configurata. Sostituisci l’indirizzo con un recapito email valido oppure configuralo in Organico.`
          : `Invio bloccato: i seguenti tecnici assegnati hanno solo l’utenza di login .id@sitespa.it senza email secondaria configurata: ${namedLabels.join(', ')}. Sostituisci gli indirizzi .id@sitespa.it con recapiti email validi oppure configurali in Organico.`;

      return {
        error: errorText,
        hasCcIssue: blockedInCc.length > 0,
        hasToIssue: blockedInTo.length > 0,
        hasReplyIssue: false,
      };
    }

    if (cleanReply && isLoginOnlyIdEmail(cleanReply)) {
      return {
        error: `L’indirizzo inserito in Rispondi a (${cleanReply}) è un account di solo accesso (.id@sitespa.it). Inserisci una casella email reale oppure lascia il campo vuoto.`,
        hasCcIssue: false,
        hasToIssue: false,
        hasReplyIssue: true,
      };
    }

    if (toTokens.length === 0) {
      return {
        error:
          'Inserisci almeno un destinatario principale (Admin) nel campo A:.',
        hasCcIssue: false,
        hasToIssue: true,
        hasReplyIssue: false,
      };
    }

    const invalidTo = toTokens.find(
      (addr) => !VALIDATION_LIMITS.EMAIL_PATTERN.test(addr)
    );
    if (invalidTo) {
      return {
        error: `Indirizzo email non valido nei destinatari principali (A:): "${invalidTo}".`,
        hasCcIssue: false,
        hasToIssue: true,
        hasReplyIssue: false,
      };
    }

    const invalidCc = ccTokens.find(
      (addr) => !VALIDATION_LIMITS.EMAIL_PATTERN.test(addr)
    );
    if (invalidCc) {
      return {
        error: `Indirizzo email non valido in Copia Conoscenza (CC:): "${invalidCc}".`,
        hasCcIssue: true,
        hasToIssue: false,
        hasReplyIssue: false,
      };
    }

    if (cleanReply && !VALIDATION_LIMITS.EMAIL_PATTERN.test(cleanReply)) {
      return {
        error: `Indirizzo email non valido in Rispondi a: "${cleanReply}".`,
        hasCcIssue: false,
        hasToIssue: false,
        hasReplyIssue: true,
      };
    }

    const requiredCc = draft.requiredCcCount ?? 0;
    const uniqueCc = Array.from(new Set(ccTokens));
    if (requiredCc > 0 && uniqueCc.length < requiredCc) {
      return {
        error: `Il task ha ${requiredCc} ${requiredCc === 1 ? 'tecnico assegnato' : 'tecnici assegnati'
          } in squadra: inserisci un recapito email valido per ciascun tecnico in Copia Conoscenza (CC:).`,
        hasCcIssue: true,
        hasToIssue: false,
        hasReplyIssue: false,
      };
    }

    return {
      error: null,
      hasCcIssue: false,
      hasToIssue: false,
      hasReplyIssue: false,
    };
  }, [draft, to, cc, replyTo]);

  if (!draft) return null;

  const handleSendConfirmed = async (e: React.FormEvent) => {
    e.preventDefault();
    if (validationState.error) {
      showToast(validationState.error, 'error');
      return;
    }

    setSending(true);
    try {
      if (draft.onBeforeSend && !beforeSendDoneRef.current) {
        await draft.onBeforeSend();
        beforeSendDoneRef.current = true;
      }

      const fallbackSenderName =
        `${profile?.nome || ''} ${profile?.cognome || ''}`.trim() ||
        profile?.email ||
        'Operatore SITE';

      const sendResult = await sendServerSmtpEmail({
        to,
        cc,
        subject,
        bodyText,
        senderDisplayName: draft.senderDisplayName || fallbackSenderName,
        replyTo: replyTo.trim() || undefined,
      });

      const hasCcRecipients = parseEmailList(cc).length > 0;
      draft.onSentSuccess?.();

      if (sendResult.queued) {
        showToast(
          draft.onBeforeSend
            ? 'Intervento completato. Riepilogo salvato nella coda protetta SITE per il recapito ad Admin e tecnici in CC.'
            : 'Email salvata nella coda protetta SITE per l’invio automatico.',
          'info',
          { durationMs: 6500 }
        );
        onClose();
        return;
      }

      const channelLabel = formatEmailChannelLabel(sendResult.channel);
      showToast(
        draft.onBeforeSend
          ? hasCcRecipients
            ? `Intervento completato e riepilogo inviato (${channelLabel}) con tecnici in CC.`
            : `Intervento completato e riepilogo inviato (${channelLabel}).`
          : hasCcRecipients
            ? `Email operativa inviata (${channelLabel}) con squadra tecnici in CC.`
            : `Email operativa inviata tramite ${channelLabel}.`,
        'success'
      );
      onClose();
    } catch (err) {
      if (err instanceof SmtpNotConfiguredError) {
        if (draft.onBeforeSend && beforeSendDoneRef.current) {
          draft.onSentSuccess?.();
          showToast(
            'Intervento registrato come Completato. Aggiorna SMTP_PASS nei Segreti di AI Studio per l’invio server immediato h24.',
            'info'
          );
          onClose();
          return;
        }
        showToast(err.message, 'info');
        return;
      }
      const msg =
        err instanceof Error ? err.message : 'Errore durante l’invio dell’email.';
      showToast(msg, 'error');
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 backdrop-blur-xs p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="email-modal-title"
    >
      <form
        onSubmit={handleSendConfirmed}
        className="w-full max-w-xl rounded-2xl bg-white border border-slate-200 p-6 max-h-[92vh] overflow-y-auto animate-fluid-pop shadow-xl"
      >
        <div className="flex items-start justify-between gap-4 pb-4 border-b border-slate-200">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-10 h-10 rounded-lg bg-slate-100 border border-slate-200 text-slate-800 flex items-center justify-center shrink-0">
              <Mail className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h3
                id="email-modal-title"
                className="text-base font-semibold text-slate-900 truncate"
              >
                {draft.modalTitle || 'Invia email riepilogativa'}
              </h3>
              <p className="text-xs text-slate-500 truncate">
                {draft.contextTitle}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={sending}
            className="w-10 h-10 flex items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 hover:border-slate-400 cursor-pointer shrink-0"
            aria-label="Chiudi"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="mt-4 space-y-4">
          {draft.bannerText && (
            <p className="text-xs text-slate-700 bg-slate-50 border border-slate-200 rounded-lg p-4 leading-relaxed">
              {draft.bannerText}
            </p>
          )}

          {validationState.error && (
            <div
              role="alert"
              className="rounded-xl border border-slate-400 bg-slate-50 p-4 flex items-start gap-2 text-xs text-slate-900 leading-relaxed"
            >
              <AlertTriangle className="w-4 h-4 text-slate-800 shrink-0" />
              <div className="space-y-2 min-w-0">
                <p className="font-semibold text-slate-900">
                  Recapito email mancante o non abilitato alla ricezione
                </p>
                <p className="text-slate-700">{validationState.error}</p>
              </div>
            </div>
          )}

          <div className="space-y-2">
            <label className="block text-xs font-semibold text-slate-700">
              Destinatari principali — Admin (A:)
            </label>
            <input
              type="text"
              required
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="a.biagi@sitespa.it, s.pistacchio@sitespa.it"
              className={`w-full min-h-[44px] px-4 py-2 rounded-lg border font-mono text-xs tabular-nums text-slate-900 focus:outline-none ${validationState.hasToIssue
                  ? 'border-slate-900 bg-slate-50'
                  : 'border-slate-300 bg-white focus:border-slate-900'
                }`}
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="sm:col-span-2 space-y-2">
              <label className="block text-xs font-semibold text-slate-700">
                Copia conoscenza — Squadra tecnici (CC:)
              </label>
              <input
                type="text"
                value={cc}
                onChange={(e) => setCc(e.target.value)}
                placeholder="nome.cognome@tecnicositespa.it"
                className={`w-full min-h-[44px] px-4 py-2 rounded-lg border font-mono text-xs tabular-nums text-slate-900 focus:outline-none ${validationState.hasCcIssue
                    ? 'border-slate-900 bg-slate-50'
                    : 'border-slate-300 bg-white focus:border-slate-900'
                  }`}
              />
            </div>

            <div className="space-y-2">
              <label className="block text-xs font-semibold text-slate-700">
                Rispondi a
              </label>
              <input
                type="email"
                value={replyTo}
                onChange={(e) => setReplyTo(e.target.value.toLowerCase())}
                placeholder="nome.cognome@tecnicositespa.it"
                className={`w-full min-h-[44px] px-4 py-2 rounded-lg border font-mono text-xs tabular-nums text-slate-900 focus:outline-none ${validationState.hasReplyIssue
                    ? 'border-slate-900 bg-slate-50'
                    : 'border-slate-300 bg-white focus:border-slate-900'
                  }`}
              />
            </div>
          </div>

          <div className="space-y-2">
            <label className="block text-xs font-semibold text-slate-700">
              Oggetto
            </label>
            <input
              type="text"
              required
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="w-full min-h-[44px] px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-900 focus:outline-none focus:border-slate-900"
            />
          </div>

          <div className="space-y-2">
            <label className="block text-xs font-semibold text-slate-700">
              Messaggio
            </label>
            <textarea
              rows={8}
              required
              value={bodyText}
              onChange={(e) => setBodyText(e.target.value)}
              className="w-full p-4 rounded-lg border border-slate-300 text-slate-900 font-mono text-xs leading-relaxed focus:outline-none focus:border-slate-900"
            />
          </div>
        </div>

        <div className="mt-6 flex items-center justify-end gap-2 pt-4 border-t border-slate-200">
          <button
            type="button"
            onClick={onClose}
            disabled={sending}
            className="min-h-[44px] px-4 py-2 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-800 hover:bg-slate-50 hover:border-slate-400 transition-colors cursor-pointer"
          >
            Annulla
          </button>
          <button
            type="submit"
            disabled={sending || Boolean(validationState.error)}
            className="inline-flex items-center justify-center gap-2 min-h-[44px] px-4 py-2 rounded-lg bg-slate-900 border border-slate-950 text-xs font-semibold text-white hover:bg-slate-800 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Send className="w-3.5 h-3.5" />
            <span>
              {sending
                ? 'Invio in corso...'
                : draft.submitLabel || 'Conferma e invia email'}
            </span>
          </button>
        </div>
      </form>
    </div>
  );
};
