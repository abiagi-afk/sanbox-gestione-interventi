import React from 'react';
import { Check } from 'lucide-react';
import {
  TASK_COLOR_IDS,
  TaskColorId,
} from '../types/domain';
import {
  getOperatorColorLabel,
  TASK_COLOR_PALETTE,
} from '../lib/calendarLayout';

interface TaskColorPickerProps {
  value: TaskColorId;
  onChange: (colorId: TaskColorId) => void;
  operatorColorLabels?: Partial<Record<TaskColorId, string>> | null;
  compact?: boolean;
  disabled?: boolean;
}

export const TaskColorPicker: React.FC<TaskColorPickerProps> = ({
  value,
  onChange,
  operatorColorLabels,
  compact = false,
  disabled = false,
}) => {
  if (compact) {
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="font-semibold text-slate-700">
            Colore operatore
          </span>
          <span className="font-normal text-slate-900 truncate">
            {getOperatorColorLabel(value, operatorColorLabels)} ·{' '}
            <span className="text-slate-500">
              {TASK_COLOR_PALETTE[value].colorNameIt}
            </span>
          </span>
        </div>
        <div
          className="flex flex-wrap items-center gap-2"
          role="radiogroup"
          aria-label="Seleziona colore operatore evento"
        >
          {TASK_COLOR_IDS.map((colorId) => {
            const entry = TASK_COLOR_PALETTE[colorId];
            const label = getOperatorColorLabel(colorId, operatorColorLabels);
            const selected = value === colorId;
            return (
              <button
                key={colorId}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={disabled}
                onClick={() => onChange(colorId)}
                title={`${label} (${entry.colorNameIt})`}
                aria-label={`${label} (${entry.colorNameIt})`}
                className={`min-h-[32px] min-w-[32px] rounded-lg flex items-center justify-center border transition-colors cursor-pointer disabled:opacity-50 ${selected
                    ? 'border-slate-950 bg-slate-100'
                    : 'border-slate-300 bg-white hover:bg-slate-50 hover:border-slate-400'
                  }`}
              >
                <span
                  className={`w-5 h-5 rounded-full flex items-center justify-center ${entry.themeClass} gcal-swatch-fill`}
                >
                  {selected && (
                    <Check
                      className={`w-3 h-3 stroke-[3] ${entry.filledUsesLightText
                          ? 'text-white'
                          : 'text-slate-900'
                        }`}
                    />
                  )}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div
      className="grid grid-cols-2 sm:grid-cols-3 gap-2"
      role="radiogroup"
      aria-label="Seleziona colore operatore evento"
    >
      {TASK_COLOR_IDS.map((colorId) => {
        const entry = TASK_COLOR_PALETTE[colorId];
        const label = getOperatorColorLabel(colorId, operatorColorLabels);
        const selected = value === colorId;
        return (
          <button
            key={colorId}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onChange(colorId)}
            title={`${label} — ${entry.colorNameIt}`}
            className={`min-h-[40px] px-4 py-2 rounded-lg border text-left flex items-center gap-2 transition-colors cursor-pointer disabled:opacity-50 ${selected
                ? 'border-slate-950 bg-slate-900 text-white'
                : 'border-slate-300 bg-white text-slate-800 hover:bg-slate-50 hover:border-slate-400'
              }`}
          >
            <span
              className={`w-4 h-4 rounded-full shrink-0 flex items-center justify-center ${entry.themeClass} gcal-swatch-fill`}
            >
              {selected && (
                <Check
                  className={`w-2.5 h-2.5 stroke-[3] ${entry.filledUsesLightText ? 'text-white' : 'text-slate-900'
                    }`}
                />
              )}
            </span>
            <span className="text-xs font-semibold truncate flex-1">
              {label}
            </span>
          </button>
        );
      })}
    </div>
  );
};
