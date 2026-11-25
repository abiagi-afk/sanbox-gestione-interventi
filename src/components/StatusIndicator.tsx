import React from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  PlayCircle,
  XCircle,
} from 'lucide-react';
import { AssignmentStatus, TaskStatus } from '../types/domain';

interface StatusIndicatorProps {
  status: TaskStatus | AssignmentStatus;
  inheritColor?: boolean;
}

export const StatusIndicator: React.FC<StatusIndicatorProps> = ({
  status,
  inheritColor = false,
}) => {
  switch (status) {
    case 'Completato':
      return (
        <span
          className={`inline-flex items-center gap-2 text-xs font-semibold whitespace-nowrap ${inheritColor ? 'text-current' : 'text-slate-900'
            }`}
        >
          <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
          <span>Completato</span>
        </span>
      );
    case 'Preso in Carico':
      return (
        <span
          className={`inline-flex items-center gap-2 text-xs font-semibold whitespace-nowrap ${inheritColor ? 'text-current' : 'text-slate-800'
            }`}
        >
          <PlayCircle className="w-3.5 h-3.5 shrink-0" />
          <span>Preso in Carico</span>
        </span>
      );
    case 'Assegnato':
      return (
        <span
          className={`inline-flex items-center gap-2 text-xs font-semibold whitespace-nowrap ${inheritColor ? 'text-current' : 'text-slate-600'
            }`}
        >
          <Clock className="w-3.5 h-3.5 shrink-0" />
          <span>Assegnato</span>
        </span>
      );
    case 'Non Assegnato':
      return (
        <span
          className={`inline-flex items-center gap-2 text-xs font-semibold whitespace-nowrap ${inheritColor ? 'text-current' : 'text-slate-500'
            }`}
        >
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span>Non Assegnato</span>
        </span>
      );
    case 'Annullato':
      return (
        <span
          className={`inline-flex items-center gap-2 text-xs font-normal whitespace-nowrap ${inheritColor ? 'text-current opacity-80' : 'text-slate-400'
            }`}
        >
          <XCircle className="w-3.5 h-3.5 shrink-0" />
          <span>Annullato</span>
        </span>
      );
  }
};
