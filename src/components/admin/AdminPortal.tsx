import React, { useEffect, useState } from 'react';
import {
  CalendarRange,
  ClipboardList,
  Layers,
  LogOut,
  Monitor,
  PanelLeftClose,
  PanelLeftOpen,
  PhoneCall,
  Users,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { PWAInstallButton } from '../PWAInstallButton';
import { AdminNotificationControl } from '../AdminNotificationControl';
import {
  EmailDraftConfig,
  EmailNotificationModal,
} from '../EmailNotificationModal';
import { AdminCalendarTasksView } from './AdminCalendarTasksView';
import { AdminMaterialsReportView } from './AdminMaterialsReportView';
import { AdminArticlesView } from './AdminArticlesView';
import { AdminTeamSettingsView } from './AdminTeamSettingsView';
import { MobileAdminPortal } from '../mobile/MobileAdminPortal';
import { OnCallCalendarView } from '../OnCallCalendarView';

type AdminSection = 'calendar' | 'on_call' | 'materials' | 'articles' | 'team';

const SIDEBAR_STORAGE_KEY = 'site_admin_sidebar_expanded';

export const AdminPortal: React.FC = () => {
  const {
    profile,
    pendingReviewTasksCount,
    pendingOpenTaskId,
    setViewMode,
    signOutUser,
  } = useApp();

  const [isMobileViewport, setIsMobileViewport] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.innerWidth < 1024 : false
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(max-width: 1023px)');
    const updateViewport = () => setIsMobileViewport(mq.matches);
    updateViewport();
    mq.addEventListener('change', updateViewport);
    return () => mq.removeEventListener('change', updateViewport);
  }, []);

  const [section, setSection] = useState<AdminSection>('calendar');
  const [emailDraft, setEmailDraft] = useState<EmailDraftConfig | null>(null);
  const [sidebarExpanded, setSidebarExpanded] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SIDEBAR_STORAGE_KEY) !== 'false';
    } catch {
      return true;
    }
  });

  useEffect(() => {
    if (pendingOpenTaskId && section !== 'calendar') {
      setSection('calendar');
    }
  }, [pendingOpenTaskId, section]);

  if (isMobileViewport) {
    return <MobileAdminPortal />;
  }

  const toggleSidebar = () => {
    setSidebarExpanded((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SIDEBAR_STORAGE_KEY, String(next));
      } catch {
        // Ignore storage restrictions
      }
      return next;
    });
  };

  const navItems: {
    id: AdminSection;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
  }[] = [
      {
        id: 'calendar',
        label:
          pendingReviewTasksCount > 0
            ? `Calendario e Task · ${pendingReviewTasksCount}`
            : 'Calendario e Task',
        icon: CalendarRange,
      },
      { id: 'on_call', label: 'Reperibilità', icon: PhoneCall },
      { id: 'materials', label: 'Consuntivo Materiali', icon: ClipboardList },
      { id: 'articles', label: 'Catalogo Articoli', icon: Layers },
      { id: 'team', label: 'Tecnici e Impostazioni', icon: Users },
    ];

  const sectionTitles: Record<AdminSection, string> = {
    calendar: 'Pianificazione Interventi e Squadre',
    materials: 'Consuntivo Materiali',
    on_call: 'Calendario Reperibilità e Sostituzioni',
    articles: 'Catalogo Articoli',
    team: 'Organico Tecnici e Impostazioni',
  };

  const initials =
    `${profile?.nome?.charAt(0) || ''}${profile?.cognome?.charAt(0) || ''
      }`.toUpperCase() || 'AD';

  return (
    <div className="h-screen overflow-hidden bg-slate-50 flex">
      <aside
        className={`hidden lg:flex lg:flex-col lg:fixed lg:inset-y-0 bg-white border-r border-slate-200 z-30 ${sidebarExpanded ? 'lg:w-[248px]' : 'lg:w-[64px]'
          }`}
      >
        <div
          className={`h-12 border-b border-slate-200 flex items-center shrink-0 ${sidebarExpanded ? 'px-4 justify-between gap-2' : 'justify-center px-2'
            }`}
        >
          {sidebarExpanded && (
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-8 h-8 rounded-lg bg-slate-900 flex items-center justify-center shrink-0">
                <div className="grid grid-cols-2 gap-0 w-3 h-3">
                  <span className="bg-slate-400" />
                  <span className="bg-white" />
                  <span className="bg-white" />
                  <span className="bg-slate-400" />
                </div>
              </div>
              <span className="font-display text-sm font-semibold tracking-tight text-slate-900 truncate">
                Gestione Interventi
              </span>
            </div>
          )}

          <button
            type="button"
            onClick={toggleSidebar}
            className="w-8 h-8 flex items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 hover:border-slate-400 transition-colors cursor-pointer shrink-0"
            title={
              sidebarExpanded
                ? 'Riduci menu laterale'
                : 'Espandi menu laterale'
            }
            aria-label={
              sidebarExpanded
                ? 'Riduci menu laterale'
                : 'Espandi menu laterale'
            }
          >
            {sidebarExpanded ? (
              <PanelLeftClose className="w-4 h-4" />
            ) : (
              <PanelLeftOpen className="w-4 h-4" />
            )}
          </button>
        </div>

        <nav
          className={`flex-1 py-4 space-y-2 overflow-y-auto ${sidebarExpanded ? 'px-4' : 'px-2'
            }`}
        >
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = section === item.id;
            return (
              <div key={item.id} className="relative group">
                <button
                  type="button"
                  onClick={() => setSection(item.id)}
                  className={`w-full flex items-center min-h-[40px] rounded-lg text-xs font-semibold border transition-colors cursor-pointer ${sidebarExpanded
                      ? 'gap-2 px-4 py-2'
                      : 'justify-center px-0 py-2'
                    } ${active
                      ? 'bg-slate-900 text-white border-slate-950 hover:bg-slate-800'
                      : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50 hover:border-slate-400'
                    }`}
                  aria-label={item.label}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  {sidebarExpanded && (
                    <span className="truncate whitespace-nowrap">
                      {item.label}
                    </span>
                  )}
                </button>

                {!sidebarExpanded && (
                  <div className="pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity duration-150 absolute left-full top-1/2 -translate-y-1/2 ml-2 px-2 py-2 rounded-lg bg-slate-900 border border-slate-800 text-white text-xs font-normal whitespace-nowrap z-50">
                    {item.label}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        <div
          className={`border-t border-slate-200 shrink-0 ${sidebarExpanded ? 'p-4 space-y-2' : 'p-2 space-y-2'
            }`}
        >
          <div className="relative group">
            <button
              type="button"
              onClick={() => setViewMode('mobile')}
              className={`w-full flex items-center justify-center gap-2 min-h-[40px] rounded-lg border border-slate-300 bg-white hover:bg-slate-50 hover:border-slate-400 text-xs font-semibold text-slate-800 transition-colors cursor-pointer ${sidebarExpanded ? 'px-4 py-2' : 'px-0 py-2'
                }`}
              aria-label="Vista Tecnico"
            >
              <Monitor className="w-4 h-4 shrink-0" />
              {sidebarExpanded && (
                <span className="truncate whitespace-nowrap">
                  Vista Tecnico
                </span>
              )}
            </button>

            {!sidebarExpanded && (
              <div className="pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity duration-150 absolute left-full top-1/2 -translate-y-1/2 ml-2 px-2 py-2 rounded-lg bg-slate-900 border border-slate-800 text-white text-xs font-normal whitespace-nowrap z-50">
                Vista Tecnico
              </div>
            )}
          </div>

          {sidebarExpanded ? (
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-xs font-semibold text-slate-900 truncate">
                  {profile?.nome} {profile?.cognome}
                </p>
                <p className="text-[11px] text-slate-500 font-mono truncate">
                  {profile?.email}
                </p>
              </div>
              <button
                type="button"
                onClick={signOutUser}
                className="w-10 h-10 flex items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 hover:border-slate-400 transition-colors cursor-pointer shrink-0"
                title="Esci"
                aria-label="Esci"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2">
              <div
                className="w-8 h-8 rounded-lg bg-slate-100 border border-slate-300 flex items-center justify-center text-[11px] font-semibold text-slate-700 select-none"
                title={`${profile?.nome || ''} ${profile?.cognome || ''} (${profile?.email || ''
                  })`}
              >
                {initials}
              </div>
              <div className="relative group w-full">
                <button
                  type="button"
                  onClick={signOutUser}
                  className="w-full min-h-[36px] flex items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 hover:border-slate-400 transition-colors cursor-pointer"
                  aria-label="Esci"
                >
                  <LogOut className="w-4 h-4" />
                </button>
                <div className="pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity duration-150 absolute left-full top-1/2 -translate-y-1/2 ml-2 px-2 py-2 rounded-lg bg-slate-900 border border-slate-800 text-white text-xs font-normal whitespace-nowrap z-50">
                  Esci ({profile?.email})
                </div>
              </div>
            </div>
          )}
        </div>
      </aside>

      <div
        className={`flex-1 h-screen overflow-hidden flex flex-col min-w-0 ${sidebarExpanded ? 'lg:pl-[248px]' : 'lg:pl-[64px]'
          }`}
      >
        <header className="h-12 shrink-0 bg-white border-b border-slate-200 px-6 flex items-center justify-between gap-8 z-20">
          <div className="flex items-center gap-2 text-sm min-w-0">
            <span className="text-slate-500 whitespace-nowrap">
              Portale Admin
            </span>
            <span className="text-slate-300" aria-hidden="true">
              /
            </span>
            <h1 className="font-display font-semibold text-slate-900 truncate">
              {sectionTitles[section]}
            </h1>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <AdminNotificationControl variant="header" />
            <PWAInstallButton compact />
          </div>
        </header>

        <main
          className={
            section === 'calendar'
              ? 'flex-1 min-h-0 overflow-hidden p-4 w-full'
              : 'flex-1 min-h-0 overflow-y-auto p-6 max-w-[1680px] w-full mx-auto'
          }
        >
          {section === 'calendar' && (
            <AdminCalendarTasksView onOpenEmailModal={setEmailDraft} />
          )}
          {section === 'on_call' && <OnCallCalendarView />}
          {section === 'materials' && (
            <AdminMaterialsReportView onOpenEmailModal={setEmailDraft} />
          )}
          {section === 'articles' && <AdminArticlesView />}
          {section === 'team' && (
            <AdminTeamSettingsView onOpenEmailModal={setEmailDraft} />
          )}
        </main>
      </div>

      <EmailNotificationModal
        draft={emailDraft}
        onClose={() => setEmailDraft(null)}
      />
    </div>
  );
};
